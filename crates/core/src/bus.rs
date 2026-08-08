//! Thread bus: per-issue participant inboxes. Participant identity comes from
//! the MCP URL path (`/bus/:issue/:party/mcp`), never from tool arguments —
//! an agent cannot spoof `from`.
//!
//! Memory is the live inbox; `bus_message` rows are the durable audit log.
//! A `post` also fires a wake signal — Stage 2's orchestrator subscribes to
//! it and delivers the message into the recipient's Codex thread
//! (`turn/steer` while busy, `turn/start` when idle; see the migration spec
//! §6 for the verified semantics).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct Msg {
    pub from: String,
    pub text: String,
    pub kind: String,
    pub ts: String,
}

struct Inner {
    inboxes: HashMap<(i64, String), Vec<Msg>>,
    wake: broadcast::Sender<(i64, String)>,
}

/// Process-wide bus registry. Clone to share (Arc inside).
#[derive(Clone)]
pub struct BusRegistry(Arc<Mutex<Inner>>);

impl BusRegistry {
    pub fn new() -> Self {
        let (wake, _rx) = broadcast::channel(256);
        Self(Arc::new(Mutex::new(Inner {
            inboxes: HashMap::new(),
            wake,
        })))
    }

    /// Deliver `msg` into `(issue, to)`'s inbox and notify wakers.
    pub fn post(&self, issue: i64, to: &str, msg: Msg) {
        let wake = {
            let mut g = match self.0.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            g.inboxes
                .entry((issue, to.to_string()))
                .or_default()
                .push(msg);
            g.wake.clone()
        };
        let _ = wake.send((issue, to.to_string()));
    }

    /// Drain `(issue, party)`'s live inbox, oldest first.
    pub fn drain(&self, issue: i64, party: &str) -> Vec<Msg> {
        let mut g = match self.0.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        g.inboxes
            .remove(&(issue, party.to_string()))
            .unwrap_or_default()
    }

    /// Subscribe to wake signals `(issue, to_party)` fired on every post.
    pub fn subscribe_wake(&self) -> broadcast::Receiver<(i64, String)> {
        let g = match self.0.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        g.wake.subscribe()
    }
}

impl Default for BusRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(from: &str, text: &str) -> Msg {
        Msg {
            from: from.to_string(),
            text: text.to_string(),
            kind: "message".to_string(),
            ts: "0".to_string(),
        }
    }

    #[tokio::test]
    async fn post_drain_and_wake() {
        let bus = BusRegistry::new();
        let mut wakes = bus.subscribe_wake();
        bus.post(7, "3", msg("lead", "hi"));
        bus.post(7, "3", msg("lead", "again"));
        bus.post(7, "lead", msg("3", "report"));
        // Wake fired for each post, addressed to the recipient.
        let w = wakes.recv().await.expect("wake 1");
        assert_eq!(w, (7, "3".to_string()));
        let drained = bus.drain(7, "3");
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].text, "hi");
        assert_eq!(drained[1].from, "lead");
        // Drain is destructive.
        assert!(bus.drain(7, "3").is_empty());
        // The other inbox is untouched.
        assert_eq!(bus.drain(7, "lead").len(), 1);
    }
}
