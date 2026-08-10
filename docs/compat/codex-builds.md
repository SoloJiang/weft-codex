# Codex Desktop 构建兼容矩阵（2026-08-10 起）

本文件是 **N0-05（#6）CI 回归信号的数据源**，不是叙事文档。每次在新安装的
`/Applications/ChatGPT.app` 上重跑 launcher probe 或 `docs/spike-app-server/`
探针后，把结果**追加**为新行；**不要改写历史行**——历史行就是回归基线。CI 对
§2 做逐行 diff：同一 `anchor id` 在相邻 build 之间 `ok` 由 `true → false`，即判定
为兼容性回归。

## 0. 两条独立版本轴

这两条轴**互不隐含**，不要因为其中一条复验过就认为另一条也复验过。

- **Desktop bundle 轴**：`/Applications/ChatGPT.app` 的 `CFBundleShortVersionString`
  与 `CFBundleVersion`。影响 CDP 注入、DOM/CSS token 锚点、CSP / `frame-src`、
  `codex://` scheme、原生菜单结构。对应 §1 / §2 / §3。
- **app-server 协议轴**：`weftd` 经 `WEFT_CODEX_COMMAND`（默认 `codex`，见
  `crates/app-server/src/command.rs`）在 `$PATH` 上解析并 spawn 的独立 `codex`
  CLI / `app-server` 子进程版本，与 Desktop bundle 版本**不保证同步**。影响
  `turn/steer` vs `turn/start`、`threadSource` 落库、跨进程 turn 通知。对应 §4。

`weftd` 从不通过 ChatGPT.app 内嵌的二进制说话，四个 spike 脚本也都是
`create_subprocess_exec("codex", "app-server", ...)`。因此 Desktop build 从 6119
升到 6321，**并不自动**让协议结论失效，也**不自动**让它们重新生效。

## 1. 已验证 Build 一览

| Desktop 版本 | Build | Tier | 验证日期 | 验证方式 | 结果 |
|---|---|---|---|---|---|
| 26.727.51351 | 6119 | `weft-mode` | 2026-08-08 / 2026-08-09 | 真机 launcher probe + Stage 2–4 真机闭环 | **PASS**（见 spec §7.5 / §9 / §10） |
| 26.803.41515 | 6321 | `weft-mode` | 2026-08-10 | `node dist/cli.js probe --endpoint=… --target-url='app://-/index.html'`，专用 profile + `--safe-mode`（无注入、无 weftd）；CSP 与协议轴另测，见 §3 / §4 | **PASS**，但有 3 项假阳性/语义问题，见 §5 |

> Tier 取值与 `launcher/src/probes.ts` 的 `CompatibilityTier` 一致：
> `safe-mode`（base 锚点缺失，不注入）/ `additive`（subtractive 锚点缺失，只追加
> 入口，不改造原生 sidebar）/ `weft-mode`（全部通过）。
>
> 6321 这一行是在**未注入**的纯净原生 DOM 上采集的（`injection.mode === null`、
> 无 `weft-codex-*` 根节点与样式），因此测到的是宿主自身结构，不含 Weft 影响。

## 2. Desktop DOM / token 锚点矩阵

逐 `build × anchor` 一行（tidy 格式）：新增 build 只追加行，diff 天然落在单个交叉
点上。`anchor id` 与 `requiredFor` 直接取自 `launcher/src/probes.ts` 的 `SELECTORS`、
`TOKEN_PROBES` 与 `reportFromSnapshot`，**不要另造命名**。

`ok` 列取值：`true` / `false` / `未记录`。**`未记录` 不等于 `true`**——它表示当时没有
逐锚点留证，不能作为回归基线使用。

`requiredFor` 列记录**该次采集时生效的分级**。2026-08-10 的重分级（`projectCreate` /
`threadRow` / `threadRoute` 由 `optional` 升为 `subtractive`，并新增 `threadActive`）
只体现在 6321 行；6119 行保留当时的 `optional`，因为那才是当时的真实判定依据。

