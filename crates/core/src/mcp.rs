//! MCP-over-HTTP for the thread bus. Stateless: each POST yields one SSE
//! `event: message` carrying the JSON-RPC response. Identity is derived from
//! the URL path, never agent input (see bus.rs).

use crate::bus::{BusRegistry, Msg};
use crate::store::Store;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

/// Shared server state.
#[derive(Clone)]
pub struct McpState {
    pub bus: BusRegistry,
    pub store: Store,
}

pub fn router(state: McpState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/bus/{issue}/{party}/mcp", post(mcp_post))
        .with_state(state)
}

async fn healthz() -> &'static str {
    "ok"
}

fn now_unix() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn tool_list() -> Value {
    json!({ "tools": [
        {
            "name": "bus_post",
            "description": "Post a message to another participant's inbox in this issue. `to` is \"lead\" or a direction's numeric id. Your own identity comes from the connection URL — you cannot impersonate anyone.",
            // Codex core treats annotation-less MCP tools as
            // destructive/open-world and demands an approval that
            // approvalPolicy=never auto-rejects ("user rejected MCP tool
            // call"). Declaring the hints below makes the call run
            // unconditionally (verified against codex-rs
            // requires_mcp_tool_approval, 2026-08-08).
            "annotations": {
                "readOnlyHint": false,
                "destructiveHint": false,
                "openWorldHint": false
            },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "\"lead\" or a direction id" },
                    "text": { "type": "string" }
                },
                "required": ["to", "text"]
            }
        },
        {
            "name": "bus_read",
            "description": "Drain your own inbox (oldest first). Destructive: read messages leave the live inbox (they remain in the durable audit log).",
            "annotations": {
                "readOnlyHint": true,
                "destructiveHint": false,
                "openWorldHint": false
            },
            "inputSchema": { "type": "object", "properties": {} }
        }
    ]})
}

fn text_result(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

/// Handle one JSON-RPC payload. Returns None for notifications (202 path).
/// Kept transport-free so tests don't need HTTP.
pub async fn handle_rpc(state: &McpState, issue: i64, party: &str, body: &Value) -> Option<Value> {
    let method = body.get("method").and_then(Value::as_str).unwrap_or("");
    let id = body.get("id").cloned();
    match (method, id) {
        ("initialize", Some(id)) => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "weft-codex bus", "version": env!("CARGO_PKG_VERSION") }
            }
        })),
        ("tools/list", Some(id)) => Some(json!({
            "jsonrpc": "2.0", "id": id, "result": tool_list()
        })),
        ("tools/call", Some(id)) => {
            let params = body.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            let result = call_tool(state, issue, party, name, &args).await;
            Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
        }
        // Notifications (initialized, cancelled, …) need no response.
        (_, None) => None,
        (_, Some(id)) => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("unknown method: {method}") }
        })),
    }
}

async fn call_tool(state: &McpState, issue: i64, party: &str, name: &str, args: &Value) -> Value {
    match name {
        "bus_post" => {
            let to = args.get("to").and_then(Value::as_str).unwrap_or("");
            let text = args.get("text").and_then(Value::as_str).unwrap_or("");
            if to.is_empty() || text.is_empty() {
                return text_result("error: `to` and `text` are required".into());
            }
            if to == party {
                return text_result("error: cannot post to yourself".into());
            }
            let msg = Msg {
                from: party.to_string(),
                text: text.to_string(),
                kind: "message".to_string(),
                ts: now_unix(),
            };
            if let Err(error) = state.store.bus_append(issue, party, to, text).await {
                return text_result(format!("error: durable write failed: {error:#}"));
            }
            state.bus.post(issue, to, msg);
            text_result(format!("posted to {to}"))
        }
        "bus_read" => {
            let msgs = state.bus.drain(issue, party);
            text_result(serde_json::to_string(&msgs).unwrap_or_else(|_| "[]".into()))
        }
        other => text_result(format!("error: unknown tool: {other}")),
    }
}

async fn mcp_post(
    State(state): State<McpState>,
    Path((issue, party)): Path<(i64, String)>,
    Json(body): Json<Value>,
) -> Response {
    match handle_rpc(&state, issue, &party, &body).await {
        Some(resp) => {
            let frame = format!("event: message\ndata: {resp}\n\n");
            (
                StatusCode::OK,
                [("content-type", "text/event-stream")],
                frame,
            )
                .into_response()
        }
        None => StatusCode::ACCEPTED.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Returns the state plus the TempDir GUARD — the guard must outlive the
    /// test, otherwise the directory (and the SQLite file with it) is deleted
    /// while the pool is still using it.
    async fn fixture() -> (McpState, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tmp");
        let store = Store::open(&dir.path().join("t.db")).await.expect("open");
        let state = McpState {
            bus: BusRegistry::new(),
            store,
        };
        (state, dir)
    }

    #[tokio::test]
    async fn initialize_and_tool_flow() {
        let (st, _dir) = fixture().await;
        let init = handle_rpc(&st, 1, "lead", &json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}
        }))
        .await
        .expect("init resp");
        assert_eq!(init["result"]["serverInfo"]["name"], "weft-codex bus");

        let list = handle_rpc(&st, 1, "lead", &json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}
        }))
        .await
        .expect("list resp");
        assert_eq!(list["result"]["tools"][0]["name"], "bus_post");
        // Codex auto-rejects annotation-less MCP tools under
        // approvalPolicy=never; both hints must be explicitly false.
        assert_eq!(
            list["result"]["tools"][0]["annotations"]["destructiveHint"],
            false
        );
        assert_eq!(
            list["result"]["tools"][0]["annotations"]["openWorldHint"],
            false
        );
        assert_eq!(
            list["result"]["tools"][1]["annotations"]["readOnlyHint"],
            true
        );

        // lead posts to direction 3; identity comes from the URL (party).
        let post = handle_rpc(&st, 1, "lead", &json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "bus_post", "arguments": { "to": "3", "text": "hello" } }
        }))
        .await
        .expect("post resp");
        let posted_text = post["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_string();
        assert!(
            posted_text.contains("posted to 3"),
            "unexpected bus_post response: {posted_text}; full: {post}"
        );

        // Direction 3 reads its inbox; the durable audit log has the row too.
        let read = handle_rpc(&st, 1, "3", &json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "bus_read", "arguments": {} }
        }))
        .await
        .expect("read resp");
        let text = read["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(text.contains("hello"));
        assert!(text.contains("\"from\":\"lead\""));
        let durable = st.store.bus_inbox(1, "3").await.expect("inbox");
        assert_eq!(durable.len(), 1);
    }

    #[tokio::test]
    async fn notifications_get_no_response() {
        let (st, _dir) = fixture().await;
        let resp = handle_rpc(&st, 1, "lead", &json!({
            "jsonrpc": "2.0", "method": "notifications/initialized"
        }))
        .await;
        assert!(resp.is_none());
    }
}
