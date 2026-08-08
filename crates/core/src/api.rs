//! HTTP API for the weft-codex kanban UI (Stage 3 consumes this). Served by
//! the same axum listener as the MCP bus; the daemon merges both routers.
//!
//! Error mapping is intentionally crude string-sniffing for now (internal
//! tool): "unknown …" → 404, "already has …" → 409, validation wording →
//! 400, everything else → 500 with the full anyhow chain in the body.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::orchestrator::Orchestrator;
use crate::store::Store;

#[derive(Clone)]
pub struct ApiState {
    pub store: Store,
    pub orch: Orchestrator,
}

pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/api/workspaces", post(create_workspace).get(list_workspaces))
        .route(
            "/api/workspaces/{id}/repos",
            post(add_repo).get(list_repos),
        )
        .route("/api/issues", post(create_issue).get(kanban))
        .route("/api/issues/{id}/directions", post(add_direction))
        .route("/api/issues/{id}/spawn-lead", post(spawn_lead))
        .route("/api/issues/{id}/message", post(message_lead))
        .route("/api/issues/{id}/bus", get(bus_log))
        .route("/api/directions/{id}/spawn", post(spawn_direction))
        .route("/api/directions/{id}/message", post(message_direction))
        .route("/api/directions/{id}/status", post(set_status))
        .route(
            "/api/directions/{id}/attention/clear",
            post(clear_attention),
        )
        .with_state(state)
}

