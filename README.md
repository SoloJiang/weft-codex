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
- `launcher/` — Codex 安装检测与只读 CDP capability probes；当前不会启动、
  修改或注入官方应用，下一阶段在此实现 renderer adapter 与 Weft mode。
- `ui/` — React + TypeScript + Vite web app；shadcn/ui 只作为可维护的
  primitive 源码层，视觉由 Codex semantic token 驱动。生产构建由 daemon
  从 `crates/daemon/web/` 提供。

仓库录入支持一次提交多个本地 Git 路径。daemon 会规范化 Git 根目录、识别默认
分支与 origin、在工作区内幂等去重，并自动运行仓库画像及跨仓关系分析；UI 不需要
手工指定仓库名、`main` 或逐步触发分析。

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

同一份 React 构建支持三种 surface：

- `/?surface=standalone`：浏览器降级面，保留完整 topbar；
- `/?surface=sidebar&bridge_id=<id>`：workspace、kanban、仓库、issue 与
  attention 的全局导航；
- `/?surface=workspace&bridge_id=<id>`：无重复 topbar 的主工作区。

相同 `bridge_id` 的 sidebar / workspace 会同步 workspace、路由和命令。

只读检查本机 Codex 安装与 renderer 能力：

```sh
cd launcher
pnpm install
pnpm inspect-install
# 对一个已由用户启动的 loopback CDP endpoint：
node dist/cli.js probe --endpoint=http://127.0.0.1:9222
```

`WEFT_CODEX_HOME` 可覆盖数据目录（默认 `~/.weft-codex`）。

## 验证

```sh
cd ui && pnpm typecheck && pnpm build && cd ..
cd launcher && pnpm typecheck && pnpm test && cd ..
cargo test --workspace
git diff --check
```
