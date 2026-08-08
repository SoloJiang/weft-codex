//! SQLite store for weft-codex. Fresh schema (no weft legacy columns):
//! `codex_thread_id` is a first-class column from day one.
//!
//! Bootstrap is idempotent `CREATE TABLE IF NOT EXISTS` for now; a real
//! migration framework lands when the schema starts evolving.

use anyhow::Context;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
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
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
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
    codex_thread_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bus_message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    from_party TEXT NOT NULL,
    to_party TEXT NOT NULL,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message',
    ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bus_inbox ON bus_message(issue_id, to_party);
";

/// A connected store handle. Cheap to clone (Arc inside the pool).
#[derive(Clone)]
pub struct Store {
    pub pool: SqlitePool,
}

fn now_unix() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
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
        Ok(Self { pool })
    }

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
        Ok(sqlx::Row::get::<i64, _>(&row, "id"))
    }

    /// Durable inbox rows for `(issue, party)`, oldest first.
    pub async fn bus_inbox(&self, issue_id: i64, party: &str) -> anyhow::Result<Vec<BusRow>> {
        let rows = sqlx::query_as::<_, BusRow>(
            "SELECT id, from_party, text, kind, ts FROM bus_message
             WHERE issue_id = ? AND to_party = ? ORDER BY id",
        )
        .bind(issue_id)
        .bind(party)
        .fetch_all(&self.pool)
        .await
        .context("bus_inbox")?;
        Ok(rows)
    }
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct BusRow {
    pub id: i64,
    pub from_party: String,
    pub text: String,
    pub kind: String,
    pub ts: String,
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn open_bootstrap_and_bus_roundtrip() {
        let dir = tempfile::tempdir().expect("tmp");
        let store = super::Store::open(&dir.path().join("t.db"))
            .await
            .expect("open");
        let id = store.bus_append(7, "lead", "3", "hello").await.expect("append");
        assert!(id > 0);
        let inbox = store.bus_inbox(7, "3").await.expect("inbox");
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].text, "hello");
        assert_eq!(inbox[0].from_party, "lead");
        // Reopen: schema bootstrap is idempotent, data survives.
        let store2 = super::Store::open(&dir.path().join("t.db"))
            .await
            .expect("reopen");
        let inbox2 = store2.bus_inbox(7, "3").await.expect("inbox2");
        assert_eq!(inbox2.len(), 1);
    }
}