| Build | Anchor id | requiredFor | ok | 依据 / 实测 |
|---|---|---|---|---|
| 6119 | `renderer.root` | base | true | 由 tier 反推：达到 `weft-mode` 蕴含全部 base 通过 |
| 6119 | `renderer.main` | base | true | 同上（6119 未区分 inert 路由，见 §5） |
| 6119 | `sidebar.scroll` | base | true | spec L455 明确列出该语义属性 |
| 6119 | `sidebar.section` | base | true | spec L455 明确列出 |
| 6119 | `sidebar.heading` | additive | true | spec L455 明确列出 `section-heading` |
| 6119 | `sidebar.projectCreate` | optional | **未记录** | spec L455 只记录了 `project-row`，未记录 `project-create`（6321 已证实两者都存在，见 §5） |
| 6119 | `sidebar.threadRow` | optional | true | spec L455 明确列出 `thread-row` |
| 6119 | `sidebar.threadRoute` | optional | true | spec L465–472：deep-link 实测命中 `data-app-action-sidebar-thread-id` |
| 6119 | `mode.switcher` | subtractive | true | spec L330–334：原生菜单实测 ChatGPT / Codex，Weft 注入为第三项 |
| 6119 | `host.locale` | additive | true | 由 tier 反推 |
| 6119 | `titlebar.dragRegion` | optional | **未记录** | optional 探针失败不影响 tier，无法由 `weft-mode` 反推 |
| 6119 | `theme.*`（18 个 token） | additive | true | 由 tier 反推：任一 additive token 缺失会降到 `safe-mode` |
| 6321 | `renderer.root` | base | true | `#root` |
| 6321 | `renderer.main` | base | true | **假阳性风险**：文档中同时存在 2 个 `main`，见 §5 |
| 6321 | `sidebar.scroll` | base | true | n=1 |
| 6321 | `sidebar.section` | base | true | n=2 |
| 6321 | `sidebar.heading` | additive | true | n=2 |
| 6321 | `sidebar.projectCreate` | subtractive | true | n=1，属性确实存在（同时 `project-row` n=4） |
| 6321 | `sidebar.threadRow` | subtractive | true | n=24 |
| 6321 | `sidebar.threadRoute` | subtractive | true | n=24 |
| 6321 | `sidebar.threadActive` | subtractive | true | n=24；2026-08-10 新增探针，语义经真实点击验证（§5.1） |
| 6321 | `mode.switcher` | subtractive | true | `nav` 作用域内、排除 sidebar 后恰好 1 个触发器（文档内共 9 个同形按钮）；触发器 `id` 为 `radix-_r_3_`（Radix 自动生成，非空） |
| 6321 | `host.locale` | additive | true | `en-GB` |
| 6321 | `titlebar.dragRegion` | optional | true | 文档内 3 个；`main[0]`（inert）内 1 个、`main[1]`（可见）内 2 个。探针已改为**可见 main 作用域**，实测 2 个 |
| 6321 | `theme.sidebarSurface` | additive | true | `#f2f2f3` |
| 6321 | `theme.mainSurface` | additive | true | `#fafafa` |
| 6321 | `theme.dropdownSurface` | additive | true | `rgb(251, 251, 251)` |
| 6321 | `theme.foreground` | additive | true | `#383a42` |
| 6321 | `theme.secondaryText` | additive | true | `color-mix(in srgb, #383a42 65%, transparent)` |
| 6321 | `theme.border` | additive | true | `rgba(56, 58, 66, 0.078)` |
| 6321 | `theme.borderHeavy` | additive | true | `rgba(56, 58, 66, 0.117)` |
| 6321 | `theme.primary` | additive | true | `#526fff`（6119 记录为 `#0169cc`，主色已变） |
| 6321 | `theme.buttonForeground` | additive | true | `#fafafa` |
| 6321 | `theme.linkForeground` | additive | true | `#526fff` |
| 6321 | `theme.inputBackground` | additive | true | `rgba(251, 251, 251, 0.96)` |
| 6321 | `theme.inputBorder` | additive | true | `rgba(56, 58, 66, 0.117)` |
| 6321 | `theme.hoverBackground` | additive | true | `rgba(56, 58, 66, 0.053)` |
| 6321 | `theme.fontSans` | additive | true | `Maple Mono NF CN, -apple-system, …`（受用户字体设置影响，非稳定基线） |
| 6321 | `theme.fontMono` | additive | true | `Maple Mono NF CN, ui-monospace, …`（同上） |
| 6321 | `theme.radiusLarge` | additive | true | `calc(.625rem * 1.25)` |
| 6321 | `theme.radiusMedium` | additive | true | `calc(.5rem * 1.25)` |
| 6321 | `theme.radiusSmall` | additive | true | `calc(.375rem * 1.25)` |

