//! MCP-over-HTTP for the thread bus. Stateless: each POST yields one SSE
//! `event: message` carrying the JSON-RPC response. Identity is derived from
//! the URL path, never agent input (see bus.rs).

use crate::bus::{BusRegistry, Msg};
use crate::events;
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

fn tool_list(party: &str) -> Value {
    let mut tools = vec![
        json!({
            "name": "bus_post",
            "description": "Post a message to another participant's inbox in this issue. `to` is \"lead\" or a task's numeric id. Your own identity comes from the connection URL — you cannot impersonate anyone.",
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
                    "to": { "type": "string", "description": "\"lead\" or a task id" },
                    "text": { "type": "string" }
                },
                "required": ["to", "text"]
            }
        }),
        json!({
            "name": "bus_read",
            "description": "Drain your own inbox (oldest first). Destructive: read messages leave the live inbox (they remain in the durable audit log).",
            "annotations": {
                "readOnlyHint": true,
                "destructiveHint": false,
                "openWorldHint": false
            },
            "inputSchema": { "type": "object", "properties": {} }
        }),
    ];
    if party == "lead" {
        tools.push(json!({
            "name": "task_create",
            "description": "Create one worker task for the current issue. Lead only. Use this after decomposing the issue; the human does not create worker tasks manually.",
            "annotations": {
                "readOnlyHint": false,
                "destructiveHint": false,
                "openWorldHint": false,
                "idempotentHint": false
            },
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "name": { "type": "string", "maxLength": 120, "description": "Short user-facing task name" },
                    "repo_id": { "type": "integer", "minimum": 1, "description": "Repository id from the lead brief" },
                    "spec": { "type": "string", "maxLength": 20000, "description": "Complete implementation brief for the worker" },
                    "reason": { "type": "string", "maxLength": 2000, "description": "Why this repository must change" },
                    "mandate": { "type": "string", "enum": ["plan+impl", "impl-only"], "default": "plan+impl" },
                    "base_branch": { "type": "string", "maxLength": 255, "description": "Defaults to the repository base branch" }
                },
                "required": ["name", "repo_id", "spec"]
            }
        }));
        tools.push(json!({
            "name": "repo_list",
            "description": "List the repositories currently attached to this issue's workspace. Lead only. Refresh this after the human adds repositories.",
            "annotations": {
                "readOnlyHint": true,
                "destructiveHint": false,
                "openWorldHint": false,
                "idempotentHint": true
            },
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {}
            }
        }));
    }
    json!({ "tools": tools })
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
            "jsonrpc": "2.0", "id": id, "result": tool_list(party)
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
        "task_create" => create_task(state, issue, party, args).await,
        "repo_list" => list_repos(state, issue, party).await,
        other => text_result(format!("error: unknown tool: {other}")),
    }
}

async fn list_repos(state: &McpState, issue_id: i64, party: &str) -> Value {
    if party != "lead" {
        return text_result("error: repo_list is available only to the lead".into());
    }
    let issue = match state.store.get_issue(issue_id).await {
        Ok(Some(issue)) => issue,
        Ok(None) => return text_result(format!("error: unknown issue {issue_id}")),
        Err(error) => return text_result(format!("error: issue lookup failed: {error:#}")),
    };
    let repos = match state.store.list_repos(issue.workspace_id).await {
        Ok(repos) => repos,
        Err(error) => return text_result(format!("error: repository lookup failed: {error:#}")),
    };
    let result: Vec<Value> = repos
        .into_iter()
        .map(|repo| {
            json!({
                "repo_id": repo.id,
                "name": repo.name,
                "base_branch": repo.base_ref
            })
        })
        .collect();
    text_result(Value::Array(result).to_string())
}

fn task_slug(name: &str) -> String {
    let mut slug = String::new();
    let mut length = 0;
    let mut separator_pending = false;
    for character in name.chars().flat_map(char::to_lowercase) {
        let is_cjk = ('\u{4e00}'..='\u{9fff}').contains(&character);
        if character.is_ascii_alphanumeric() || is_cjk {
            if separator_pending && !slug.is_empty() {
                if length + 1 >= 48 {
                    break;
                }
                slug.push('-');
                length += 1;
            }
            separator_pending = false;
            if length >= 48 {
                break;
            }
            slug.push(character);
            length += 1;
        } else if !slug.is_empty() {
            separator_pending = true;
        }
    }
    if slug.is_empty() {
        "task".to_string()
    } else {
        slug
    }
}

