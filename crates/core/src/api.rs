//! HTTP API for the weft-codex kanban UI (Stage 3 consumes this). Served by
//! the same axum listener as the MCP bus; the daemon merges both routers.
//!
//! Error mapping is intentionally crude string-sniffing for now (internal
//! tool): "unknown …" → 404, "already has …" → 409, validation wording →
//! 400, everything else → 500 with the full anyhow chain in the body.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::StreamExt;

use crate::orchestrator::Orchestrator;
use crate::store::Store;
use crate::{curator, events};

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
        .route("/api/repos/{id}/analyze", post(analyze_repo))
        .route("/api/repos/{id}/profile", get(repo_profile))
        .route("/api/workspaces/{id}/analyze", post(analyze_workspace))
        .route(
            "/api/workspaces/{id}/analyze-relations",
            post(analyze_relations),
        )
        .route("/api/workspaces/{id}/repo-map", get(repo_map))
        .route("/api/events", get(sse_events))
        .with_state(state)
}

/// Live UI event feed (Stage 3's kanban subscribes here). Lagged frames are
/// skipped — events are advisory, never load-bearing.
async fn sse_events() -> Response {
    let Some(rx) = events::subscribe() else {
        return fail(anyhow::anyhow!("invalid: events channel not installed"));
    };
    let stream = tokio_stream::wrappers::BroadcastStream::new(rx).filter_map(|item| {
        let (event, value) = item.ok()?;
        Some(Ok::<_, std::convert::Infallible>(
            Event::default().event(event).data(value.to_string()),
        ))
    });
    Sse::new(stream).into_response()
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
        Ok(id) => {
            events::emit("workspace.updated", json!({ "id": id }));
            ok(json!({ "id": id }))
        }
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
        Ok(id) => {
            events::emit("repo.added", json!({ "id": id, "workspaceId": workspace_id }));
            ok(json!({ "id": id }))
        }
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
        Ok(id) => {
            events::emit("issue.updated", json!({ "id": id }));
            ok(json!({ "id": id }))
        }
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

/// Kick a per-repo curator analysis (background task; watch `repo.profile`
/// events / poll the profile endpoint for the result).
async fn analyze_repo(State(state): State<ApiState>, Path(repo_id): Path<i64>) -> Response {
    match state.store.get_repo(repo_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return fail(anyhow::anyhow!("unknown repo {repo_id}")),
        Err(e) => return fail(e),
    }
    match state.store.get_profile(repo_id).await {
        Ok(Some(p)) if p.run_state == "running" => {
            return fail(anyhow::anyhow!("repo {repo_id} already has a running analysis"));
        }
        Ok(_) => {}
        Err(e) => return fail(e),
    }
    let store = state.store.clone();
    tokio::spawn(async move {
        if let Err(e) = curator::analyze_repo(&store, repo_id).await {
            events::emit(
                "repo.profile",
                json!({ "repoId": repo_id, "runState": "failed", "error": format!("{e:#}") }),
            );
        }
    });
    (StatusCode::ACCEPTED, Json(json!({ "queued": true }))).into_response()
}

async fn repo_profile(State(state): State<ApiState>, Path(repo_id): Path<i64>) -> Response {
    match state.store.get_profile(repo_id).await {
        Ok(Some(p)) => ok(json!(p)),
        Ok(None) => fail(anyhow::anyhow!("unknown profile for repo {repo_id}")),
        Err(e) => fail(e),
    }
}

/// Kick the full workspace pass: profile every repo, then cross-repo
/// relations + layers + the repo-map document.
async fn analyze_workspace(State(state): State<ApiState>, Path(workspace_id): Path<i64>) -> Response {
    match state.store.list_repos(workspace_id).await {
        Ok(repos) if repos.is_empty() => {
            return fail(anyhow::anyhow!("invalid analyze: workspace {workspace_id} has no repos"));
        }
        Ok(_) => {}
        Err(e) => return fail(e),
    }
    let store = state.store.clone();
    tokio::spawn(async move {
        if let Err(e) = curator::analyze_workspace(&store, workspace_id).await {
            events::emit(
                "repo.relations",
                json!({ "workspaceId": workspace_id, "error": format!("{e:#}") }),
            );
        }
    });
    (StatusCode::ACCEPTED, Json(json!({ "queued": true }))).into_response()
}

/// Re-run ONLY the cross-repo pass (profiles must already be done).
async fn analyze_relations(State(state): State<ApiState>, Path(workspace_id): Path<i64>) -> Response {
    let store = state.store.clone();
    tokio::spawn(async move {
        if let Err(e) = curator::analyze_relations(&store, workspace_id).await {
            events::emit(
                "repo.relations",
                json!({ "workspaceId": workspace_id, "error": format!("{e:#}") }),
            );
        }
    });
    (StatusCode::ACCEPTED, Json(json!({ "queued": true }))).into_response()
}

/// The repo-map payload: every repo with its profile, all relation edges,
/// and the synthesized markdown document.
async fn repo_map(State(state): State<ApiState>, Path(workspace_id): Path<i64>) -> Response {
    let repos = match state.store.list_repos(workspace_id).await {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    let mut entries = Vec::with_capacity(repos.len());
    for repo in repos {
        let profile = match state.store.get_profile(repo.id).await {
            Ok(p) => p,
            Err(e) => return fail(e),
        };
        entries.push(json!({ "repo": repo, "profile": profile }));
    }
    let relations = match state.store.list_relations(workspace_id).await {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    let doc = match state.store.get_workspace_repo_map(workspace_id).await {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    ok(json!({ "repos": entries, "relations": relations, "repoMap": doc }))
}
