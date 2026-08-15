# Repository Guidelines

## What you're working on

weft-codex: Weft 的编排能力移植到 Codex Desktop 的独立项目。Rust workspace
（`crates/`）+ 未来的 TS launcher 与 React UI。设计宪法在 `DESIGN.md`，先读它再动手。容器几何与日期规格在
`docs/specs/`，与 DESIGN.md 冲突时以 DESIGN.md 为准。

## Hard constraints

- Rust production paths return `Result`; no `unwrap` / `expect` / `panic`
  （crate 级 clippy deny 已配置，测试豁免）。
- No nested ternaries. Prefer early returns, `if` / `else if`, lookup maps,
  or `match`.
- Multi-way state: derive ONE discriminated value, then map it exhaustively.
- UI 用户可见字符串只走 i18n 双文件（en/zh），UI 落地时执行。
- 改控件外观前先读 `DESIGN.md`：宿主是真相且数值都是真机实测；视觉属性写
  `index.css`（unlayered 永远赢 Tailwind utilities，堆在组件上的视觉类不生效）。
- app-server 协议变更以 `codex app-server generate-json-schema`（本机安装
  版本）为准；协议经验记录在 spec §9。
- Bus 投递语义：活跃 turn 用 `turn/steer`，空闲用 `turn/start`；
  **活跃期间 `turn/start` 会被静默丢弃**（spike 实证）。

## Verify before you claim done

- `cargo test --workspace`
- `git diff --check`
- Daemon 冒烟：隔离 `WEFT_CODEX_HOME` 启动 weftd，curl `/healthz` 与一个
  MCP roundtrip。

## Git baseline

- Conventional commits: `feat|fix|polish|chore(scope): ...`，提交信息用中文。
- Stage explicit paths only. Never `git add -A` / `git add .`.
- docs/ 在本仓库是 tracked 设计文档（与 weft 仓库的 gitignored 习惯不同）。
