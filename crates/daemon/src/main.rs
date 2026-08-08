//! weftd — the weft-codex headless daemon (migration spec:
//! docs/specs/2026-08-08-codex-desktop-migration-design.md).
//!
//! Boots: live-mode gate → store (fresh ~/.weft-codex schema) → UI event
//! channel → thread-bus MCP server + kanban HTTP API on a STABLE address
//! (default 127.0.0.1:47810, `WEFTD_ADDR` override) → orchestrator bus
//! delivery loop → ctrl-c shutdown.

use weft_core::{
    api, bus::BusRegistry, events, mcp, orchestrator::Orchestrator, runtime, store::Store,
};

/// Log a fatal startup error and exit cleanly (no panic/unwind).
fn fatal(context: &str, err: impl std::fmt::Display) -> ! {
    eprintln!("[weftd] fatal: {context}: {err}");
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    runtime::set_live();

    let home = weft_app_server::paths::weft_home()
        .unwrap_or_else(|e| fatal("resolve weft-codex home", e));
    let store = Store::open(&home.join("weft-codex.db"))
        .await
        .unwrap_or_else(|e| fatal("open store", e));

    let (tx, _rx) = tokio::sync::broadcast::channel(256);
    events::install(tx);

    let addr = std::env::var("WEFTD_ADDR").unwrap_or_else(|_| "127.0.0.1:47810".to_string());
    let bus_base = format!("http://{addr}");

    let bus = BusRegistry::new();
    let orch = Orchestrator::new(store.clone(), bus.clone(), bus_base, home.clone());

    tokio::spawn(orch.clone().run_bus_delivery());

    let state = mcp::McpState {
        bus,
        store: store.clone(),
    };
    let app = mcp::router(state).merge(api::router(api::ApiState { store, orch }));

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| fatal(&format!("bind {addr}"), e));
    eprintln!("[weftd] thread bus MCP + kanban API on http://{addr} (http + SSE)");

    let server = axum::serve(listener, app);
    tokio::select! {
        result = server => {
            if let Err(error) = result {
                eprintln!("[weftd] server error: {error}");
            }
        }
        _ = tokio::signal::ctrl_c() => {
            eprintln!("[weftd] shutting down");
        }
    }
}