async fn create_task(state: &McpState, issue_id: i64, party: &str, args: &Value) -> Value {
    if party != "lead" {
        return text_result("error: task_create is available only to the lead".into());
    }
    let name = args
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let spec = args
        .get("spec")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let Some(repo_id) = args.get("repo_id").and_then(Value::as_i64) else {
        return text_result("error: `repo_id` must be a positive integer".into());
    };
    if name.is_empty() || spec.is_empty() {
        return text_result("error: non-empty `name` and `spec` are required".into());
    }
    if name.chars().count() > 120 || spec.chars().count() > 20_000 {
        return text_result("error: task name or spec exceeds the allowed length".into());
    }
    if repo_id <= 0 {
        return text_result("error: `repo_id` must be a positive integer".into());
    }
    let mandate = args
        .get("mandate")
        .and_then(Value::as_str)
        .unwrap_or("plan+impl");
    if mandate != "plan+impl" && mandate != "impl-only" {
        return text_result("error: `mandate` must be plan+impl or impl-only".into());
    }
    let reason = args
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if reason.chars().count() > 2_000 {
        return text_result("error: task reason exceeds the allowed length".into());
    }

    let issue = match state.store.get_issue(issue_id).await {
        Ok(Some(issue)) => issue,
        Ok(None) => return text_result(format!("error: unknown issue {issue_id}")),
        Err(error) => return text_result(format!("error: issue lookup failed: {error:#}")),
    };
    let repo = match state.store.get_repo(repo_id).await {
        Ok(Some(repo)) => repo,
        Ok(None) => return text_result(format!("error: unknown repository {repo_id}")),
        Err(error) => return text_result(format!("error: repository lookup failed: {error:#}")),
    };
    if repo.workspace_id != issue.workspace_id {
        return text_result(format!(
            "error: repository {repo_id} is not in issue {issue_id}'s workspace"
        ));
    }
    let requested_base = args
        .get("base_branch")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let base_branch = if requested_base.is_empty() {
        repo.base_ref.as_str()
    } else {
        requested_base
    };
    let slug = task_slug(name);
    let task_id = match state
        .store
        .add_direction(
            issue_id,
            name,
            &slug,
            repo_id,
            mandate,
            base_branch,
            reason,
            spec,
        )
        .await
    {
        Ok(id) => id,
        Err(error) => return text_result(format!("error: task creation failed: {error:#}")),
    };
    events::emit(
        "direction.updated",
        json!({ "id": task_id, "issueId": issue_id, "status": "queued" }),
    );
    text_result(
        json!({
            "task_id": task_id,
            "name": name,
            "repo_id": repo_id,
            "repo": repo.name,
            "status": "queued"
        })
        .to_string(),
    )
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
        let init = handle_rpc(
            &st,
            1,
            "lead",
            &json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}
            }),
        )
        .await
        .expect("init resp");
        assert_eq!(init["result"]["serverInfo"]["name"], "weft-codex bus");

        let list = handle_rpc(
            &st,
            1,
            "lead",
            &json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}
            }),
        )
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
        assert_eq!(list["result"]["tools"][2]["name"], "task_create");
        assert_eq!(
            list["result"]["tools"][2]["annotations"]["destructiveHint"],
            false
        );
        assert_eq!(list["result"]["tools"][3]["name"], "repo_list");
        assert_eq!(
            list["result"]["tools"][3]["annotations"]["readOnlyHint"],
            true
        );

        let worker_list = handle_rpc(
            &st,
            1,
            "3",
            &json!({
                "jsonrpc": "2.0", "id": 20, "method": "tools/list", "params": {}
            }),
        )
        .await
        .expect("worker list resp");
        assert_eq!(
            worker_list["result"]["tools"].as_array().map(Vec::len),
            Some(2)
        );

        // lead posts to direction 3; identity comes from the URL (party).
        let post = handle_rpc(
            &st,
            1,
            "lead",
            &json!({
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "bus_post", "arguments": { "to": "3", "text": "hello" } }
            }),
        )
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
        let read = handle_rpc(
            &st,
            1,
            "3",
            &json!({
                "jsonrpc": "2.0", "id": 4, "method": "tools/call",
                "params": { "name": "bus_read", "arguments": {} }
            }),
        )
        .await
        .expect("read resp");
        let text = read["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(text.contains("hello"));
        assert!(text.contains("\"from\":\"lead\""));
        let durable = st.store.bus_inbox(1, "3").await.expect("inbox");
        assert_eq!(durable.len(), 1);
    }

    #[tokio::test]
    async fn task_create_is_lead_only_and_scoped_to_the_issue_workspace() {
        let (st, _dir) = fixture().await;
        let workspace = st
            .store
            .create_workspace("Product", "product")
            .await
            .expect("workspace");
        let repo = st
            .store
            .add_repo(workspace, "api", "/tmp/api", "trunk")
            .await
            .expect("repo");
        let issue = st
            .store
            .create_issue(workspace, "Fix login", "fix-login")
            .await
            .expect("issue");

        let listed = handle_rpc(
            &st,
            issue,
            "lead",
            &json!({
                "jsonrpc": "2.0", "id": 0, "method": "tools/call",
                "params": { "name": "repo_list", "arguments": {} }
            }),
        )
        .await
        .expect("repo list response");
        let listed_text = listed["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or("");
        assert!(listed_text.contains("\"repo_id\":1"));
        assert!(listed_text.contains("\"name\":\"api\""));
        assert!(listed_text.contains("\"base_branch\":\"trunk\""));

        let list_denied = handle_rpc(
            &st,
            issue,
            "7",
            &json!({
                "jsonrpc": "2.0", "id": 10, "method": "tools/call",
                "params": { "name": "repo_list", "arguments": {} }
            }),
        )
        .await
        .expect("denied repo list response");
        assert!(list_denied["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .contains("only to the lead"));

        let denied = handle_rpc(
            &st,
            issue,
            "7",
            &json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "task_create", "arguments": {
                    "name": "Backend fix", "repo_id": repo, "spec": "Repair session expiry"
                } }
            }),
        )
        .await
        .expect("denied response");
        assert!(denied["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .contains("only to the lead"));

        let created = handle_rpc(
            &st,
            issue,
            "lead",
            &json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": { "name": "task_create", "arguments": {
                    "name": "Backend fix",
                    "repo_id": repo,
                    "spec": "Repair session expiry",
                    "reason": "The session store is owned here"
                } }
            }),
        )
        .await
        .expect("create response");
        assert!(created["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .contains("\"task_id\":1"));
        let tasks = st.store.list_directions(issue).await.expect("tasks");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].name, "Backend fix");
        assert_eq!(tasks[0].spec, "Repair session expiry");
        assert_eq!(tasks[0].base_branch, "trunk");
        assert_eq!(tasks[0].status, "queued");

        let other_workspace = st
            .store
            .create_workspace("Other", "other")
            .await
            .expect("other workspace");
        let other_repo = st
            .store
            .add_repo(other_workspace, "web", "/tmp/web", "main")
            .await
            .expect("other repo");
        let rejected = handle_rpc(
            &st,
            issue,
            "lead",
            &json!({
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "task_create", "arguments": {
                    "name": "Wrong workspace", "repo_id": other_repo, "spec": "Do not create"
                } }
            }),
        )
        .await
        .expect("scope response");
        assert!(rejected["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .contains("not in issue"));
        assert_eq!(
            st.store.list_directions(issue).await.expect("tasks").len(),
            1
        );
    }

    #[test]
    fn task_slug_preserves_cjk_and_has_no_trailing_separator() {
        assert_eq!(task_slug("修复 Login 回调"), "修复-login-回调");
        assert!(!task_slug(&format!("{} end", "x".repeat(60))).ends_with('-'));
        assert!(task_slug("***").len() > 0);
    }

    #[tokio::test]
    async fn notifications_get_no_response() {
        let (st, _dir) = fixture().await;
        let resp = handle_rpc(
            &st,
            1,
            "lead",
            &json!({
                "jsonrpc": "2.0", "method": "notifications/initialized"
            }),
        )
        .await;
        assert!(resp.is_none());
    }
}