fn fail(e: anyhow::Error) -> Response {
    let msg = format!("{e:#}");
    let status = if msg.contains("unknown") {
        StatusCode::NOT_FOUND
    } else if msg.contains("already has") || msg.contains("no Codex thread") {
        StatusCode::CONFLICT
    } else if msg.contains("invalid") || msg.contains("not in") || msg.contains("required") {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    (status, Json(json!({ "error": msg }))).into_response()
}

fn ok(value: Value) -> Response {
    Json(value).into_response()
}

/// A direction's repo must sit in the same workspace as its issue —
/// otherwise its worktree/branch would materialize against a repo the
/// workspace never registered.
async fn check_direction_repo(store: &Store, issue_id: i64, repo_id: i64) -> anyhow::Result<()> {
    let issue = store
        .get_issue(issue_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("unknown issue {issue_id}"))?;
    let repo = store
        .get_repo(repo_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("unknown repo {repo_id}"))?;
    if repo.workspace_id != issue.workspace_id {
        anyhow::bail!("repo {repo_id} is not in issue {issue_id}'s workspace");
    }
    Ok(())
}

#[derive(Deserialize)]
struct CreateWorkspace {
    name: String,
    slug: String,
}

async fn create_workspace(
    State(state): State<ApiState>,
    Json(body): Json<CreateWorkspace>,
) -> Response {
    match state.store.create_workspace(&body.name, &body.slug).await {
        Ok(id) => ok(json!({ "id": id })),
        Err(e) => fail(e),
    }
}

async fn list_workspaces(State(state): State<ApiState>) -> Response {
    match state.store.list_workspaces().await {
        Ok(rows) => ok(json!(rows)),
        Err(e) => fail(e),
    }
}

#[derive(Deserialize)]
struct AddRepo {
    name: String,
    path: String,
    base_ref: Option<String>,
}

async fn add_repo(
    State(state): State<ApiState>,
    Path(workspace_id): Path<i64>,
    Json(body): Json<AddRepo>,
) -> Response {
    let base_ref = body.base_ref.unwrap_or_default();
    match state
        .store
        .add_repo(workspace_id, &body.name, &body.path, &base_ref)
        .await
    {
        Ok(id) => ok(json!({ "id": id })),
        Err(e) => fail(e),
    }
}

async fn list_repos(State(state): State<ApiState>, Path(workspace_id): Path<i64>) -> Response {
    match state.store.list_repos(workspace_id).await {
        Ok(rows) => ok(json!(rows)),
        Err(e) => fail(e),
    }
}

#[derive(Deserialize)]
struct CreateIssue {
    workspace_id: i64,
    title: String,
    slug: String,
}

async fn create_issue(
    State(state): State<ApiState>,
    Json(body): Json<CreateIssue>,
) -> Response {
    match state
        .store
        .create_issue(body.workspace_id, &body.title, &body.slug)
        .await
    {
        Ok(id) => ok(json!({ "id": id })),
        Err(e) => fail(e),
    }
}

#[derive(Deserialize)]
struct KanbanQuery {
    workspace_id: i64,
}

/// The kanban board payload: every issue with its directions.
async fn kanban(State(state): State<ApiState>, Query(q): Query<KanbanQuery>) -> Response {
    match state.store.list_issues_with_directions(q.workspace_id).await {
        Ok(pairs) => {
            let board: Vec<Value> = pairs
                .iter()
                .map(|(issue, directions)| json!({ "issue": issue, "directions": directions }))
                .collect();
            ok(json!(board))
        }
        Err(e) => fail(e),
    }
}

#[derive(Deserialize)]
struct AddDirection {
    name: String,
    slug: String,
    repo_id: i64,
    mandate: Option<String>,
    base_branch: Option<String>,
    reason: Option<String>,
    spec: Option<String>,
}

async fn add_direction(
    State(state): State<ApiState>,
    Path(issue_id): Path<i64>,
    Json(body): Json<AddDirection>,
) -> Response {
    if let Err(e) = check_direction_repo(&state.store, issue_id, body.repo_id).await {
        return fail(e);
    }
    let mandate = body.mandate.unwrap_or_else(|| "plan+impl".to_string());
    let base_branch = body.base_branch.unwrap_or_default();
    let reason = body.reason.unwrap_or_default();
    let spec = body.spec.unwrap_or_default();
    match state
        .store
        .add_direction(
            issue_id,
            &body.name,
            &body.slug,
            body.repo_id,
            &mandate,
            &base_branch,
            &reason,
            &spec,
        )
        .await
    {
        Ok(id) => ok(json!({ "id": id })),
        Err(e) => fail(e),
    }
}

async fn spawn_lead(State(state): State<ApiState>, Path(issue_id): Path<i64>) -> Response {
    match state.orch.spawn_lead(issue_id).await {
        Ok(thread_id) => ok(json!({ "codexThreadId": thread_id })),
        Err(e) => fail(e),
    }
}

async fn spawn_direction(State(state): State<ApiState>, Path(direction_id): Path<i64>) -> Response {
    match state.orch.spawn_direction(direction_id).await {
        Ok(thread_id) => ok(json!({ "codexThreadId": thread_id })),
        Err(e) => fail(e),
    }
}

#[derive(Deserialize)]
struct Message {
    text: String,
}

async fn message_lead(
    State(state): State<ApiState>,
    Path(issue_id): Path<i64>,
    Json(body): Json<Message>,
) -> Response {
    if body.text.trim().is_empty() {
        return fail(anyhow::anyhow!("invalid empty message text"));
    }
    match state.orch.human_message_lead(issue_id, &body.text).await {
        Ok(()) => ok(json!({ "queued": true })),
        Err(e) => fail(e),
    }
}

async fn message_direction(
    State(state): State<ApiState>,
    Path(direction_id): Path<i64>,
    Json(body): Json<Message>,
) -> Response {
    if body.text.trim().is_empty() {
        return fail(anyhow::anyhow!("invalid empty message text"));
    }
    match state
        .orch
        .human_message_direction(direction_id, &body.text)
        .await
    {
        Ok(()) => ok(json!({ "queued": true })),
        Err(e) => fail(e),
    }
}

#[derive(Deserialize)]
struct SetStatus {
    status: String,
}

async fn set_status(
    State(state): State<ApiState>,
    Path(direction_id): Path<i64>,
    Json(body): Json<SetStatus>,
) -> Response {
    match state.orch.set_direction_status(direction_id, &body.status).await {
        Ok(()) => ok(json!({ "ok": true })),
        Err(e) => fail(e),
    }
}

async fn clear_attention(State(state): State<ApiState>, Path(direction_id): Path<i64>) -> Response {
    match state.orch.clear_direction_attention(direction_id).await {
        Ok(()) => ok(json!({ "ok": true })),
        Err(e) => fail(e),
    }
}

/// The issue's durable bus log (audit feed for the kanban UI).
async fn bus_log(State(state): State<ApiState>, Path(issue_id): Path<i64>) -> Response {
    match state.store.bus_log(issue_id).await {
        Ok(rows) => ok(json!(rows)),
        Err(e) => fail(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture() -> (Store, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tmp");
        let store = Store::open(&dir.path().join("t.db")).await.expect("open");
        (store, dir)
    }

    #[tokio::test]
    async fn direction_repo_must_share_the_issues_workspace() {
        let (store, _dir) = fixture().await;
        let w1 = store.create_workspace("One", "one").await.expect("w1");
        let w2 = store.create_workspace("Two", "two").await.expect("w2");
        let repo = store
            .add_repo(w2, "api", "/tmp/api", "main")
            .await
            .expect("repo");
        let issue = store.create_issue(w1, "Fix", "fix").await.expect("issue");
        let err = check_direction_repo(&store, issue, repo)
            .await
            .expect_err("cross-workspace must fail");
        assert!(format!("{err:#}").contains("not in"));
        assert!(check_direction_repo(&store, 999, repo).await.is_err());
        assert!(check_direction_repo(&store, issue, 999).await.is_err());
    }

    #[test]
    fn add_direction_defaults() {
        let body: AddDirection =
            serde_json::from_value(json!({ "name": "n", "slug": "s", "repo_id": 1 }))
                .expect("parse");
        assert!(body.mandate.is_none());
        assert!(body.base_branch.is_none());
        let mandate = body.mandate.unwrap_or_else(|| "plan+impl".to_string());
        assert_eq!(mandate, "plan+impl");
    }
}
