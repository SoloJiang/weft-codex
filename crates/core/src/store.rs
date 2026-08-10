//! SQLite store for weft-codex. Fresh schema (no weft legacy columns):
//! `codex_thread_id` is a first-class column from day one.
//!
//! Bootstrap is idempotent `CREATE TABLE IF NOT EXISTS` plus additive
//! `ALTER TABLE` guards; a real migration framework lands when the schema
//! starts churning.

use anyhow::Context;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::path::Path;
use std::str::FromStr;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS workspace (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repo_ref (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    base_ref TEXT NOT NULL DEFAULT '',
    remote_url TEXT NOT NULL DEFAULT '',
    base_ref_is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'feature',
    lead_codex_thread_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS direction (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    repo_id INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    mandate TEXT NOT NULL DEFAULT 'plan+impl',
    target_branch TEXT NOT NULL DEFAULT '',
    base_branch TEXT NOT NULL DEFAULT '',
    spec TEXT NOT NULL DEFAULT '',
    codex_thread_id TEXT NOT NULL DEFAULT '',
    attention INTEGER NOT NULL DEFAULT 0,
    attention_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_binding (
    thread_id TEXT PRIMARY KEY,
    issue_id INTEGER NOT NULL,
    direction_id INTEGER,
    parent_thread_id TEXT NOT NULL DEFAULT '',
    root_thread_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_binding_issue
    ON thread_binding(issue_id, direction_id, is_primary);
CREATE INDEX IF NOT EXISTS idx_thread_binding_parent
    ON thread_binding(parent_thread_id);
CREATE TABLE IF NOT EXISTS worktree (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction_id INTEGER NOT NULL,
    repo_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_commit TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bus_message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    from_party TEXT NOT NULL,
    to_party TEXT NOT NULL,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message',
    ts TEXT NOT NULL,
    delivered_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_bus_inbox ON bus_message(issue_id, to_party);
CREATE TABLE IF NOT EXISTS repo_profile (
    repo_id INTEGER PRIMARY KEY,
    run_state TEXT NOT NULL DEFAULT 'idle',
    run_error TEXT NOT NULL DEFAULT '',
    tier TEXT NOT NULL DEFAULT '',
    stack TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    components TEXT NOT NULL DEFAULT '',
    layer TEXT NOT NULL DEFAULT '',
    layer_rank INTEGER NOT NULL DEFAULT 0,
    codex_thread_id TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repo_relation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    from_repo TEXT NOT NULL,
    to_repo TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT '',
    via TEXT NOT NULL DEFAULT '',
    confidence INTEGER NOT NULL DEFAULT 0,
    rationale TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_relation_ws ON repo_relation(workspace_id);
";

/// A connected store handle. Cheap to clone (Arc inside the pool).
#[derive(Clone)]
pub struct Store {
    pub pool: SqlitePool,
}

pub fn now_unix() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

/// Compare common HTTPS/SSH spellings of the same Git remote without making
/// an empty or local-only remote match anything else. Host names are
/// case-insensitive; repository paths are preserved.
fn git_url_key(value: &str) -> String {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() {
        return String::new();
    }

    let (host, path) = if let Some((_, rest)) = value.split_once("://") {
        let Some((authority, path)) = rest.split_once('/') else {
            return value.to_string();
        };
        let host = authority.rsplit('@').next().unwrap_or(authority);
        (host, path)
    } else if let Some((authority, path)) = value.split_once(':') {
        if authority.contains('@') && !authority.contains('/') {
            (authority.rsplit('@').next().unwrap_or(authority), path)
        } else {
            return value.trim_end_matches(".git").to_string();
        }
    } else {
        return value.trim_end_matches(".git").to_string();
    };

    let path = path.trim_matches('/').trim_end_matches(".git");
    if host.is_empty() || path.is_empty() {
        return value.trim_end_matches(".git").to_string();
    }
    format!("{}/{path}", host.to_ascii_lowercase())
}

/// Add `column` to `table` when missing (idempotent). `definition` is the
/// full column type + constraints, e.g. "TEXT NOT NULL DEFAULT ''".
async fn ensure_column(
    pool: &SqlitePool,
    table: &str,
    column: &str,
    definition: &str,
) -> anyhow::Result<bool> {
    let rows = sqlx::query(&format!("PRAGMA table_info({table})"))
        .fetch_all(pool)
        .await
        .with_context(|| format!("pragma table_info {table}"))?;
    let exists = rows
        .iter()
        .filter_map(|r| r.try_get::<String, _>("name").ok())
        .any(|name| name == column);
    if !exists {
        sqlx::query(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))
        .execute(pool)
        .await
        .with_context(|| format!("alter {table} add {column}"))?;
        return Ok(true);
    }
    Ok(false)
}

async fn upsert_primary_direction_binding(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    direction: &DirectionRow,
    thread_id: &str,
    now: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE thread_binding SET is_primary = 0, updated_at = ?
         WHERE issue_id = ? AND direction_id = ?",
    )
    .bind(now)
    .bind(direction.issue_id)
    .bind(direction.id)
    .execute(&mut **tx)
    .await
    .context("clear previous worker primary")?;
    sqlx::query(
        "INSERT INTO thread_binding
         (thread_id, issue_id, direction_id, parent_thread_id,
          root_thread_id, title, is_primary, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, ?, 1, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           issue_id = excluded.issue_id,
           direction_id = excluded.direction_id,
           parent_thread_id = '',
           root_thread_id = excluded.root_thread_id,
           title = excluded.title,
           is_primary = 1,
           updated_at = excluded.updated_at",
    )
    .bind(thread_id)
    .bind(direction.issue_id)
    .bind(direction.id)
    .bind(thread_id)
    .bind(&direction.name)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await
    .context("upsert worker thread binding")?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct WorkspaceRow {
    pub id: i64,
    pub name: String,
    pub slug: String,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct RepoRow {
    pub id: i64,
    pub workspace_id: i64,
    pub name: String,
    pub path: String,
    pub base_ref: String,
    pub remote_url: String,
    pub base_ref_is_default: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct IssueRow {
    pub id: i64,
    pub workspace_id: i64,
    pub title: String,
    pub slug: String,
    pub kind: String,
    pub lead_codex_thread_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct DirectionRow {
    pub id: i64,
    pub issue_id: i64,
    pub name: String,
    pub slug: String,
    pub branch: String,
    pub status: String,
    pub repo_id: i64,
    pub reason: String,
    pub mandate: String,
    pub target_branch: String,
    pub base_branch: String,
    pub spec: String,
    pub codex_thread_id: String,
    pub attention: i64,
    pub attention_reason: String,
    pub created_at: String,
}

/// A native Codex thread bound to one logical Weft conversation. The
/// canonical lead/worker thread is `is_primary=1`; Codex forks copy the same
/// issue/direction owner while preserving their immediate parent.
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow, PartialEq, Eq)]
pub struct ThreadBindingRow {
    pub thread_id: String,
    pub issue_id: i64,
    pub direction_id: Option<i64>,
    pub parent_thread_id: String,
    pub root_thread_id: String,
    pub title: String,
    pub is_primary: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct BusRow {
    pub id: i64,
    pub issue_id: i64,
    pub from_party: String,
    pub to_party: String,
    pub text: String,
    pub kind: String,
    pub ts: String,
    pub delivered_at: String,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct ProfileRow {
    pub repo_id: i64,
    pub run_state: String,
    pub run_error: String,
    pub tier: String,
    pub stack: String,
    pub summary: String,
    pub components: String,
    pub layer: String,
    pub layer_rank: i64,
    pub codex_thread_id: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct RelationRow {
    pub id: i64,
    pub workspace_id: i64,
    pub from_repo: String,
    pub to_repo: String,
    pub kind: String,
    pub via: String,
    pub confidence: i64,
    pub rationale: String,
}

impl Store {
    /// Open (creating if needed) the store at `path` and bootstrap the schema.
    pub async fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create store dir {}", parent.display()))?;
        }
        let url = format!("sqlite://{}", path.display());
        let options = SqliteConnectOptions::from_str(&url)
            .with_context(|| format!("parse store url {url}"))?
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .with_context(|| format!("open store {url}"))?;
        sqlx::raw_sql(SCHEMA)
            .execute(&pool)
            .await
            .context("bootstrap schema")?;
        // Additive guards for databases created before a column existed
        // (SQLite has no ADD COLUMN IF NOT EXISTS, so probe the pragma).
        ensure_column(&pool, "direction", "spec", "TEXT NOT NULL DEFAULT ''").await?;
        ensure_column(&pool, "workspace", "repo_map", "TEXT NOT NULL DEFAULT ''").await?;
        ensure_column(&pool, "issue", "kind", "TEXT NOT NULL DEFAULT 'feature'").await?;
        ensure_column(&pool, "repo_ref", "remote_url", "TEXT NOT NULL DEFAULT ''").await?;
        ensure_column(
            &pool,
            "repo_ref",
            "base_ref_is_default",
            "INTEGER NOT NULL DEFAULT 0",
        )
        .await?;
        let added_delivery_state = ensure_column(
            &pool,
            "bus_message",
            "delivered_at",
            "TEXT NOT NULL DEFAULT ''",
        )
        .await?;
        if added_delivery_state {
            // Rows written by pre-delivery-state builds are historical audit
            // entries. Mark them settled once during migration so upgrading
            // does not replay an entire old conversation.
            sqlx::query("UPDATE bus_message SET delivered_at = ts WHERE delivered_at = ''")
                .execute(&pool)
                .await
                .context("settle legacy bus messages")?;
        }
        // Databases created before native fork tracking already have their
        // canonical thread ids on issue/direction. Materialize those roots so
        // a later Codex fork can inherit ownership without a data migration.
        sqlx::query(
            "INSERT OR IGNORE INTO thread_binding
             (thread_id, issue_id, direction_id, parent_thread_id,
              root_thread_id, title, is_primary, created_at, updated_at)
             SELECT lead_codex_thread_id, id, NULL, '', lead_codex_thread_id,
                    title, 1, created_at, created_at
             FROM issue WHERE lead_codex_thread_id != ''",
        )
        .execute(&pool)
        .await
        .context("backfill lead thread bindings")?;
        sqlx::query(
            "INSERT OR IGNORE INTO thread_binding
             (thread_id, issue_id, direction_id, parent_thread_id,
              root_thread_id, title, is_primary, created_at, updated_at)
             SELECT codex_thread_id, issue_id, id, '', codex_thread_id,
                    name, 1, created_at, created_at
             FROM direction WHERE codex_thread_id != ''",
        )
        .execute(&pool)
        .await
        .context("backfill worker thread bindings")?;
        Ok(Self { pool })
    }

    // ── workspaces / repos ────────────────────────────────────────────────

    pub async fn create_workspace(&self, name: &str, slug: &str) -> anyhow::Result<i64> {
        let row = sqlx::query(
            "INSERT INTO workspace (name, slug, created_at) VALUES (?, ?, ?) RETURNING id",
        )
        .bind(name)
        .bind(slug)
        .bind(now_unix())
        .fetch_one(&self.pool)
        .await
        .context("create_workspace")?;
        Ok(row.get::<i64, _>("id"))
    }

    pub async fn add_repo(
        &self,
        workspace_id: i64,
        name: &str,
        path: &str,
        base_ref: &str,
    ) -> anyhow::Result<i64> {
        let (repo, _) = self
            .register_repo(workspace_id, name, path, base_ref, "", false)
            .await?;
        Ok(repo.id)
    }

    /// Register a canonical local repository idempotently within a workspace.
    /// Matching paths or normalized non-empty origin URLs return the existing
    /// row. A newly vetted default branch repairs stale registration metadata.
    #[allow(clippy::too_many_arguments)]
    pub async fn register_repo(
        &self,
        workspace_id: i64,
        name: &str,
        path: &str,
        base_ref: &str,
        remote_url: &str,
        base_ref_is_default: bool,
    ) -> anyhow::Result<(RepoRow, bool)> {
        let workspace_exists =
            sqlx::query_scalar::<_, i64>("SELECT id FROM workspace WHERE id = ?")
                .bind(workspace_id)
                .fetch_optional(&self.pool)
                .await
                .context("register_repo workspace")?
                .is_some();
        if !workspace_exists {
            anyhow::bail!("unknown workspace {workspace_id}");
        }
        let name = name.trim();
        let path = path.trim();
        if name.is_empty() || path.is_empty() {
            anyhow::bail!("invalid repository: name and path are required");
        }

        let existing = self.list_repos(workspace_id).await?;
        let remote_key = git_url_key(remote_url);
        let duplicate = existing.into_iter().find(|repo| {
            if repo.path == path {
                return true;
            }
            !remote_key.is_empty() && git_url_key(&repo.remote_url) == remote_key
        });
        if let Some(repo) = duplicate {
            let repair_default =
                base_ref_is_default && (repo.base_ref_is_default == 0 || repo.base_ref != base_ref);
            let repair_fallback = repo.base_ref.is_empty() && !base_ref.is_empty();
            let repair_remote = !remote_url.is_empty() && repo.remote_url != remote_url;
            if repair_default || repair_fallback || repair_remote {
                let next_base = if repair_default || repair_fallback {
                    base_ref
                } else {
                    repo.base_ref.as_str()
                };
                let next_remote = if repair_remote {
                    remote_url
                } else {
                    repo.remote_url.as_str()
                };
                let next_default = if repair_default {
                    1
                } else {
                    repo.base_ref_is_default
                };
                sqlx::query(
                    "UPDATE repo_ref SET base_ref = ?, remote_url = ?,
                     base_ref_is_default = ? WHERE id = ?",
                )
                .bind(next_base)
                .bind(next_remote)
                .bind(next_default)
                .bind(repo.id)
                .execute(&self.pool)
                .await
                .context("repair registered repo metadata")?;
                let repaired = self
                    .get_repo(repo.id)
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("unknown repo {} after update", repo.id))?;
                return Ok((repaired, false));
            }
            return Ok((repo, false));
        }

        let row = sqlx::query(
            "INSERT INTO repo_ref
             (workspace_id, name, path, base_ref, remote_url, base_ref_is_default, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM repo_ref WHERE workspace_id = ? AND path = ?
             )
             RETURNING id",
        )
        .bind(workspace_id)
        .bind(name)
        .bind(path)
        .bind(base_ref)
        .bind(remote_url)
        .bind(i64::from(base_ref_is_default))
        .bind(now_unix())
        .bind(workspace_id)
        .bind(path)
        .fetch_optional(&self.pool)
        .await
        .context("register_repo")?;
        let id = match row {
            Some(row) => row.get::<i64, _>("id"),
            None => {
                let existing = self
                    .list_repos(workspace_id)
                    .await?
                    .into_iter()
                    .find(|repo| repo.path == path)
                    .ok_or_else(|| anyhow::anyhow!("repository registration raced for {path}"))?;
                return Ok((existing, false));
            }
        };
        let repo = self
            .get_repo(id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("unknown repo {id} after insert"))?;
        Ok((repo, true))
    }

    pub async fn get_repo(&self, id: i64) -> anyhow::Result<Option<RepoRow>> {
        sqlx::query_as::<_, RepoRow>(
            "SELECT id, workspace_id, name, path, base_ref, remote_url,
                    base_ref_is_default, created_at
             FROM repo_ref WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .context("get_repo")
    }

    pub async fn list_workspaces(&self) -> anyhow::Result<Vec<WorkspaceRow>> {
        sqlx::query_as::<_, WorkspaceRow>(
            "SELECT id, name, slug, created_at FROM workspace ORDER BY id",
        )
        .fetch_all(&self.pool)
        .await
        .context("list_workspaces")
    }

    pub async fn list_repos(&self, workspace_id: i64) -> anyhow::Result<Vec<RepoRow>> {
        sqlx::query_as::<_, RepoRow>(
            "SELECT id, workspace_id, name, path, base_ref, remote_url,
                    base_ref_is_default, created_at
             FROM repo_ref WHERE workspace_id = ? ORDER BY id",
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await
        .context("list_repos")
    }

    // ── issues ────────────────────────────────────────────────────────────

    pub async fn create_issue(
        &self,
        workspace_id: i64,
        title: &str,
        slug: &str,
    ) -> anyhow::Result<i64> {
        self.create_issue_with_kind(workspace_id, title, slug, "feature")
            .await
    }

    pub async fn create_issue_with_kind(
        &self,
        workspace_id: i64,
        title: &str,
        slug: &str,
        kind: &str,
    ) -> anyhow::Result<i64> {
        const ISSUE_KINDS: [&str; 4] = ["feature", "bugfix", "refactor", "spike"];
        let title = title.trim();
        let slug = slug.trim();
        if title.is_empty() || slug.is_empty() {
            anyhow::bail!("invalid issue: title and slug are required");
        }
        if title.chars().count() > 120 || slug.chars().count() > 120 {
            anyhow::bail!("invalid issue: title or slug is too long");
        }
        if !ISSUE_KINDS.contains(&kind) {
            anyhow::bail!("invalid issue kind {kind:?}");
        }
        let workspace_exists =
            sqlx::query_scalar::<_, i64>("SELECT id FROM workspace WHERE id = ?")
                .bind(workspace_id)
                .fetch_optional(&self.pool)
                .await
                .context("create_issue workspace")?
                .is_some();
        if !workspace_exists {
            anyhow::bail!("unknown workspace {workspace_id}");
        }
        let row = sqlx::query(
            "INSERT INTO issue (workspace_id, title, slug, kind, created_at)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(workspace_id)
        .bind(title)
        .bind(slug)
        .bind(kind)
        .bind(now_unix())
        .fetch_one(&self.pool)
        .await
        .context("create_issue")?;
        Ok(row.get::<i64, _>("id"))
    }

    pub async fn get_issue(&self, id: i64) -> anyhow::Result<Option<IssueRow>> {
        sqlx::query_as::<_, IssueRow>(
            "SELECT id, workspace_id, title, slug, kind, lead_codex_thread_id, created_at
             FROM issue WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .context("get_issue")
    }

    pub async fn set_lead_thread(&self, issue_id: i64, thread_id: &str) -> anyhow::Result<()> {
        let issue = self
            .get_issue(issue_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("unknown issue {issue_id}"))?;
        let now = now_unix();
        let mut tx = self.pool.begin().await.context("set_lead_thread begin")?;
        sqlx::query("UPDATE issue SET lead_codex_thread_id = ? WHERE id = ?")
            .bind(thread_id)
            .bind(issue_id)
            .execute(&mut *tx)
            .await
            .context("set_lead_thread")?;
        sqlx::query(
            "UPDATE thread_binding SET is_primary = 0, updated_at = ?
             WHERE issue_id = ? AND direction_id IS NULL",
        )
        .bind(&now)
        .bind(issue_id)
        .execute(&mut *tx)
        .await
        .context("clear previous lead primary")?;
        sqlx::query(
            "INSERT INTO thread_binding
             (thread_id, issue_id, direction_id, parent_thread_id,
              root_thread_id, title, is_primary, created_at, updated_at)
             VALUES (?, ?, NULL, '', ?, ?, 1, ?, ?)
             ON CONFLICT(thread_id) DO UPDATE SET
               issue_id = excluded.issue_id,
               direction_id = NULL,
               parent_thread_id = '',
               root_thread_id = excluded.root_thread_id,
               title = excluded.title,
               is_primary = 1,
               updated_at = excluded.updated_at",
        )
        .bind(thread_id)
        .bind(issue_id)
        .bind(thread_id)
        .bind(issue.title)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .context("upsert lead thread binding")?;
        tx.commit().await.context("set_lead_thread commit")?;
        Ok(())
    }

    pub async fn get_thread_binding(
        &self,
        thread_id: &str,
    ) -> anyhow::Result<Option<ThreadBindingRow>> {
        sqlx::query_as::<_, ThreadBindingRow>(
            "SELECT thread_id, issue_id, direction_id, parent_thread_id,
                    root_thread_id, title, is_primary, created_at, updated_at
             FROM thread_binding WHERE thread_id = ?",
        )
        .bind(thread_id)
        .fetch_optional(&self.pool)
        .await
        .context("get_thread_binding")
    }

    pub async fn list_thread_bindings(
        &self,
        issue_id: i64,
    ) -> anyhow::Result<Vec<ThreadBindingRow>> {
        sqlx::query_as::<_, ThreadBindingRow>(
            "SELECT thread_id, issue_id, direction_id, parent_thread_id,
                    root_thread_id, title, is_primary, created_at, updated_at
             FROM thread_binding WHERE issue_id = ?
             ORDER BY CASE WHEN direction_id IS NULL THEN 0 ELSE 1 END,
                      direction_id, is_primary DESC, created_at, thread_id",
        )
        .bind(issue_id)
        .fetch_all(&self.pool)
        .await
        .context("list_thread_bindings")
    }

    /// Bind a native Codex fork to the same logical chat as its known parent.
    /// The canonical issue/direction columns are intentionally untouched:
    /// forks are selectable branches, not automatic primary replacements.
    pub async fn bind_thread_fork(
        &self,
        thread_id: &str,
        parent_thread_id: &str,
        title: &str,
    ) -> anyhow::Result<ThreadBindingRow> {
        if thread_id == parent_thread_id {
            anyhow::bail!("invalid thread fork: child equals parent");
        }
        let parent = self
            .get_thread_binding(parent_thread_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("unknown parent thread {parent_thread_id}"))?;
        let title = title.trim();
        let now = now_unix();
        sqlx::query(
            "INSERT INTO thread_binding
             (thread_id, issue_id, direction_id, parent_thread_id,
              root_thread_id, title, is_primary, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
             ON CONFLICT(thread_id) DO UPDATE SET
               title = CASE WHEN excluded.title != '' THEN excluded.title ELSE thread_binding.title END,
               updated_at = excluded.updated_at",
        )
        .bind(thread_id)
        .bind(parent.issue_id)
        .bind(parent.direction_id)
        .bind(parent_thread_id)
        .bind(&parent.root_thread_id)
        .bind(title)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .context("bind_thread_fork")?;
        self.get_thread_binding(thread_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("unknown thread {thread_id} after binding"))
    }

    // ── directions ────────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    pub async fn add_direction(
        &self,
        issue_id: i64,
        name: &str,
        slug: &str,
        repo_id: i64,
        mandate: &str,
        base_branch: &str,
        reason: &str,
        spec: &str,
    ) -> anyhow::Result<i64> {
        let row = sqlx::query(
            "INSERT INTO direction
             (issue_id, name, slug, repo_id, mandate, base_branch, reason, spec, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(issue_id)
        .bind(name)
        .bind(slug)
        .bind(repo_id)
        .bind(mandate)
        .bind(base_branch)
        .bind(reason)
        .bind(spec)
        .bind(now_unix())
        .fetch_one(&self.pool)
        .await
        .context("add_direction")?;
        Ok(row.get::<i64, _>("id"))
    }

    pub async fn get_direction(&self, id: i64) -> anyhow::Result<Option<DirectionRow>> {
        sqlx::query_as::<_, DirectionRow>("SELECT * FROM direction WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .context("get_direction")
    }

    pub async fn list_directions(&self, issue_id: i64) -> anyhow::Result<Vec<DirectionRow>> {
        sqlx::query_as::<_, DirectionRow>("SELECT * FROM direction WHERE issue_id = ? ORDER BY id")
            .bind(issue_id)
            .fetch_all(&self.pool)
            .await
            .context("list_directions")
    }

    /// Directions with a live Codex thread (boot re-attach source).
    pub async fn list_live_directions(&self) -> anyhow::Result<Vec<DirectionRow>> {
        sqlx::query_as::<_, DirectionRow>(
            "SELECT * FROM direction WHERE codex_thread_id != '' ORDER BY id",
        )
        .fetch_all(&self.pool)
        .await
        .context("list_live_directions")
    }

    /// Tasks that were durably created but never received a worker thread.
    /// The daemon requeues these at boot so automatic dispatch survives a
    /// crash between `task_create` and worker startup.
    pub async fn list_undispatched_directions(&self) -> anyhow::Result<Vec<DirectionRow>> {
        sqlx::query_as::<_, DirectionRow>(
            "SELECT * FROM direction
             WHERE codex_thread_id = '' AND status = 'queued'
             ORDER BY id",
        )
        .fetch_all(&self.pool)
        .await
        .context("list_undispatched_directions")
    }

    /// Issues with a live lead thread (boot re-attach source).
    pub async fn list_live_leads(&self) -> anyhow::Result<Vec<IssueRow>> {
        sqlx::query_as::<_, IssueRow>(
            "SELECT id, workspace_id, title, slug, kind, lead_codex_thread_id, created_at
             FROM issue WHERE lead_codex_thread_id != '' ORDER BY id",
        )
        .fetch_all(&self.pool)
        .await
        .context("list_live_leads")
    }

    pub async fn set_direction_status(&self, id: i64, status: &str) -> anyhow::Result<()> {
        sqlx::query("UPDATE direction SET status = ? WHERE id = ?")
            .bind(status)
            .bind(id)
            .execute(&self.pool)
            .await
            .context("set_direction_status")?;
        Ok(())
    }

    /// Accept a task only if it is still waiting for review. The conditional
    /// update prevents a concurrent worker message from being overwritten by
    /// a stale completion click. Acceptance also resolves any attention flag.
    pub async fn complete_direction_if_review(&self, id: i64) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE direction
             SET status = 'done', attention = 0, attention_reason = ''
             WHERE id = ? AND status = 'review'",
        )
        .bind(id)
        .execute(&self.pool)
        .await
        .context("complete_direction_if_review")?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn set_direction_thread(&self, id: i64, thread_id: &str) -> anyhow::Result<()> {
        let direction = self
            .get_direction(id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("unknown direction {id}"))?;
        let now = now_unix();
        let mut tx = self
            .pool
            .begin()
            .await
            .context("set_direction_thread begin")?;
        sqlx::query("UPDATE direction SET codex_thread_id = ? WHERE id = ?")
            .bind(thread_id)
            .bind(id)
            .execute(&mut *tx)
            .await
            .context("set_direction_thread")?;
        upsert_primary_direction_binding(&mut tx, &direction, thread_id, &now).await?;
        tx.commit().await.context("set_direction_thread commit")?;
        Ok(())
    }

    /// Atomically publish a successfully started worker thread and its first
    /// runtime state. A crash cannot leave a queued row pointing at a thread
    /// whose initial turn may or may not have started.
    pub async fn activate_direction_thread(
        &self,
        id: i64,
        thread_id: &str,
        status: &str,
    ) -> anyhow::Result<()> {
        let direction = self
            .get_direction(id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("unknown direction {id}"))?;
        let now = now_unix();
        let mut tx = self
            .pool
            .begin()
            .await
            .context("activate_direction_thread begin")?;
        sqlx::query(
            "UPDATE direction SET codex_thread_id = ?, status = ?,
             attention = 0, attention_reason = '' WHERE id = ?",
        )
        .bind(thread_id)
        .bind(status)
        .bind(id)
        .execute(&mut *tx)
        .await
        .context("activate_direction_thread")?;
        upsert_primary_direction_binding(&mut tx, &direction, thread_id, &now).await?;
        tx.commit()
            .await
            .context("activate_direction_thread commit")?;
        Ok(())
    }

    pub async fn set_direction_branch(&self, id: i64, branch: &str) -> anyhow::Result<()> {
        sqlx::query("UPDATE direction SET branch = ? WHERE id = ?")
            .bind(branch)
            .bind(id)
            .execute(&self.pool)
            .await
            .context("set_direction_branch")?;
        Ok(())
    }

    pub async fn set_direction_attention(
        &self,
        id: i64,
        reason: Option<&str>,
    ) -> anyhow::Result<()> {
        sqlx::query("UPDATE direction SET attention = ?, attention_reason = ? WHERE id = ?")
            .bind(i64::from(reason.is_some()))
            .bind(reason.unwrap_or(""))
            .bind(id)
            .execute(&self.pool)
            .await
            .context("set_direction_attention")?;
        Ok(())
    }

    /// Kanban payload: every issue of the workspace with its directions.
    pub async fn list_issues_with_directions(
        &self,
        workspace_id: i64,
    ) -> anyhow::Result<Vec<(IssueRow, Vec<DirectionRow>)>> {
        let issues = sqlx::query_as::<_, IssueRow>(
            "SELECT id, workspace_id, title, slug, kind, lead_codex_thread_id, created_at
             FROM issue WHERE workspace_id = ? ORDER BY id",
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await
        .context("list_issues")?;
        let mut out = Vec::with_capacity(issues.len());
        for issue in issues {
            let dirs = sqlx::query_as::<_, DirectionRow>(
                "SELECT * FROM direction WHERE issue_id = ? ORDER BY id",
            )
            .bind(issue.id)
            .fetch_all(&self.pool)
            .await
            .context("list_directions")?;
            out.push((issue, dirs));
        }
        Ok(out)
    }

    // ── worktrees ─────────────────────────────────────────────────────────

    pub async fn record_worktree(
        &self,
        direction_id: i64,
        repo_id: i64,
        path: &str,
        branch: &str,
    ) -> anyhow::Result<i64> {
        if let Some(id) = sqlx::query_scalar::<_, i64>(
            "SELECT id FROM worktree WHERE direction_id = ? ORDER BY id LIMIT 1",
        )
        .bind(direction_id)
        .fetch_optional(&self.pool)
        .await
        .context("find existing worktree")?
        {
            sqlx::query("UPDATE worktree SET repo_id = ?, path = ?, branch = ? WHERE id = ?")
                .bind(repo_id)
                .bind(path)
                .bind(branch)
                .bind(id)
                .execute(&self.pool)
                .await
                .context("refresh existing worktree")?;
            return Ok(id);
        }
        let row = sqlx::query(
            "INSERT INTO worktree (direction_id, repo_id, path, branch, created_at)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(direction_id)
        .bind(repo_id)
        .bind(path)
        .bind(branch)
        .bind(now_unix())
        .fetch_one(&self.pool)
        .await
        .context("record_worktree")?;
        Ok(row.get::<i64, _>("id"))
    }

    // ── repo profiles / relations (curator) ───────────────────────────────

    /// Mark a repo's analysis running (idempotent upsert).
    pub async fn profile_mark_running(&self, repo_id: i64, thread_id: &str) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO repo_profile (repo_id, run_state, codex_thread_id, updated_at)
             VALUES (?, 'running', ?, ?)
             ON CONFLICT(repo_id) DO UPDATE SET
               run_state = 'running', run_error = '', codex_thread_id = ?, updated_at = ?",
        )
        .bind(repo_id)
        .bind(thread_id)
        .bind(now_unix())
        .bind(thread_id)
        .bind(now_unix())
        .execute(&self.pool)
        .await
        .context("profile_mark_running")?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn profile_complete(
        &self,
        repo_id: i64,
        tier: &str,
        stack: &str,
        summary: &str,
        components: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE repo_profile SET run_state = 'done', run_error = '',
               tier = ?, stack = ?, summary = ?, components = ?, updated_at = ?
             WHERE repo_id = ?",
        )
        .bind(tier)
        .bind(stack)
        .bind(summary)
        .bind(components)
        .bind(now_unix())
        .bind(repo_id)
        .execute(&self.pool)
        .await
        .context("profile_complete")?;
        Ok(())
    }

    pub async fn profile_fail(&self, repo_id: i64, error: &str) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE repo_profile SET run_state = 'failed', run_error = ?, updated_at = ?
             WHERE repo_id = ?",
        )
        .bind(error)
        .bind(now_unix())
        .bind(repo_id)
        .execute(&self.pool)
        .await
        .context("profile_fail")?;
        Ok(())
    }

    /// Boot recovery: a `running` profile outlived its daemon — mark it
    /// failed so the UI doesn't spin forever. Returns rows fixed.
    pub async fn reset_running_profiles(&self) -> anyhow::Result<u64> {
        let result = sqlx::query(
            "UPDATE repo_profile SET run_state = 'failed',
               run_error = 'daemon restarted mid-analysis', updated_at = ?
             WHERE run_state = 'running'",
        )
        .bind(now_unix())
        .execute(&self.pool)
        .await
        .context("reset_running_profiles")?;
        Ok(result.rows_affected())
    }

    pub async fn profile_set_layer(
        &self,
        repo_id: i64,
        layer: &str,
        rank: i64,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE repo_profile SET layer = ?, layer_rank = ?, updated_at = ?
             WHERE repo_id = ?",
        )
        .bind(layer)
        .bind(rank)
        .bind(now_unix())
        .bind(repo_id)
        .execute(&self.pool)
        .await
        .context("profile_set_layer")?;
        Ok(())
    }

    pub async fn get_profile(&self, repo_id: i64) -> anyhow::Result<Option<ProfileRow>> {
        sqlx::query_as::<_, ProfileRow>("SELECT * FROM repo_profile WHERE repo_id = ?")
            .bind(repo_id)
            .fetch_optional(&self.pool)
            .await
            .context("get_profile")
    }

    /// Atomically replace a workspace's relation edges with a fresh analysis.
    pub async fn replace_relations(
        &self,
        workspace_id: i64,
        relations: &[RelationRow],
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await.context("begin replace_relations")?;
        sqlx::query("DELETE FROM repo_relation WHERE workspace_id = ?")
            .bind(workspace_id)
            .execute(&mut *tx)
            .await
            .context("clear relations")?;
        for rel in relations {
            sqlx::query(
                "INSERT INTO repo_relation
                 (workspace_id, from_repo, to_repo, kind, via, confidence, rationale)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(workspace_id)
            .bind(&rel.from_repo)
            .bind(&rel.to_repo)
            .bind(&rel.kind)
            .bind(&rel.via)
            .bind(rel.confidence)
            .bind(&rel.rationale)
            .execute(&mut *tx)
            .await
            .context("insert relation")?;
        }
        tx.commit().await.context("commit replace_relations")?;
        Ok(())
    }

    pub async fn list_relations(&self, workspace_id: i64) -> anyhow::Result<Vec<RelationRow>> {
        sqlx::query_as::<_, RelationRow>(
            "SELECT * FROM repo_relation WHERE workspace_id = ? ORDER BY id",
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await
        .context("list_relations")
    }

    pub async fn set_workspace_repo_map(&self, workspace_id: i64, doc: &str) -> anyhow::Result<()> {
        sqlx::query("UPDATE workspace SET repo_map = ? WHERE id = ?")
            .bind(doc)
            .bind(workspace_id)
            .execute(&self.pool)
            .await
            .context("set_workspace_repo_map")?;
        Ok(())
    }

    pub async fn get_workspace_repo_map(&self, workspace_id: i64) -> anyhow::Result<String> {
        let row = sqlx::query("SELECT repo_map FROM workspace WHERE id = ?")
            .bind(workspace_id)
            .fetch_optional(&self.pool)
            .await
            .context("get_workspace_repo_map")?;
        let doc = row
            .and_then(|r| r.try_get::<String, _>("repo_map").ok())
            .unwrap_or_default();
        Ok(doc)
    }

    // ── bus durability ────────────────────────────────────────────────────

    /// Append a durable bus message; returns its row id.
    pub async fn bus_append(
        &self,
        issue_id: i64,
        from: &str,
        to: &str,
        text: &str,
    ) -> anyhow::Result<i64> {
        let row = sqlx::query(
            "INSERT INTO bus_message (issue_id, from_party, to_party, text, ts)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(issue_id)
        .bind(from)
        .bind(to)
        .bind(text)
        .bind(now_unix())
        .fetch_one(&self.pool)
        .await
        .context("bus_append")?;
        // Single choke point for ALL bus traffic (MCP bus_post and human
        // messages both append here) — the advisory UI event lives here so
        // every writer gets it, letting timeline views refresh live.
        crate::events::emit(
            "bus.message",
            serde_json::json!({ "issueId": issue_id, "from": from, "to": to }),
        );
        Ok(row.get::<i64, _>("id"))
    }

    /// Durable inbox rows for `(issue, party)`, oldest first.
    pub async fn bus_inbox(&self, issue_id: i64, party: &str) -> anyhow::Result<Vec<BusRow>> {
        let rows = sqlx::query_as::<_, BusRow>(
            "SELECT id, issue_id, from_party, to_party, text, kind, ts, delivered_at
             FROM bus_message
             WHERE issue_id = ? AND to_party = ? ORDER BY id",
        )
        .bind(issue_id)
        .bind(party)
        .fetch_all(&self.pool)
        .await
        .context("bus_inbox")?;
        Ok(rows)
    }

    /// Full durable bus log for an issue (every party), oldest first — the
    /// audit feed the kanban UI renders.
    pub async fn bus_log(&self, issue_id: i64) -> anyhow::Result<Vec<BusRow>> {
        let rows = sqlx::query_as::<_, BusRow>(
            "SELECT id, issue_id, from_party, to_party, text, kind, ts, delivered_at
             FROM bus_message
             WHERE issue_id = ? ORDER BY id",
        )
        .bind(issue_id)
        .fetch_all(&self.pool)
        .await
        .context("bus_log")?;
        Ok(rows)
    }

    /// Every message not yet injected into a thread or explicitly drained by
    /// `bus_read`. Boot recovery rehydrates these rows into the live registry.
    pub async fn pending_bus_messages(&self) -> anyhow::Result<Vec<BusRow>> {
        sqlx::query_as::<_, BusRow>(
            "SELECT id, issue_id, from_party, to_party, text, kind, ts, delivered_at
             FROM bus_message WHERE delivered_at = '' ORDER BY id",
        )
        .fetch_all(&self.pool)
        .await
        .context("pending_bus_messages")
    }

    /// Settle a batch after successful thread injection or `bus_read`.
    pub async fn mark_bus_delivered(&self, ids: &[i64]) -> anyhow::Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut tx = self.pool.begin().await.context("begin mark_bus_delivered")?;
        let delivered_at = now_unix();
        for id in ids {
            sqlx::query(
                "UPDATE bus_message SET delivered_at = ?
                 WHERE id = ? AND delivered_at = ''",
            )
            .bind(&delivered_at)
            .bind(id)
            .execute(&mut *tx)
            .await
            .context("mark bus message delivered")?;
        }
        tx.commit().await.context("commit mark_bus_delivered")?;
        Ok(())
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
    async fn bus_roundtrip() {
        let (store, _dir) = fixture().await;
        let id = store
            .bus_append(7, "lead", "3", "hello")
            .await
            .expect("append");
        assert!(id > 0);
        let inbox = store.bus_inbox(7, "3").await.expect("inbox");
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].text, "hello");
        assert_eq!(store.pending_bus_messages().await.expect("pending").len(), 1);
        store.mark_bus_delivered(&[id]).await.expect("settle");
        assert!(store
            .pending_bus_messages()
            .await
            .expect("settled pending")
            .is_empty());
    }

    #[tokio::test]
    async fn legacy_bus_rows_are_settled_during_delivery_state_migration() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("t.db");
        let store = Store::open(&path).await.expect("open");
        sqlx::query("ALTER TABLE bus_message DROP COLUMN delivered_at")
            .execute(&store.pool)
            .await
            .expect("drop delivery state");
        store
            .bus_append(7, "lead", "3", "historical")
            .await
            .expect("legacy append");
        drop(store);

        let store = Store::open(&path).await.expect("reopen");
        assert!(store
            .pending_bus_messages()
            .await
            .expect("pending")
            .is_empty());
        let rows = store.bus_inbox(7, "3").await.expect("audit");
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].delivered_at.is_empty());
    }

    #[test]
    fn git_remote_key_matches_https_and_ssh() {
        assert_eq!(
            git_url_key("https://github.com/example/product.git"),
            git_url_key("git@github.com:example/product.git")
        );
        assert_eq!(git_url_key(""), "");
    }

    #[tokio::test]
    async fn repo_registration_is_workspace_idempotent_and_repairs_default() {
        let (store, _dir) = fixture().await;
        let ws = store.create_workspace("W", "w").await.expect("workspace");
        let (first, inserted) = store
            .register_repo(
                ws,
                "product",
                "/tmp/product-a",
                "feature/current",
                "git@github.com:example/product.git",
                false,
            )
            .await
            .expect("register");
        assert!(inserted);

        let (same, inserted) = store
            .register_repo(
                ws,
                "renamed checkout",
                "/tmp/product-b",
                "develop",
                "https://github.com/example/product.git",
                true,
            )
            .await
            .expect("dedupe");
        assert!(!inserted);
        assert_eq!(same.id, first.id);
        assert_eq!(same.path, "/tmp/product-a");
        assert_eq!(same.base_ref, "develop");
        assert_eq!(same.base_ref_is_default, 1);
        assert_eq!(store.list_repos(ws).await.expect("list").len(), 1);
    }

    #[tokio::test]
    async fn repo_metadata_columns_are_added_to_existing_database() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("t.db");
        let store = Store::open(&path).await.expect("open");
        sqlx::query("ALTER TABLE repo_ref DROP COLUMN remote_url")
            .execute(&store.pool)
            .await
            .expect("drop remote_url");
        sqlx::query("ALTER TABLE repo_ref DROP COLUMN base_ref_is_default")
            .execute(&store.pool)
            .await
            .expect("drop default marker");
        drop(store);

        let store = Store::open(&path).await.expect("reopen");
        let ws = store.create_workspace("W", "w").await.expect("workspace");
        let (repo, inserted) = store
            .register_repo(
                ws,
                "api",
                "/tmp/api",
                "main",
                "https://example.com/api.git",
                true,
            )
            .await
            .expect("register");
        assert!(inserted);
        assert_eq!(repo.remote_url, "https://example.com/api.git");
        assert_eq!(repo.base_ref_is_default, 1);
    }

    #[tokio::test]
    async fn spec_column_added_to_pre_spec_database() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("t.db");
        let store = Store::open(&path).await.expect("open");
        sqlx::query("ALTER TABLE direction DROP COLUMN spec")
            .execute(&store.pool)
            .await
            .expect("drop spec");
        drop(store);
        let store = Store::open(&path).await.expect("reopen");
        // add_direction binds spec — this fails if the guard did not run.
        let ws = store.create_workspace("W", "w").await.expect("ws");
        let repo = store
            .add_repo(ws, "r", "/tmp/r", "main")
            .await
            .expect("repo");
        let issue = store.create_issue(ws, "i", "i").await.expect("issue");
        store
            .add_direction(issue, "d", "d", repo, "impl-only", "main", "", "the task")
            .await
            .expect("direction with spec");
        let dirs = store.list_directions(issue).await.expect("list");
        assert_eq!(dirs[0].spec, "the task");
    }

    #[tokio::test]
    async fn issue_kind_column_is_migrated_and_validated() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("t.db");
        let store = Store::open(&path).await.expect("open");
        sqlx::query("ALTER TABLE issue DROP COLUMN kind")
            .execute(&store.pool)
            .await
            .expect("drop kind");
        drop(store);

        let store = Store::open(&path).await.expect("reopen");
        let ws = store.create_workspace("W", "w").await.expect("ws");
        let issue = store
            .create_issue_with_kind(ws, "Fix login", "fix-login", "bugfix")
            .await
            .expect("issue");
        let row = store.get_issue(issue).await.expect("get").expect("some");
        assert_eq!(row.kind, "bugfix");
        assert!(store
            .create_issue_with_kind(ws, "Invalid", "invalid", "other")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn issue_direction_kanban_flow() {
        let (store, _dir) = fixture().await;
        let ws = store.create_workspace("W", "w").await.expect("ws");
        let repo = store
            .add_repo(ws, "api", "/tmp/api", "main")
            .await
            .expect("repo");
        let issue = store
            .create_issue(ws, "Fix login", "fix-login")
            .await
            .expect("issue");
        let d = store
            .add_direction(
                issue,
                "backend",
                "backend",
                repo,
                "plan+impl",
                "main",
                "why",
                "",
            )
            .await
            .expect("direction");
        let undispatched = store
            .list_undispatched_directions()
            .await
            .expect("undispatched");
        assert_eq!(undispatched.len(), 1);
        assert_eq!(undispatched[0].id, d);
        store
            .set_direction_thread(d, "codex-t-1")
            .await
            .expect("thread");
        store
            .set_direction_status(d, "working")
            .await
            .expect("status");
        store
            .set_direction_attention(d, Some("turn failed"))
            .await
            .expect("attention");
        let kanban = store.list_issues_with_directions(ws).await.expect("kanban");
        assert_eq!(kanban.len(), 1);
        assert_eq!(kanban[0].1.len(), 1);
        let row = &kanban[0].1[0];
        assert_eq!(row.codex_thread_id, "codex-t-1");
        assert_eq!(row.status, "working");
        assert_eq!(row.attention, 1);
        assert_eq!(row.attention_reason, "turn failed");
        store.set_direction_attention(d, None).await.expect("clear");
        let row = store.get_direction(d).await.expect("get").expect("some");
        assert_eq!(row.attention, 0);
        assert!(store
            .list_undispatched_directions()
            .await
            .expect("undispatched after start")
            .is_empty());
    }

    #[tokio::test]
    async fn worker_activation_and_worktree_recording_are_atomic_and_idempotent() {
        let (store, _dir) = fixture().await;
        let ws = store.create_workspace("W", "w").await.expect("workspace");
        let repo = store.add_repo(ws, "api", "/tmp/api", "main").await.expect("repo");
        let issue = store.create_issue(ws, "Issue", "issue").await.expect("issue");
        let direction = store
            .add_direction(issue, "task", "task", repo, "impl-only", "main", "", "spec")
            .await
            .expect("direction");
        store
            .set_direction_attention(direction, Some("worker-start-failed"))
            .await
            .expect("attention");

        let first = store
            .record_worktree(direction, repo, "/tmp/wt", "weft/issue/task")
            .await
            .expect("record");
        let second = store
            .record_worktree(direction, repo, "/tmp/wt", "weft/issue/task")
            .await
            .expect("record again");
        assert_eq!(first, second);

        store
            .activate_direction_thread(direction, "thread-1", "working")
            .await
            .expect("activate");
        let row = store
            .get_direction(direction)
            .await
            .expect("get")
            .expect("direction row");
        assert_eq!(row.codex_thread_id, "thread-1");
        assert_eq!(row.status, "working");
        assert_eq!(row.attention, 0);
        let count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM worktree WHERE direction_id = ?",
        )
        .bind(direction)
        .fetch_one(&store.pool)
        .await
        .expect("worktree count");
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn thread_bindings_keep_native_forks_under_their_logical_chat() {
        let (store, _dir) = fixture().await;
        let ws = store.create_workspace("W", "w").await.expect("workspace");
        let repo = store
            .add_repo(ws, "api", "/tmp/api", "main")
            .await
            .expect("repo");
        let issue = store
            .create_issue(ws, "Issue", "issue")
            .await
            .expect("issue");
        let direction = store
            .add_direction(issue, "Task", "task", repo, "impl-only", "main", "", "spec")
            .await
            .expect("direction");

        store
            .set_lead_thread(issue, "lead-primary")
            .await
            .expect("lead");
        store
            .set_direction_thread(direction, "worker-primary")
            .await
            .expect("worker");
        let lead_fork = store
            .bind_thread_fork("lead-fork-1", "lead-primary", "Alternative plan")
            .await
            .expect("lead fork");
        let nested_fork = store
            .bind_thread_fork("lead-fork-2", "lead-fork-1", "")
            .await
            .expect("nested fork");

        assert_eq!(lead_fork.issue_id, issue);
        assert_eq!(lead_fork.direction_id, None);
        assert_eq!(lead_fork.parent_thread_id, "lead-primary");
        assert_eq!(lead_fork.root_thread_id, "lead-primary");
        assert_eq!(lead_fork.is_primary, 0);
        assert_eq!(nested_fork.root_thread_id, "lead-primary");

        let bindings = store.list_thread_bindings(issue).await.expect("bindings");
        assert_eq!(bindings.len(), 4);
        assert_eq!(bindings[0].thread_id, "lead-primary");
        assert_eq!(bindings[0].is_primary, 1);
        assert_eq!(bindings[3].thread_id, "worker-primary");
        assert!(store
            .bind_thread_fork("orphan", "unknown", "")
            .await
            .is_err());
        // The failure must leave nothing behind — a half-written row would make
        // an unrelated Codex chat look like it belongs to an issue.
        assert!(store
            .get_thread_binding("orphan")
            .await
            .expect("get")
            .is_none());
    }

    #[tokio::test]
    async fn concurrent_fork_binds_converge_on_a_single_row() {
        let (store, _dir) = fixture().await;
        let ws = store.create_workspace("W", "w").await.expect("ws");
        let issue = store.create_issue(ws, "one", "one").await.expect("i");
        store.set_lead_thread(issue, "lead").await.expect("lead");

        // The UI resolves on every native thread switch, so the same fork can be
        // adopted by several in-flight requests at once.
        let mut tasks = Vec::new();
        for n in 0..8 {
            let store = store.clone();
            tasks.push(tokio::spawn(async move {
                store.bind_thread_fork("fork", "lead", &format!("try {n}")).await
            }));
        }
        for task in tasks {
            task.await.expect("join").expect("bind");
        }

        let rows = store.list_thread_bindings(issue).await.expect("list");
        let forks: Vec<_> = rows.iter().filter(|row| row.thread_id == "fork").collect();
        assert_eq!(forks.len(), 1, "concurrent adoption must not duplicate rows");
        assert_eq!(forks[0].is_primary, 0);
        assert_eq!(forks[0].issue_id, issue);
        assert_eq!(
            rows.iter().filter(|row| row.is_primary == 1).count(),
            1,
            "exactly one primary must survive concurrent writes"
        );
    }

    #[tokio::test]
    async fn re_setting_a_lead_thread_moves_the_primary_flag_atomically() {
        let (store, _dir) = fixture().await;
        let ws = store.create_workspace("W", "w").await.expect("ws");
        let issue = store.create_issue(ws, "one", "one").await.expect("i");
        store.set_lead_thread(issue, "lead-a").await.expect("a");
        store.set_lead_thread(issue, "lead-b").await.expect("b");

        let rows = store.list_thread_bindings(issue).await.expect("list");
        let primaries: Vec<_> = rows.iter().filter(|row| row.is_primary == 1).collect();
        assert_eq!(primaries.len(), 1, "clear-then-set must not leave two primaries");
        assert_eq!(primaries[0].thread_id, "lead-b");
    }

    #[tokio::test]
    async fn canonical_thread_columns_backfill_binding_rows_on_reopen() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("t.db");
        let store = Store::open(&path).await.expect("open");
        let ws = store.create_workspace("W", "w").await.expect("workspace");
        let repo = store
            .add_repo(ws, "api", "/tmp/api", "main")
            .await
            .expect("repo");
        let issue = store
            .create_issue(ws, "Issue", "issue")
            .await
            .expect("issue");
        let direction = store
            .add_direction(issue, "Task", "task", repo, "impl-only", "main", "", "spec")
            .await
            .expect("direction");
        store
            .set_lead_thread(issue, "lead-old")
            .await
            .expect("lead");
        store
            .set_direction_thread(direction, "worker-old")
            .await
            .expect("worker");
        sqlx::query("DELETE FROM thread_binding")
            .execute(&store.pool)
            .await
            .expect("simulate old database");
        drop(store);

        let reopened = Store::open(&path).await.expect("reopen");
        let bindings = reopened
            .list_thread_bindings(issue)
            .await
            .expect("bindings");
        assert_eq!(bindings.len(), 2);
        assert!(bindings.iter().all(|binding| binding.is_primary == 1));
    }
}