### 2.1 已使用但未被探测的锚点（升级盲区）

renderer agent 在运行时依赖、但 `SELECTORS` 完全没有覆盖的锚点。Codex 升级若改动
这些，probe 会全绿而功能已坏。

| 锚点 | 运行时用途 | 6119 | 6321 实测 |
|---|---|---|---|
| `[data-app-action-sidebar-thread-active="true"]` | `activeThreadId()`（`renderer-agent.ts:511`）读取"当前 thread"，是 ThreadBinding（#4）解析 Issue 的唯一入口 | 未记录 | **已补探针**：2026-08-10 加入 `SELECTORS`（`sidebar.threadActive`，`subtractive`）。属性存在（n=24），真实点击验证语义正确，见 §5.1 |
| `[data-app-action-sidebar-thread-selected]` | 当前**无任何运行时消费者**，故不单独建探针（探针只能断言存在，无法断言它与 `thread-active` 一致） | 未记录 | 属性存在（n=24），点击后与 `thread-active` 同步翻 `true` |
| `nav`（`sidebar.scroll` 的祖先） | 定位模式菜单触发器的作用域 | 未记录 | 存在（n=1） |
| `button[aria-haspopup="menu"][aria-expanded][data-state]` | 模式菜单触发器 | 未记录 | 文档内 n=9；`nav` 作用域内排除 sidebar 后 n=1 |
| `button.id`（模式触发器的 id） | `associatedModeMenu()` 靠 `aria-labelledby === button.id` 配对；缺 id 时 `ensureNativeCodexMode` 会强制 safe mode | 未记录 | **已补探针**：2026-08-10 起并入 `mode.switcher` 判定。实测 `radix-_r_3_` 非空。注意这是 Radix `useId` 生成的值，**不是稳定标识**，只能断言非空，不得断言具体值 |
| `[role="menu"]` / `[role="menuitem"]` | 注入 Weft 第三模式项、克隆原生条目样式 | 未记录 | 按需渲染：关闭时 n=0，展开后 menu=1 / menuitem=2。**已用真实点击验证**，renderer agent 的全部结构假设成立，见 §2.2。被动探针仍无法覆盖，归 #6 |
| `header` 内 `-webkit-app-region: drag` | workspace overlay 顶部偏移 | 未记录 | **已修作用域**：探针原为全文档（n=3），运行时只在 `main` 内查；2026-08-10 起探针改为"可见 `main` 作用域"，与运行时一致，实测 n=2 |

### 2.2 交互式验证（被动探针覆盖不到的部分）

模式菜单按需渲染，快照探针永远看不到它。2026-08-10 用 CDP 真实指针事件展开菜单后
逐条核对了 renderer agent 的结构假设——**全部成立**：

| renderer agent 的假设 | 代码位置 | 6321 实测 |
|---|---|---|
| 触发器 `id` 与菜单 `aria-labelledby` 配对 | `associatedModeMenu()`，`renderer-agent.ts:417` | 成立：菜单 `aria-labelledby = radix-_r_3_` = 触发器 id |
| 展开后存在 `[role="menu"]` | `renderer-agent.ts:414` 等 | 成立：menu=1，menuitem=2 |
| 原生条目可作克隆模板 | `renderer-agent.ts:461` | 成立：两项分别为 `ChatGPT` / `Codex` |
| 条目内叶子 `span` 承载文案 | `renderer-agent.ts:471` | 成立：每项 2 个叶子 span（标题 + 副标题），如 `["Codex", "Build, debug, and ship"]` |
| `/^Codex/i` 能命中 Codex 项 | `renderer-agent.ts:429`、`renderer-host.ts:223` | 成立 |
| 选中项带直接子 `svg`（原生勾选图标，需隐藏） | `renderer-agent.ts:491` | 成立且**只在选中项上**：Codex 项 svg=1、`hasDirectIconSvg=true`；ChatGPT 项 svg=0 |

按 `Escape` 后菜单干净收起（menu=0、`aria-expanded=false`），验证过程未残留状态。

