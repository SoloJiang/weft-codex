# weft-codex

Weft 的编排能力（多仓库、issue → lead + 多 direction、thread bus、
worktree 生命周期、仓库录入与拆解、workspace/kanban），以 Codex Desktop
为宿主的重新实现。聊天表面全部委托给 Codex 原生线程；本项目只提供
编排引擎（weftd daemon）+ 嵌入 Codex Desktop 的薄 UI。

创始设计文档：[docs/specs/2026-08-08-codex-desktop-migration-design.md](docs/specs/2026-08-08-codex-desktop-migration-design.md)
（含已验证的 app-server spike 结论）。

## 结构

- `crates/app-server` — Codex app-server 客户端（从 weft 仓库移植，121 个
  wire 层测试）。含 proc_registry / engine_quota / tool_command / detect /
  proto 支撑模块。
- `crates/core` — store（SQLite，新 schema）、thread bus（MCP-over-HTTP，
  URL path 身份）、UI 事件通道。
- `crates/daemon` — `weftd` 二进制。
- `launcher/` —（Stage 3+）CDP 注入与 Weft mode 切换。
- `ui/` —（Stage 3）web app，daemon serve，可嵌入 Desktop。

## 运行

```sh
cargo build -p weftd
WEFTD_ADDR=127.0.0.1:47810 ./target/debug/weftd
# MCP endpoint: http://127.0.0.1:47810/bus/{issue}/{party}/mcp
```

`WEFT_CODEX_HOME` 可覆盖数据目录（默认 `~/.weft-codex`）。

## 验证

```sh
cargo test --workspace
```
