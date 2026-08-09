# weft-codex

Weft 的编排能力（多仓库、issue → lead + 多 direction、thread bus、
worktree 生命周期、仓库录入与拆解、workspace/kanban），以 Codex Desktop
为宿主的重新实现。聊天表面全部委托给 Codex 原生线程；本项目只提供
编排引擎（weftd daemon）+ 嵌入 Codex Desktop 的薄 UI。

创始设计文档：[docs/specs/2026-08-08-codex-desktop-migration-design.md](docs/specs/2026-08-08-codex-desktop-migration-design.md)
（含已验证的 app-server spike 结论）。

这是独立新项目：默认数据目录为 `~/.weft-codex`，不读取、迁移或修改原 Weft
数据，也不要求安装或运行原 Weft 客户端。

## 结构

- `crates/app-server` — Codex-only app-server 客户端，包含 wire protocol、
  proc registry、GUI PATH 解析与精简 event model；不含其他 agent engine adapter。
- `crates/core` — store（SQLite，新 schema）、thread bus（MCP-over-HTTP，
  URL path 身份）、UI 事件通道。
- `crates/daemon` — `weftd` 二进制。
- `launcher/` — 外置 Desktop Host：以专用 profile 启动官方 Codex 与 weftd，
  执行 CDP capability probes、document-start 注入、Weft 第三模式、Host Context
  与原生线程路由；不修改、重签名或覆盖官方应用。
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

检查本机 Codex 安装与 renderer 能力：

```sh
cd launcher
pnpm install
pnpm doctor
pnpm inspect-install
# 对一个已由用户启动的 loopback CDP endpoint：
node dist/cli.js probe --endpoint=http://127.0.0.1:9222

# 启动由 Host 管理的专用 Codex 实例：
pnpm start

# 或接入一个已用 loopback CDP 启动的专用实例：
node dist/cli.js attach --endpoint=http://127.0.0.1:9222
```

显式回退启动（不启动 weftd、不注入 UI）：

```sh
node dist/cli.js start --safe-mode
```

在源码 checkout 中，一条命令完成增量构建、启动官方 Codex 与注入：

```sh
./scripts/start.sh
```

安装为用户级全局 CLI（默认写入已在 PATH 中的 `~/.local/bin/weft-codex`）：

```sh
./scripts/install-cli.sh
weft-codex doctor
weft-codex
```

安装使用版本化 runtime 与稳定 wrapper，升级只切换
`~/.local/share/weft-codex/current`；因此无论从哪个目录调用，Host 都能找到同包的
`weftd` 与 Web assets。`WEFT_CODEX_PREFIX` 可覆盖默认安装前缀。

也可以从 [GitHub Releases](https://github.com/SoloJiang/weft-codex/releases)
下载预构建包；首个版本的完整安装命令见
[v0.1.0 release notes](docs/releases/v0.1.0.md)。

当前 Codex 发行版的 CSP 会阻止 loopback iframe。Host 只对专用实例启用
`Page.setBypassCSP` 并重载 renderer，UI 会显示“Desktop compatibility mode”；
Host 退出时会移除注入、关闭 bypass 并恢复 CSP 文档。Weft mode 以原生 Codex
模式为底座，Sidebar 只显示 workspace / issue / kanban / repositories，打开
Lead/Worker 时主区域切回 Codex 原生 Thread，点击 Sidebar 导航可返回工作区。

`WEFT_CODEX_HOME` 可覆盖数据目录（默认 `~/.weft-codex`）。

## 本地发行包

在 macOS 上生成自包含后台 Host（二进制内含 Bun runtime，不要求用户另装 Node）、
release 版 weftd 与 Web assets：

```sh
./scripts/build-release.sh
```

产物可运行 `./install.sh` 注册全局 `weft-codex`，也可直接使用无窗口命令
`bin/weft-codex`；无参数即完成官方 Codex 启动、
weftd 启动和 Weft mode 注入。产物写入忽略版本控制的 `artifacts/`。构建会先
执行 UI、Launcher 和 Rust 全套测试，再验证独立包内布局。Host 没有自己的应用
窗口或 Dock 图标，用户始终操作它启动的官方 Codex App；正式外部分发 Host
二进制仍需 Developer ID 签名与 Apple notarization。包内使用与回退说明见
[packaging/RELEASE-README.md](packaging/RELEASE-README.md)。

Lead/Worker 线程与 Bus 支持 daemon 重启恢复：启动时会 resume 已有 Codex
线程、重建 watcher，并重投尚未结算的 durable bus inbox；初始 Worker turn 只有
成功启动后才原子发布到看板，失败可直接重试。

## 验证

```sh
cd ui && pnpm typecheck && pnpm build && cd ..
cd launcher && pnpm typecheck && pnpm test && cd ..
cargo test --workspace
git diff --check
```