> 这张表是**一次性人工验证记录**，不是回归基线——它依赖真实交互，CI 的被动探针复现
> 不了。要长期守住这些假设，需要 #6 用可交互的回归套件重放同一串操作。

## 3. CSP / `frame-src` 行为矩阵

单独建表：这是 Chromium / CDP 层行为，不是某个 `data-app-action-*` selector，混进
§2 会让 `ok` 的语义变味。

| Build | `frame-src` 阻止 loopback iframe？ | 首次握手失败并触发 bypass 分支？ | bypass 需先启用再 reload？ | 退出恢复验证 | 依据 |
|---|---|---|---|---|---|
| 6119 | 是 | 是（走 `renderer-host.ts` 的 fallback 路径） | 是（对已提交文档不追溯生效） | 通过 | spec L335–338、L452–459 |
| 6321 | **是** | 是（同 6119，必然进入 fallback） | **是** | **通过** | 2026-08-10 直接测量，见下 |

6321 的四列是用 `securitypolicyviolation` 事件直接测的，不是靠观察 launcher 是否进入
bypass 分支反推——后者只能间接推断，前者拿得到策略原文。四步实测结果：

| 步骤 | loopback iframe 被拦？ |
|---|---|
| baseline（未开 bypass） | **是**，`violatedDirective: frame-src`，`disposition: enforce` |
| `Page.setBypassCSP(true)`，**不** reload | **仍被拦** → 对已提交文档不追溯生效 |
| `Page.setBypassCSP(true)` + `Page.reload` | **不再被拦** → 必须先启用再 reload |
| `Page.setBypassCSP(false)` + `Page.reload` | **恢复拦截** → 退出恢复有效 |

策略经 `<meta http-equiv>` 下发（这正是它不追溯生效的原因：meta 在文档 commit 时解析），
6321 实测 `frame-src` 白名单为：

```
frame-src 'self' blob:
  codex-sandbox://*.web-sandbox.oaiusercontent.com
  codex-sandbox://web-sandbox.oaiusercontent.com
  https://*.web-sandbox.oaiusercontent.com
  https://web-sandbox.oaiusercontent.com;
```

其中**没有** `http://127.0.0.1`，文档 origin 为 `app://-`。结论：6321 与 6119 行为一致，
`Page.setBypassCSP` 仍然必要，spec L335 的断言可以从「当前 build 6119」改写为
「6119 与 6321 均如此」。

> 注意一个观测陷阱：被 CSP 拦截的 iframe 仍会触发 `load` 事件（停在 `about:blank`），
> 且跨域访问 `contentWindow.location` 无论放行与否都抛 `SecurityError`。因此判定必须
> 依据 `securitypolicyviolation` 事件，不能依据 `load`/`error` 或能否读到 location。

## 4. app-server 协议矩阵

按 `codex` CLI / app-server 版本分组，**不按 Desktop build 分组**。「对应 Desktop
build」列只作交叉参考，不表示绑定关系。

| `codex` 版本 | 探针 | 关键结论 | 对应 Desktop build | 日期 |
|---|---|---|---|---|
| 0.145.0 | `spike.py`（S5） | 活跃 turn 期间 `turn/start` 静默丢弃（返回成功但从不执行）；必须用 `turn/steer { threadId, expectedTurnId, input }` | 6119（同期机器） | 2026-08-08 |
| 0.145.0 | `probe_thread_source.py` | 无 `--session-source` 旗标；`thread/start { threadSource }` 原样落库到 `threads.thread_source`；`threads.source` 恒为 `"vscode"` | 6119（同期机器） | 2026-08-09 |
| 0.145.0 | `probe_turn_started.py` | 同进程 `turn/started` 必然到达（启动确认防线的前提） | 6119（同期机器） | 2026-08-09 |
| 0.145.0 | `probe_takeover.py` | turn 生命周期通知不跨 app-server 进程；第二进程接管时己方 watcher 收不到对方的 `turn/started` / `turn/completed` | 6119（同期机器） | 2026-08-09 |
| 0.145.0 | *（未重跑脚本）* | `codex --version` 实测仍为 `0.145.0`，**与 spike 时同一版本**，因此上面四行的协议结论按版本沿用，无需重跑消耗 turn 的脚本。改用零副作用的结构核对：`codex app-server generate-json-schema --out` 生成 39 个文件 / v2 共 532 个定义，逐一确认结论所依赖的形状仍在（见下） | 6321 | 2026-08-10 |

