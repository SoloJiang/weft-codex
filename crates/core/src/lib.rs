//! weft-codex product core: store, thread bus, MCP server, UI event channel.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod api;
pub mod brief;
pub mod bus;
pub mod events;
pub mod mcp;
pub mod orchestrator;
pub mod runtime;
pub mod store;
pub mod worktree;
