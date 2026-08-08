//! Orchestrator: lead/direction Codex-thread lifecycle and bus delivery.
//!
//! Every lead/direction conversation IS a Codex thread (migration spec §5);
//! this module creates them, feeds them, and folds app-server notifications
//! back into kanban state. Injection semantics are spike-verified
//! (docs/spike-app-server): `turn/start` while a turn is active is silently
//! dropped by the server (returns success, never runs), so mid-turn delivery
//! MUST go through `turn/steer` with the tracked active turn id.
//!
//! Concurrency: `inject_lock` serializes every thread mutation weftd makes
//! (spawn's first turn, bus delivery, human messages). Without it, a
//! delivery racing a `start_turn` → `set_active_turn` window would see "no
//! active turn" and fire a second `turn/start` — the silent-drop case above.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use tokio::sync::{mpsc::UnboundedReceiver, Mutex};
use weft_app_server::client as codex;
use weft_app_server::client::{Client, ThreadMsg};
use weft_app_server::proto::ChatEvent;

use crate::bus::{BusRegistry, Msg};
use crate::store::Store;
use crate::{brief, events, runtime, worktree};

/// Kanban status for a freshly spawned direction, by mandate.
pub fn initial_status(mandate: &str) -> &'static str {
    if mandate == "impl-only" {
        "working"
    } else {
        "planning"
    }
}

/// The status a direction lands in when its turn completes (success or not —
/// an errored turn also sets `attention`; both then wait on the next pass).
pub fn status_after_turn_end() -> &'static str {
    "review"
}

/// Statuses a human may drag a direction into (kanban columns).
pub const HUMAN_STATUSES: [&str; 5] = ["queued", "planning", "working", "review", "done"];