2026-08-10 的结构核对结果（v2 schema）：

| 定义 | 实测字段 | 对应结论 |
|---|---|---|
| `TurnSteerParams` | `threadId`, `clientUserMessageId`, `expectedTurnId`, `input` | 与 spec `turn/steer { threadId, expectedTurnId, input }` 一致，活跃期注入路径未变 |
| `ThreadStartParams` | 含 `threadSource`、`sessionStartSource` | `threadSource` 杠杆仍在 |
| `TurnStartParams` | 含 `outputSchema` | 结构化产出管线未变 |
| `ThreadResumeParams` | 含 `threadId` | 读完整历史仍走 `thread/resume` |
| `TurnStartedNotification` | `threadId`, `turn` | 启动确认防线的前提仍在 |

协议漂移基线（39 个 schema 文件的组合 sha256，供 CI diff 用）：

```
35f55ce111453c826d3ad43d940e8c299cd016060c1dc7ed2847cad63c06986a
```

> 这条哈希才是协议轴的回归信号。**注意它只证明形状未变，不证明运行时行为未变**——
> 「活跃 turn 期间 `turn/start` 被静默丢弃」这类语义结论无法从 schema 读出，只有重跑
> `spike.py` 才能复验。版本号相同时沿用是合理的；版本号一旦变化，必须重跑四个脚本
> 而不是只比哈希。

> 重跑步骤：先 `codex --version` 记录版本号，再依次跑 `spike.py` →
> `probe_thread_source.py` → `probe_turn_started.py` → `probe_takeover.py`，结果追加
> 新行。**若 `codex` 版本与上次不同，即使 Desktop build 未变也要单独建行**——这正是
> 本表与 §1–§3 分轴的原因。

## 5. 已知增量与问题（6119 → 6321）

只记录**已确认**的差异与问题。

### 5.1 `thread-active` 语义：静态分析曾误判，运行时已澄清

`renderer-agent.ts:511` 用 `[data-app-action-sidebar-thread-active="true"]` 判定"用户
当前所在的 thread"，据此填充 `HostContextV1.threadId`——这是 #4 把原生 Thread 解析回
Issue 的唯一输入。

**运行时结论（2026-08-10，真实点击验证）：该判定在 6321 上是正确的。**

连续点击三个会话行，`thread-active` 与 `thread-selected` 每次都**同时**翻成 `true`，
且始终只落在同一行：

| 操作 | `active="true"` 的行 | `selected="true"` 的行 |
|---|---|---|
| 初始（无会话打开） | 无 | 无 |
| 点第 1 行 | `local:019fe0f9…` | `local:019fe0f9…` |
| 点第 3 行 | `local:019fbde4…` | `local:019fbde4…` |
| 点第 6 行 | `local:019f889b…` | `local:019f889b…` |

> **订正记录**：本节初稿依据 bundle 静态分析断言 `thread-active` 语义是"有活跃 turn
> 在跑"、`activeThreadId()` 已失效。该结论**是错的**。当时的依据是两点：二者是同一
> 组件的两个独立 prop（`String(active)` / `String(selected)`），且只有 `selected` 带
> `=true` 的选中态样式。这两点事实本身成立，但**推不出**语义分离——采集时恰好没有
> 任何会话打开，两者全为 `"false"`，静态证据被过度解读了。真实点击推翻了它。
>
> 教训：属性是否存在可以静态求证，属性的**语义**必须运行时验证。

仍然成立的问题是**探针覆盖**，而不是语义：`thread-active` 此前完全不在 `SELECTORS`
里，而它是 Issue 解析的唯一输入。2026-08-10 已补为 `sidebar.threadActive`
（`subtractive`）。

尚未验证的边界：二者既然是独立 prop，理论上可能解耦（例如多窗口、或路由切换过程中的
瞬时状态）。本次三次切换均未观察到解耦。探针只能断言属性存在、无法断言二者一致，
所以若 #4 要依赖"二者等价"这一点，应由 #6 的回归套件用真实点击守住。

### 5.2 `renderer.main` 是假阳性（6321 新增）

6321 的路由过渡会同时保留两个 `main`：

