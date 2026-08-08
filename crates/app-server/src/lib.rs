//! Codex `app-server` client crate for weft-codex.
//!
//! Ported from the weft repo (`src-tauri/src/codex_app_server.rs` and its
//! self-contained support modules) at origin/main f8199a8. Module layout:
//!
//! - [`client`] — the JSON-RPC wire layer + global/per-session client
//!   (was `codex_app_server.rs`; `crate::lead_chat::proto::` rewritten to
//!   [`crate::proto`])
//! - [`proto`] — event model shared with notification mapping (was
//!   `lead_chat/proto.rs`)
//! - [`proc_registry`] — child-process registration / reaping
//! - [`engine_quota`] — account rate-limit snapshot hub
//! - [`tool_command`] — user command-alias overrides
//! - [`detect`] — GUI-launch PATH augmentation + tool resolution

// Panic-prone code is banned in production paths (same bar as the weft repo).
// The `not(test)` guard lets test modules use unwrap/expect freely.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod client;
pub mod detect;
pub mod engine_quota;
pub mod paths;
pub mod proc_registry;
pub mod proto;
pub mod tool_command;
