# launcher

Codex Desktop 的外置 Host。它不修改、重签名或覆盖官方应用，而是：

- 以独立 profile 和仅 loopback 可见的 CDP 端口启动官方 Codex；
- 启动或复用 weftd；
- 对当前发行版执行语义 capability probe；
- 在 document-start 安装可重挂载的 Renderer Agent；
- 将 Sidebar / Workspace iframe、Host Context、Weft 第三模式与原生线程路由接入；
- 退出时移除注入并回收自己启动的 Codex 与 weftd 子进程。

基础检查：

```sh
pnpm install
pnpm doctor
pnpm inspect-install
node dist/cli.js probe --endpoint=http://127.0.0.1:9222
```

启动完整专用实例：

```sh
pnpm start
```

不带命令运行 `weft-codex` 也会直接启动；`weft-codex --safe-mode` 只打开专用
profile 的官方 Codex，不启动 weftd、不做任何 renderer 注入。旧名字
`weft-codex-host` 仅保留为开发兼容别名。

接入一个已经以 CDP 启动的专用实例：

```sh
pnpm attach -- --endpoint=http://127.0.0.1:9224
```

常用覆盖项均使用 `--name=value`：`app-path`、`profile-dir`、`debug-port`、
`weftd-url`、`weftd-path`、`web-dir`、`weft-home`、`web-url`、`target-url`、
`mode=work|codex|weft`。`--once` 只做一次注入验收并立即清理。

发行包会优先从自身 `bin/ + share/weft-codex/web/` 解析 runtime，不依赖源码
checkout；开发态才回退到仓库的 `target/` 与 `crates/daemon/web/`。Host 只是
后台启动与注入进程，不提供第二个 App 表面。

任何 base/additive capability 失败都会进入 safe mode；模式切换器不匹配时只降级为
additive，并保留自有 Weft 入口。只有 iframe 被当前发行版 CSP 阻止时，Host 才对
这个专用实例启用 CSP bypass，同时通过 Host Context 向 UI 暴露该安全状态。