| index | display | visibility | pointerEvents | inert/aria-hidden | 可见面积 |
|---|---|---|---|---|---|
| 0 | flex | **hidden** | **none** | **是** | 950400 |
| 1 | flex | visible | auto | 否 | 735302 |

裸 `querySelector("main")` 命中 index 0——即那个**不可见、不可交互、inert** 的旧路由。
注意隐藏的那个**可见面积反而更大**，所以仅按面积排序的启发式同样会选错；必须先按
`inert` / `aria-hidden` / `hidden` / `visibility` / `pointerEvents` 过滤，再按面积取最大。

探针当前只判断 `Boolean(document.querySelector("main"))`，因此 `renderer.main` 报
`ok: true` 并不能保证 workspace 能挂到正确的路由上。

> 该修复由 `visibleMainRoute()` 实现（`VISIBLE_MAIN_HELPERS_SOURCE`，probe 与 renderer
> agent 共用同一套判定），随 `76bdbd3` 合入。本条记录用于说明为什么 6321 那次采集的
> `renderer.main: ok` 不可直接作为基线——当时探针还是裸 `querySelector("main")`。
>
> `titlebar.dragRegion` 的作用域修复已收敛到同一个 helper：探针现在只在
> `visibleMainRoute()` 返回的那个 route 内查找拖拽区域，与 `ensureWorkspaceRoot` 的
> 挂载目标完全一致，不再有第二份 inert/visibility 判定。

### 5.3 CDP target 选择在 6321 上不再唯一

6321 的应用会同时暴露两个 page target：

```
page  Codex  app://-/index.html
page  Codex  app://-/index.html?initialRoute=%2Favatar-overlay
```

`selectRendererTarget` 要求唯一命中，因此**不带 `--target-url` 的 probe 直接失败**：

```
weft-codex: Could not select one renderer target. Candidates: Codex (app://-/index.html?initialRoute=%2Favatar-overlay), Codex (app://-/index.html)
```

这是 fail-closed（不会误挂到 overlay），行为正确，但意味着任何自动化路径都必须显式
指定 target。overlay target 出现时机晚于主 target，所以启动早期可能只看到一个——
自动化不能依赖"只有一个 target"这个假设。

### 5.4 `sidebar.projectCreate` 探针命中真实属性（澄清）

6321 实测 `data-app-action-sidebar-project-create` 确实存在（n=1），
`data-app-action-sidebar-project-row` 也存在（n=4）。spec L455 当年只记录了后者，
造成"探针查的属性可能不存在"的疑虑——**该疑虑不成立**，探针命中的是真实属性。
因此把它升级为 `subtractive` 不会把所有安装钉死在 `additive`。

### 5.5 模式触发器的 id 由 Radix 生成

6321 实测模式切换触发器的 `id` 为 `radix-_r_3_`——Radix `useId()` 的产物，随渲染树
结构变化，**不是稳定标识**。`associatedModeMenu()` 只用它做 `aria-labelledby` 配对，
不依赖具体值，所以探针只断言"非空"。任何把该 id 硬编码或写进回归基线的做法都会在
下一次 Codex 结构调整时误报。

### 5.6 主色变更

`--color-token-primary` 与 `--color-token-text-link-foreground` 从 6119 的 `#0169cc`
变为 6321 的 `#526fff`。属正常主题演进，Host Context 已按 token 转发，无需代码改动；
记录在案以便回归时区分"token 消失"与"token 变值"。

### 5.7 字体 token 不是稳定基线

`theme.fontSans` / `theme.fontMono` 实测首位是 `Maple Mono NF CN`——用户本机字体设置
的产物，不同机器不同。这两项只应断言"非空"，不得断言具体值。

### 5.8 锚点分两类：结构依赖 vs 数据依赖

2026-08-10 的重分级把 `sidebar.threadRow` / `threadRoute` / `threadActive` 升为
`subtractive`，**这是错的**，当天即修正。

这三个锚点挂在会话行上，而会话行是**用户数据**：一个全新 profile 渲染出的 sidebar
完全健康，只是没有行可以承载这些属性。实测（移除全部 24 行模拟新 profile）：

| 场景 | 修正前 | 修正后 |
|---|---|---|
| 有会话 | `weft-mode` | `weft-mode` |
| 无会话（新 profile） | **`additive`** | `weft-mode` |
| 有会话但属性被改名 | `additive` | `additive` |