fn non_empty(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// What a spawned watcher folds notifications into.
#[derive(Clone, Copy)]
enum WatchTarget {
    Direction(i64),
    Lead(i64),
}

/// Shared orchestration state. Cheap to clone (Arc fields / pool inside).
#[derive(Clone)]
pub struct Orchestrator {
    store: Store,
    bus: BusRegistry,
    /// Public base URL of weftd's MCP server, e.g. `http://127.0.0.1:47810`.
    bus_base: String,
    /// weft-codex home; direction worktrees live under `<home>/worktrees/`.
    home: PathBuf,
    inject_lock: Arc<Mutex<()>>,
}

impl Orchestrator {
    pub fn new(store: Store, bus: BusRegistry, bus_base: String, home: PathBuf) -> Self {
        Self {
            store,
            bus,
            bus_base,
            home,
            inject_lock: Arc::new(Mutex::new(())),
        }
    }

    fn bus_url(&self, issue_id: i64, party: &str) -> String {
        format!("{}/bus/{issue_id}/{party}/mcp", self.bus_base)
    }

    /// Resolve a bus party to its Codex thread: `lead` → the issue's lead
    /// thread, a numeric party → that direction's thread. A direction id
    /// from ANOTHER issue resolves to None — a party can only ever reach
    /// participants of its own issue.
    pub async fn thread_for(&self, issue_id: i64, party: &str) -> anyhow::Result<Option<String>> {
        if party == brief::LEAD_PARTY {
            let issue = self.store.get_issue(issue_id).await?;
            return Ok(issue.and_then(|i| non_empty(i.lead_codex_thread_id)));
        }
        let dir_id = match party.parse::<i64>() {
            Ok(id) => id,
            Err(_) => return Ok(None),
        };
        let direction = self.store.get_direction(dir_id).await?;
        match direction {
            Some(d) if d.issue_id == issue_id => Ok(non_empty(d.codex_thread_id)),
            _ => Ok(None),
        }
    }

    // ── spawning ──────────────────────────────────────────────────────────

    /// Materialize the direction's worktree, create its Codex thread (cwd =
    /// worktree, workspace-write sandbox, per-thread bus MCP), subscribe a
    /// watcher, and kick off the brief turn. Refuses to respawn a direction
    /// that already has a thread (restart re-attach is a later stage).
    /// Returns the new Codex thread id.
    pub async fn spawn_direction(&self, direction_id: i64) -> anyhow::Result<String> {
        if !runtime::agents_allowed() {
            anyhow::bail!("daemon is not live; refusing to spawn agents");
        }
        let direction = self
            .store
            .get_direction(direction_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("unknown direction {direction_id}"))?;
        if !direction.codex_thread_id.is_empty() {
            anyhow::bail!("direction {direction_id} already has a Codex thread");
        }
        let issue = self
            .store
            .get_issue(direction.issue_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("unknown issue {}", direction.issue_id))?;
        let repo = self
            .store
            .get_repo(direction.repo_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("unknown repo {}", direction.repo_id))?;

        let gate = self.inject_lock.lock().await;

        let branch = worktree::branch_name(&issue.slug, &direction.slug);
        let wt_path = worktree::worktree_path(&self.home, &issue.slug, &direction.slug);
        let info = worktree::ensure_worktree(
            std::path::Path::new(&repo.path),
            &wt_path,
            &branch,
            &direction.base_branch,
        )
        .await?;
        self.store
            .record_worktree(direction.id, repo.id, &info.path.to_string_lossy(), &info.branch)
            .await?;
        self.store
            .set_direction_branch(direction.id, &info.branch)
            .await?;

        let party = brief::direction_party(direction.id);
        let url = self.bus_url(issue.id, &party);
        let client = codex::client().await?;
        let result = client
            .request(
                "thread/start",
                codex::thread_start_params_configured(
                    &info.path.to_string_lossy(),
                    "never",
                    "workspace-write",
                    Some(&url),
                    false,
                ),
            )
            .await?;
        let thread_id = codex::thread_id_of(&result)
            .ok_or_else(|| anyhow::anyhow!("thread/start: no thread.id"))?;
        self.store
            .set_direction_thread(direction.id, &thread_id)
            .await?;

        let rx = client.subscribe(&thread_id).await;
        tokio::spawn(watch(
            self.clone(),
            client.clone(),
            WatchTarget::Direction(direction.id),
            thread_id.clone(),
            rx,
        ));

        let text = brief::direction_brief(
            &issue.title,
            &direction.name,
            &direction.spec,
            &direction.mandate,
            &direction.reason,
            &repo.name,
            &party,
            &url,
        );
        let turn_id = client.start_turn(&thread_id, &text).await?;
        client.set_active_turn(&thread_id, &turn_id).await;

        let status = initial_status(&direction.mandate);
        self.store.set_direction_status(direction.id, status).await?;
        events::emit(
            "direction.updated",
            json!({ "id": direction.id, "status": status, "codexThreadId": thread_id }),
        );

        // Flush anything queued for this party before it existed.
        drop(gate);
        self.deliver(issue.id, &party).await;
        Ok(thread_id)
    }

    /// Create the issue's lead thread: read-only sandbox over the first repo
    /// (the lead coordinates; it does not write code). Returns the new
    /// Codex thread id.
    pub async fn spawn_lead(&self, issue_id: i64) -> anyhow::Result<String> {
        if !runtime::agents_allowed() {
            anyhow::bail!("daemon is not live; refusing to spawn agents");
        }
        let issue = self
            .store
            .get_issue(issue_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("unknown issue {issue_id}"))?;
        if !issue.lead_codex_thread_id.is_empty() {
            anyhow::bail!("issue {issue_id} already has a lead thread");
        }
        let directions = self.store.list_directions(issue_id).await?;
        let repos = self.store.list_repos(issue.workspace_id).await?;
        let cwd = match repos.first() {
            Some(r) => r.path.clone(),
            None => self.home.to_string_lossy().to_string(),
        };

        let gate = self.inject_lock.lock().await;

        let url = self.bus_url(issue.id, brief::LEAD_PARTY);
        let client = codex::client().await?;
        let result = client
            .request(
                "thread/start",
                codex::thread_start_params_configured(&cwd, "never", "read-only", Some(&url), false),
            )
            .await?;
        let thread_id = codex::thread_id_of(&result)
            .ok_or_else(|| anyhow::anyhow!("thread/start: no thread.id"))?;
        self.store.set_lead_thread(issue.id, &thread_id).await?;

        let rx = client.subscribe(&thread_id).await;
        tokio::spawn(watch(
            self.clone(),
            client.clone(),
            WatchTarget::Lead(issue.id),
            thread_id.clone(),
            rx,
        ));

        let pairs: Vec<(i64, String)> = directions.iter().map(|d| (d.id, d.name.clone())).collect();
        let text = brief::lead_brief(&issue.title, &pairs, &url);
        let turn_id = client.start_turn(&thread_id, &text).await?;
        client.set_active_turn(&thread_id, &turn_id).await;

        events::emit(
            "issue.updated",
            json!({ "id": issue.id, "leadCodexThreadId": thread_id }),
        );

        drop(gate);
        self.deliver(issue.id, brief::LEAD_PARTY).await;
        Ok(thread_id)
    }

    // ── injection ───────────────────────────────────────────────────────────

    /// Steer-or-start: deliver `text` into `thread_id`. Returns false when
    /// both paths errored (the caller requeues). One spike-documented hole
    /// remains: `turn/start` while the server is busy with a turn WE did not
    /// start (human manual takeover in Desktop) returns Ok but never runs —
    /// the message still lands in the durable bus log and stays pullable via
    /// `bus_read`, so nothing is lost, only delayed.
    async fn inject(&self, client: &Client, thread_id: &str, text: &str) -> bool {
        if let Some(turn_id) = client.active_turn(thread_id).await {
            if client.steer_turn(thread_id, &turn_id, text).await.is_ok() {
                return true;
            }
        }
        match client.start_turn(thread_id, text).await {
            Ok(new_turn) => {
                client.set_active_turn(thread_id, &new_turn).await;
                true
            }
            Err(_) => false,
        }
    }

    /// Deliver everything queued for `(issue_id, party)` into its thread.
    /// No thread yet (party not spawned) → the inbox stays put for
    /// `bus_read` and for the flush at spawn time.
    pub async fn deliver(&self, issue_id: i64, party: &str) {
        let thread_id = match self.thread_for(issue_id, party).await {
            Ok(Some(t)) => t,
            _ => return,
        };
        let _gate = self.inject_lock.lock().await;
        let msgs = self.bus.drain(issue_id, party);
        if msgs.is_empty() {
            return;
        }
        let text = join_envelopes(&msgs);
        let client = match codex::client().await {
            Ok(c) => c,
            Err(_) => {
                self.bus.requeue_front(issue_id, party, msgs);
                return;
            }
        };
        if self.inject(&client, &thread_id, &text).await {
            if let Ok(dir_id) = party.parse::<i64>() {
                let _ = self.store.set_direction_status(dir_id, "working").await;
                events::emit(
                    "direction.updated",
                    json!({ "id": dir_id, "status": "working" }),
                );
            }
        } else {
            self.bus.requeue_front(issue_id, party, msgs);
            events::emit(
                "bus.undelivered",
                json!({ "issueId": issue_id, "party": party }),
            );
        }
    }

    /// Bus wake loop: every `bus_post` lands here for live delivery. A
    /// `Lagged` wake is harmless — the inbox persists and the next wake
    /// re-drains it.
    pub async fn run_bus_delivery(self) {
        let mut wakes = self.bus.subscribe_wake();
        loop {
            match wakes.recv().await {
                Ok((issue, party)) => self.deliver(issue, &party).await,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }

    // ── human input (the kanban UI's talk buttons) ────────────────────────

    /// Inject a human message into a direction's thread. Audit-logged as
    /// from `human`; on delivery failure the message is parked on the bus
    /// (one wake-driven retry, then `bus_read` fallback), never lost.
    pub async fn human_message_direction(
        &self,
        direction_id: i64,
        text: &str,
    ) -> anyhow::Result<()> {
        let direction = self
            .store
            .get_direction(direction_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("unknown direction {direction_id}"))?;
        let party = brief::direction_party(direction.id);
        self.store
            .bus_append(direction.issue_id, "human", &party, text)
            .await?;
        self.human_message(direction.issue_id, &party, text).await
    }

    /// Inject a human message into the issue's lead thread.
    pub async fn human_message_lead(&self, issue_id: i64, text: &str) -> anyhow::Result<()> {
        let issue = self
            .store
            .get_issue(issue_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("unknown issue {issue_id}"))?;
        self.store
            .bus_append(issue.id, "human", brief::LEAD_PARTY, text)
            .await?;
        self.human_message(issue.id, brief::LEAD_PARTY, text).await
    }

    async fn human_message(&self, issue_id: i64, party: &str, text: &str) -> anyhow::Result<()> {
        let Some(thread_id) = self.thread_for(issue_id, party).await? else {
            anyhow::bail!("{party} has no Codex thread yet");
        };
        let _gate = self.inject_lock.lock().await;
        let client = codex::client().await?;
        let envelope = brief::bus_envelope("human", text);
        if self.inject(&client, &thread_id, &envelope).await {
            if let Ok(dir_id) = party.parse::<i64>() {
                let _ = self.store.set_direction_status(dir_id, "working").await;
                events::emit(
                    "direction.updated",
                    json!({ "id": dir_id, "status": "working" }),
                );
            }
            return Ok(());
        }
        let msg = Msg {
            from: "human".to_string(),
            text: text.to_string(),
            kind: "message".to_string(),
            ts: crate::store::now_unix(),
        };
        self.bus.post(issue_id, party, msg);
        Ok(())
    }

    /// Human kanban drag; only [`HUMAN_STATUSES`] are accepted.
    pub async fn set_direction_status(
        &self,
        direction_id: i64,
        status: &str,
    ) -> anyhow::Result<()> {
        if !HUMAN_STATUSES.contains(&status) {
            anyhow::bail!("invalid status {status:?}; expected one of {HUMAN_STATUSES:?}");
        }
        self.store.set_direction_status(direction_id, status).await?;
        events::emit(
            "direction.updated",
            json!({ "id": direction_id, "status": status }),
        );
        Ok(())
    }

    pub async fn clear_direction_attention(&self, direction_id: i64) -> anyhow::Result<()> {
        self.store.set_direction_attention(direction_id, None).await?;
        events::emit(
            "direction.updated",
            json!({ "id": direction_id, "attention": false }),
        );
        Ok(())
    }

    // ── watcher ─────────────────────────────────────────────────────────────

    async fn on_turn_end(&self, target: WatchTarget, is_error: bool) {
        match target {
            WatchTarget::Direction(id) => {
                let status = status_after_turn_end();
                let _ = self.store.set_direction_status(id, status).await;
                if is_error {
                    // Keep an earlier, more specific reason (e.g. quota).
                    let flagged = self
                        .store
                        .get_direction(id)
                        .await
                        .ok()
                        .flatten()
                        .map(|d| d.attention != 0)
                        .unwrap_or(false);
                    if !flagged {
                        let _ = self
                            .store
                            .set_direction_attention(id, Some("turn failed"))
                            .await;
                    }
                }
                events::emit(
                    "direction.updated",
                    json!({ "id": id, "status": status, "turnError": is_error }),
                );
            }
            WatchTarget::Lead(issue_id) => {
                if is_error {
                    events::emit("lead.attention", json!({ "issueId": issue_id }));
                }
            }
        }
    }
}

/// Envelope-join a drained inbox into one turn input.
fn join_envelopes(msgs: &[Msg]) -> String {
    msgs.iter()
        .map(|m| brief::bus_envelope(&m.from, &m.text))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Per-thread notification fold: turn completion → kanban state; anomalous
/// approval asks → defensive decline (approvalPolicy is `never`, so an ask
/// reaching us is itself noteworthy); quota → attention flag.
async fn watch(
    orch: Orchestrator,
    client: Client,
    target: WatchTarget,
    thread_id: String,
    mut rx: UnboundedReceiver<ThreadMsg>,
) {
    while let Some(msg) = rx.recv().await {
        match msg {
            ThreadMsg::Event(ChatEvent::TurnEnd { is_error, .. }) => {
                client.clear_active_turn(&thread_id).await;
                orch.on_turn_end(target, is_error).await;
            }
            ThreadMsg::Approval { id, method, .. } => {
                let _ = client.reply_approval(&id, "decline").await;
                events::emit(
                    "approval.declined",
                    json!({ "threadId": thread_id, "method": method }),
                );
            }
            ThreadMsg::QuotaExceeded => {
                if let WatchTarget::Direction(id) = target {
                    let _ = orch
                        .store
                        .set_direction_attention(id, Some("quota exceeded"))
                        .await;
                    events::emit(
                        "direction.updated",
                        json!({ "id": id, "attention": true, "reason": "quota exceeded" }),
                    );
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture() -> (Orchestrator, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tmp");
        let store = Store::open(&dir.path().join("t.db")).await.expect("open");
        let orch = Orchestrator::new(
            store,
            BusRegistry::new(),
            "http://127.0.0.1:1".to_string(),
            dir.path().join("home"),
        );
        (orch, dir)
    }

    #[test]
    fn status_mapping() {
        assert_eq!(initial_status("plan+impl"), "planning");
        assert_eq!(initial_status("impl-only"), "working");
        assert_eq!(initial_status("anything-else"), "planning");
        assert_eq!(status_after_turn_end(), "review");
        assert!(HUMAN_STATUSES.contains(&"done"));
        assert!(!HUMAN_STATUSES.contains(&"bogus"));
    }

    #[tokio::test]
    async fn thread_for_resolves_parties_and_blocks_cross_issue() {
        let (orch, _dir) = fixture().await;
        let ws = orch.store.create_workspace("W", "w").await.expect("ws");
        let repo = orch
            .store
            .add_repo(ws, "api", "/tmp/api", "main")
            .await
            .expect("repo");
        let i1 = orch.store.create_issue(ws, "one", "one").await.expect("i1");
        let i2 = orch.store.create_issue(ws, "two", "two").await.expect("i2");
        let d = orch
            .store
            .add_direction(i1, "backend", "backend", repo, "impl-only", "main", "", "")
            .await
            .expect("d");
        orch.store
            .set_direction_thread(d, "t-dir")
            .await
            .expect("thread");
        orch.store.set_lead_thread(i1, "t-lead").await.expect("lead");

        assert_eq!(
            orch.thread_for(i1, "lead").await.expect("resolve"),
            Some("t-lead".to_string())
        );
        let party = d.to_string();
        assert_eq!(
            orch.thread_for(i1, &party).await.expect("resolve"),
            Some("t-dir".to_string())
        );
        // Cross-issue reference resolves to None.
        assert_eq!(orch.thread_for(i2, &party).await.expect("resolve"), None);
        // Unknown / non-numeric parties resolve to None.
        assert_eq!(orch.thread_for(i1, "nobody").await.expect("resolve"), None);
        assert_eq!(orch.thread_for(i1, "999").await.expect("resolve"), None);
    }

    #[tokio::test]
    async fn thread_for_empty_means_not_spawned() {
        let (orch, _dir) = fixture().await;
        let ws = orch.store.create_workspace("W", "w").await.expect("ws");
        let issue = orch.store.create_issue(ws, "one", "one").await.expect("i");
        assert_eq!(orch.thread_for(issue, "lead").await.expect("resolve"), None);
    }

    #[test]
    fn join_envelopes_wraps_each_sender() {
        let msgs = vec![
            Msg {
                from: "lead".to_string(),
                text: "hi".to_string(),
                kind: "message".to_string(),
                ts: "0".to_string(),
            },
            Msg {
                from: "3".to_string(),
                text: "report".to_string(),
                kind: "message".to_string(),
                ts: "1".to_string(),
            },
        ];
        let text = join_envelopes(&msgs);
        assert!(text.contains("[bus message from lead]\nhi"));
        assert!(text.contains("[bus message from 3]\nreport"));
        assert!(text.contains("\n\n"));
    }

    #[tokio::test]
    async fn set_direction_status_validates() {
        let (orch, _dir) = fixture().await;
        let ws = orch.store.create_workspace("W", "w").await.expect("ws");
        let repo = orch
            .store
            .add_repo(ws, "api", "/tmp/api", "main")
            .await
            .expect("repo");
        let issue = orch.store.create_issue(ws, "one", "one").await.expect("i");
        let d = orch
            .store
            .add_direction(issue, "backend", "backend", repo, "impl-only", "main", "", "")
            .await
            .expect("d");
        assert!(orch.set_direction_status(d, "bogus").await.is_err());
        orch.set_direction_status(d, "done").await.expect("done");
        let row = orch.store.get_direction(d).await.expect("get").expect("some");
        assert_eq!(row.status, "done");
    }
}
