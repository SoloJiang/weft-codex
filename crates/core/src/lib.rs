//! weft-codex product core: store, thread bus, MCP server, UI event channel.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod bus;
pub mod events;
pub mod mcp;
pub mod runtime;
pub mod store;
