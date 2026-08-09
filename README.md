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
- `ui/` — React + TypeScript + Vite web app；shadcn/ui 只作为可维护的
  primitive 源码层，视觉由 Codex semantic token 驱动。生产构建由 daemon
  从 `crates/daemon/web/` 提供。

## 运行

```sh
cd ui
pnpm install
pnpm build
cd ..

cargo build -p weftd
WEFTD_ADDR=127.0.0.1:47810 ./target/debug/weftd
# MCP endpoint: http://127.0.0.1:47810/bus/{issue}/{party}/mcp
```

前端开发时先启动 `weftd`，再在 `ui/` 运行 `pnpm dev`；Vite 会把 `/api`
代理到 `127.0.0.1:47810`。不要直接编辑 `crates/daemon/web/assets/`，它是
`pnpm build` 的提交产物。

`WEFT_CODEX_HOME` 可覆盖数据目录（默认 `~/.weft-codex`）。

## 验证

```sh
cd ui && pnpm typecheck && pnpm build && cd ..
cargo test --workspace
git diff --check
```