也就是说修正前**每一个新用户都会被永久钉在 Tier 1**。探针把"Codex 改了属性"和
"这个用户还没开始聊天"当成了同一件事。

修正方式是引入"不适用"：`threadRowCount === 0` 时这三条报 ok 并注明未验证，而不是
报失败。代价是明确的——如果 Codex 改的正是行属性本身，无会话的 profile 察觉不到；
但只要有一条会话就能察觉，且 §6 的演练直接覆盖改名场景。

同批修正的还有 `renderer-host.ts` 的 hydration 重试：它原本只在 `safe-mode` 时重试，
而 Codex 会先画出 sidebar 外壳再填会话列表（CSP reload 之后会再来一次），探针落在
这个窗口就会把整个会话钉在 `additive` 且不再重试。现改为在低于 `weft-mode` 时持续
重试到同一个 deadline。

**给后来者的判据：给一个锚点定 `requiredFor` 之前，先问它的缺失是否可能由用户数据
造成。会的话，它就不能无条件参与分级。**

## 6. 升级回归演练

单测能断言分级表与本文件一致，但断言不了"我们分级的锚点在发行版里真的存在"，
也断言不了"少一个锚点时真的会降级"。这两件事由 `scripts/upgrade-drill.mjs` 覆盖：
它在活的 renderer 上改掉锚点属性名（模拟一次 Codex 升级），走**真实探针管线**
（`buildProbeExpression` + `reportFromSnapshot`）读出 tier，然后还原。

```
node launcher/dist/cli.js start --safe-mode --debug-port=9227 --profile-dir=/tmp/weft-codex-drill
node scripts/upgrade-drill.mjs 9227
```

**不要对着日常使用的 Codex 跑**——它会改 DOM 属性。脚本每次都还原，并在结尾复验
tier 已回到基线；但中途崩溃会留下被改过的 renderer，重新加载窗口即可恢复。

### build 6321 实测（2026-08-10）

| 步骤 | tier | 失败探针 |
|---|---|---|
| 基线 | `weft-mode` | 无 |
| 改名 `data-app-action-sidebar-thread-id`（22 个节点） | **`additive`** | `sidebar.threadRoute(subtractive)` |
| 还原 | `weft-mode` | 无 |
| 改名 `data-app-action-sidebar-scroll`（1 个节点） | **`safe-mode`** | `sidebar.scroll(base)`、`mode.switcher(subtractive)` |
| 还原 | `weft-mode` | 无 |

两点值得记下：

- 这条演练同时证明了 2026-08-10 的重分级是有效的。`sidebar.threadRoute` 原为
  `optional`，同样的改名在重分级之前会让 tier **纹丝不动**——正是"全绿着坏掉"。
- base 锚点失效会**级联**让 `mode.switcher` 一起失败：模式触发器的发现作用域是
  `sidebar.closest("nav")`（`renderer-agent.ts`），sidebar 找不到时触发器也就找不到。
  因此 `mode.switcher` 的失败不一定代表菜单本身有问题，排障时应先看 `sidebar.scroll`。

## 7. 维护规则

- 只追加，不改写历史行。需订正历史行时另起一行并注明「订正 YYYY-MM-DD，原行见上」，
  保留可审计轨迹。
- `ok` 只有 `true` / `false` / `未记录` 三种取值；**禁止把未留证的锚点填成 `true`**。
- 采集必须在 `--safe-mode`、专用 profile、未注入的条件下进行，否则测到的是 Weft 自己
  改过的 DOM。若某项只能在注入路径下观测（如 §3 的 CSP），单独标注采集条件。
- Anchor id 与 `launcher/src/probes.ts` 完全一致。**这条由测试强制**：
  `probes.test.ts` 的「the compatibility matrix documents every probe of the newest
  build」会解析 §2 中 build 号最大的那组行，与 `reportFromSnapshot` 的实际输出对账；
  新增探针未补文档行、或改了 `requiredFor` 未同步，都会让测试失败。因此本文件不是
  可选文档，而是构建的一部分。
- spec `docs/specs/2026-08-08-codex-desktop-migration-design.md` 中的 build / 协议版本
  断言，在重大版本变更后应指回本文件，而不是在 spec 正文里继续累积日期戳。
