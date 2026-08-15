# Weft 容器架构：Host Slot Layout（2026-08-13）

状态：阶段 1–5 已落地，并被 2026-08-14/15 Desktop 真机复验修正。
**现行设计判断以仓库根目录 [DESIGN.md](../../DESIGN.md) 为准。**
本文仍保留槽位表与 action 形状；其中「workspace 下隐藏 side panel / 详情自绘抽屉 / 与 Diff 互斥」已过时——详情和 Chats 共用原生 `right-panel`，并复用 Diff 拉伸条。
取代：`2026-08-08-codex-desktop-migration-design.md` §7.5 / §7.6 里
「Weft 作为第三模式 + workspace 全铺 overlay」的容器模型。
不改：weftd store、编排、thread_binding、bus、worktree。
关联：`2026-08-13-lead-chat-conversation-popover.md`（会话浮层变成
conversation 层，不再承担详情）。

## 1. 问题

当前 Desktop 容器把三件不同的事揉成了一根 `mode × view` 轴：

1. **产品过滤**：要不要用 Weft 的 issue / kanban / 会话归属；
2. **主区所有权**：此刻主区是 Kanban，还是 Codex 原生聊天；
3. **原生 chrome 所有权**：标题栏、底栏、右侧 inspector、New chat
   到底谁说了算。

实现上又只做了两件事：用 CSS 把原生会话列表藏掉，再把 workspace
iframe 以 `position: absolute; inset: 46px 0 0 0; z-index: 20`
盖住整个 `main`。结果是：

- Work / Codex / Weft 看起来像三个对等模式，实际上 Weft 只是罩在
  Codex 底座上的过滤层；
- 原生「Toggle bottom panel / Toggle side panel」还在，底栏能漏出来，
  右侧 inspector 会被 overlay 盖住；
- 详情被做成 workspace 里的整页 `view=issue`，一点卡片就离开看板；
- 每多一个浮层（modal / popover / 将来的 drawer）都要再和这层盖法打架。

根因不是少一块 UI，而是 **host 没有窗口管理，只有隐藏和覆盖**。

## 2. 判断

1. **Weft 不是第三种产品模式。** Work 与 Codex 仍是 Codex 自己的模式；
   Weft 是罩在 Codex 底座上的 `filter`。菜单里继续叫 Weft，内部不再
   把它和 Work/Codex 对等。
2. **host agent 是窗口管理器。** 它只做一件事：给每个槽位指定唯一
   owner（`native` / `weft` / `empty`），并按 owner 挂载或让位。
   Weft 绝不绘制自己未拥有的槽位。
3. **主区一次只属于一个 stage。** `workspace` 与原生 `thread`
   互斥。workspace iframe 不再盖住原生聊天，也不再盖住底栏 / 右侧槽。
4. **详情是右侧 inspector，不是 workspace 路由。** Desktop 上取消
   整页 `view=issue`；standalone 浏览器没有 host 槽位，才保留整页
   详情作为降级。
5. **Weft 详情占用原生 `right-panel`，不自绘主区抽屉。** 内容仍是
   独立 `inspector` iframe，但挂在 Codex 的 side panel 里，和 Chats /
   Diff 共用同一槽、同一颗 Toggle side panel、同一条拉伸条。不要点开
   Diff 再盖一层，也不要把整个 Diff 骨架 `display:none` 掉。

## 3. 槽位

窗口拆成固定槽位。槽位是几何与所有权，不是 React 路由。

| 槽位 | 几何 | 允许的 owner | 职责 |
|---|---|---|---|
| `chrome` | 标题栏、拖拽区、红绿灯 | 永远 `native` | 窗口控制；Weft 只允许在这里挂一个不抢 drag 的入口 |
| `nav` | 左侧栏滚动区 | `weft`（filter 开）/ `native`（filter 关） | Weft：workspace / issue 导航。原生：会话列表 |
| `stage` | 主区，扣除 inspector 与底栏 | `weft-workspace` / `native-thread` | Kanban、仓库，或原生 Lead/Worker 聊天 |
| `inspector` | 主区右侧一条 | `weft-detail` / `native-inspector` / `empty` | Weft issue 详情，或 Codex 原生 inspector |
| `dock` | 主区底部 | 永远 `native` | 源目录 / bottom panel。Weft 只观察并让位 |
| `conversation` | stage 右上浮层 | `weft` 或 `empty` | 当前 issue 的会话树。不占布局流 |
| `modal` | 视口固定 | `weft` 或 `empty` | 创建 workspace / issue / 选仓库。不进任何 iframe 内容 |

约束：

- 每个槽位同一时刻只有一个 owner。
- `conversation` 与 `modal` 是层，不是流式槽；它们可以盖住 stage，
  但不能改变 `nav` / `dock` / `chrome` 的几何。
- `inspector` 是流式槽：打开时 **压缩 stage**，而不是盖在 stage 上。
- workspace iframe 的矩形 = `stage` 的矩形。禁止再写成「从标题栏
  铺到窗口底」。

## 4. 单一布局状态

删掉互相正交的 `mode × view`。host 只保留一个判别对象：

```ts
type HostLayout = {
  filter: "off" | "weft"
  nativeMode: "work" | "codex"
  stage: "workspace" | "thread"
  inspector: { owner: "weft"; issueId: number } | { owner: "native" } | null
  conversation: "closed" | "open-auto" | "open-pinned"
  modal: ActiveDialogState | null
  dock: "closed" | "open"          // 只读，观察原生 bottom panel
  navCollapsed: boolean            // 只读，观察原生 sidebar 宽度
}
```

映射规则穷举：

| filter | stage | inspector.owner | 用户看见 |
|---|---|---|---|
| off | * | * | 原生日历：Work 或 Codex，Weft 表面全部卸载 |
| weft | workspace | null | 左栏 Weft 导航 + Kanban/仓库；右侧空 |
| weft | workspace | weft | 同上，stage 被右侧详情抽屉挤窄 |
| weft | workspace | native | 不允许。workspace 下 side panel 只承载 Weft 详情，不打开 Diff |
| weft | thread | null | 左栏 Weft 导航 + 原生聊天；可开 conversation 浮层 |
| weft | thread | weft | 原生聊天被右侧详情挤窄；conversation 关闭 |
| weft | thread | native | 仅当用户明确只要 Diff 时。Weft 详情 / Chats 关闭，槽还给 Codex |

`conversation` 只在 `filter=weft && stage=thread && inspector==null`
时允许非 `closed`。打开详情或离开 thread，一律回到 `closed`。
workspace 下 Toggle side panel 开关的是 Weft 详情，不是 Chats。

切换 `filter: off`：拆掉所有 Weft surface，恢复原生 nav / stage，
关掉 Weft inspector 与 conversation 与 modal。

## 5. 表面如何挂到槽位

现有 iframe surface 继续复用，只改挂载几何和生命周期。

| Surface | 槽位 | 何时挂载 | 何时可见 |
|---|---|---|---|
| `sidebar` | `nav` | filter=weft | nav 未折叠 |
| `workspace` | `stage` | filter=weft | stage=workspace |
| `inspector`（新） | `inspector` | filter=weft | inspector.owner=weft |
| `popover` | `conversation` 层 | filter=weft | conversation≠closed |
| `modal` | `modal` 层 | 始终（或 filter=weft） | modal≠null |
| standalone | 无槽位 | 浏览器降级 | 自己的 topbar + 整页详情 |

`workspace` iframe 在 `stage=thread` 时 **隐藏但不卸载**，避免
Kanban 状态丢失；它的盒子必须收成 0 或 `display:none`，不得继续
盖住原生聊天和 dock。

`inspector` 是第五块 host surface（`?surface=inspector`）。内容复用
今天的 `IssueDetailView`，去掉「返回看板」整页导航，改成关闭抽屉。

## 6. 原生 chrome 所有权

标题栏那两个按钮的归属，按槽位而不是按「藏不藏得掉」决定：

| 控件 | filter=off | weft + workspace | weft + thread |
|---|---|---|---|
| 模式开关 | 原生 | 原生，当前项显示 Weft | 同左 |
| 搜索 / 通知 | 原生 | 原生，保持可点 | 原生 |
| New chat | 原生 | 隐藏（nav 已归 Weft） | 隐藏 |
| Thread title | 原生 | **隐藏**。这是上一条会话的 stage chrome，不属于 workspace | **保留**。当前 Lead / Worker 会话名 |
| Chats / 会话 | 无 | **不单独做入口**。同一颗 side panel 在 workspace 下开详情 | **保留**。入口就是标题栏右侧那颗原生 `Toggle side panel`；打开后占用同一个 `right-panel` |
| Toggle bottom panel | 原生 | **保留**。dock 打开时 stage/inspector 底边上移 | 同左 |
| Toggle side panel | 原生 | **保留**。开关 Weft issue 详情，并复用 Diff 拉伸条 | **保留**。默认开 Chats；点「详情」后同一槽切到 Weft inspector |

搜索和通知继续留给 Codex：Weft 没有替代品，藏掉只会制造死按钮。
底栏是有用的原生能力（源目录），Weft 必须让出 `dock` 高度，而不是
靠 z-index 碰运气。

标题栏槽位永远是 `native`，但 **线程标题不是窗口 chrome**。它是
`stage=thread` 的会话名，只是画在 header 里。`stage=workspace` 时
Weft 不绘制自己的 header 标题（Kanban / 仓库标题留在 stage 里），
只把残留的原生线程标题藏掉，避免看板上方还挂着上一条 Lead 文案。
藏的时候用 `visibility: hidden`，不要拆掉 header 的拖拽区。

右侧槽的互斥：

- Weft issue 详情和 Chats 都挂进原生 `right-panel`，由同一颗
  `Toggle side panel` 开关，不再在主区里自绘一条抽屉。
- 打开 Weft 详情 → 关掉 Chats，占用同一个原生右侧槽；
- 用户再点「Toggle side panel」→ 关闭 Weft 详情 / Chats，把右侧槽还给 Codex。

## 7. 点击契约

这是容器层对外的唯一交互合同。业务组件不得再私自改 `stage`。

| 用户动作 | 布局变化 |
|---|---|
| 点左侧 issue 行，且已有 Lead | `stage=thread`，打开 Primary Lead，`conversation=open-auto`，inspector 保持或关闭见下 |
| 点左侧 issue 行，尚无 Lead | 先 spawn Lead，成功后同上；失败则 `inspector={weft, issueId}`，留在 workspace |
| 点看板卡片 | `stage` 不变（仍是 workspace），`inspector={weft, issueId}`，conversation 保持 closed |
| 点浮层里的会话行 | 切原生线程，`conversation=closed` |
| 点浮层「详情」 | `conversation=closed`，`inspector={weft, 当前 issue}`，stage 仍是 thread |
| 关详情（抽屉 × / Esc） | `inspector=null`，stage 不变 |
| 点侧栏 Kanban / 仓库 | `stage=workspace`，`conversation=closed`；inspector 若属于同一 workspace 可保留 |
| 切 workspace | inspector 关闭，conversation 关闭，stage=workspace |
| 切出 Weft | filter=off，全部 Weft 层拆除 |

看板卡片 **不再** 跳 Lead，也 **不再** 带会话按钮。Lead 的入口只有
左侧 issue 列表（以及详情抽屉里的显式「打开主会话」）。

从 sidebar 进 Lead 时，先清掉 Weft 详情再开 Chats，但不要关掉原生
`right-panel` 本身，否则 Chats 会找不到槽。

## 8. Host Context 与 Action

在现有 v1 上做兼容扩展，不立刻断老 iframe：

```ts
interface HostContextV1 {
  version: 1
  // 现有字段保留：mode / view 继续发布
  mode: "work" | "codex" | "weft"     // weft ⇔ filter=weft
  view?: "workspace" | "thread"       // ⇔ stage
  // 新增，旧 UI 可忽略
  filter?: "off" | "weft"
  stage?: "workspace" | "thread"
  inspector?: { issueId: number } | null
  conversation?: "closed" | "open-auto" | "open-pinned"
  dock?: "closed" | "open"
  rightOwner?: "none" | "weft-inspector" | "native-inspector"
  issueId?: number
  workspaceId?: number
}
```

新增 host action，走既有 allowlist：

```ts
| { action: "inspector.open"; issueId: number }
| { action: "inspector.close" }
| { action: "inspector.mounted" }
```

既有 `workspace.show` / `thread.open` / `popover.dismiss` /
`dialog.*` 语义不变，但 `thread.open` 成功后的副作用改成：
只从 sidebar frame 发来时置 `conversation=open-auto`；从 popover
发来时关 conversation。**不再** 要求 workspace 切到 `view=issue`。

workspace iframe 内部的 `AppView` 收敛为 `"kanban" | "repos" | "artifact"`。
`issue` 只留给 standalone 降级。

## 9. 几何：stage 不再全铺

renderer-agent 增加一个 `syncSlotGeometry()`，每次 mount / resize /
dock 变化 / inspector 变化时计算：

```
stage.top    = titlebar/drag 底边（已有）
stage.left   = 0                         // main 已在 nav 右侧
stage.right  = inspectorWidth || nativeInspectorWidth || 0
stage.bottom = dockHeight || 0
```

workspace root 与 inspector root 都写这四个 inset，禁止再写
`bottom: 0; inset-inline: 0` 这种「吞掉 dock」的规则。

dock 高度与原生右侧 inspector 宽度只允许从 **可见 DOM 实测**，不写死。
测不到就当 0，fail-open：宁可露出一条原生缝，也不要再盖住底栏。

层级：

```
chrome / nav / dock / native stage     文档流，z 由 Codex 管
weft workspace / weft inspector        只活在自己的槽里，z 与 stage 平级
conversation popover                   --weft-layer-popover
modal                                  --weft-layer-modal
```

Weft 表面之间仍然禁止把 workspace iframe 当弹层容器。

## 10. 和现有实现的差

| 现状 | 新容器 |
|---|---|
| `mode=weft` 当作第三模式 | `filter=weft` 罩在 `nativeMode=codex` 上 |
| `view=workspace\|thread` 另起一根轴 | 并入 `HostLayout.stage` |
| workspace 全铺 `main` | workspace = stage 矩形 |
| 详情是 workspace 路由 | 详情是 inspector 槽 |
| 看板卡片点进整页详情，另有 ▶ 跳 Lead | 卡片只开抽屉；列表才进 Lead |
| 浮层「查看全部任务」跳 workspace 详情页 | 浮层「详情」开同一只抽屉并关浮层 |
| 原生 side/bottom 按钮无所有权 | 按槽位表显隐与让位 |
| popover / modal 已是 host 层 | 保留，纳入同一 layout 对象 |

不在本架构里重做：未读红点、Esc 点外侧关浮层、agent 常驻 profile、
跨 workspace 编排。那些仍是产品层，不是容器层。

## 11. 落地顺序

只改容器，不顺手做产品功能。

1. **几何收敛**（无新 UI）：`syncSlotGeometry`，workspace 给 dock /
   原生右侧栏让位；workspace 在 `stage=thread` 时不再盖住聊天。
   验收：weft+workspace 下打开 bottom panel，目录条完整可见且可点；
   打开 side panel 显示 Weft 详情并挤窄 Kanban，不打开 Diff / 底栏。
2. **inspector surface**：第五 iframe、`inspector.open/close`、
   压缩 stage。内容先原样搬 `IssueDetailView`。
3. **重接点击**：看板卡片 → inspector；sidebar issue → Lead +
   conversation；popover 详情 → 关浮层开抽屉。workspace 去掉
   Desktop 路径的 `view=issue`。
4. **原生 chrome 表**：按 §6 藏 New chat；side panel 在 workspace
   下开详情、在 thread 下开 Chats，二者与 Diff 共用同一槽。
5. **收口**：`HostContext` 发布 `filter/stage/inspector`；
   文档与 popover spec 改引用；standalone 仍走整页详情。

每一阶段单独可验收，允许只合 1 而不做 2。

## 12. 验收

1. Weft + Kanban：底栏打开后，workspace 底边停在目录条上方，不遮挡
   「weft-codex / weft」切换。
2. Weft + Kanban：标题栏保留 side panel，用来开关 Weft 详情。
   标题栏不再显示上一条 Lead / 线程标题；Kanban 自己的标题只在
   stage 里。
3. 点看板卡片：人仍在 Kanban，右侧滑出该 issue 详情；不跳聊天、
   不弹会话浮层。
4. 点左侧 issue：进入 Lead 原生聊天，会话浮层默认打开；Kanban 不再
   盖在聊天上。
5. 浮层点「详情」：浮层关掉，同一只抽屉从右侧打开，聊天还在。
6. thread 下点原生 side panel：开关 Chats。点 Chats「详情」则同一
   槽切到 Weft inspector；再点 side panel 把槽还给 Codex。拖分隔条时
   详情 / Chats 与看板同步变宽变窄。
7. 切回 Work/Codex：所有 Weft iframe 不可见，原生会话列表恢复。
8. standalone 浏览器：没有抽屉，点卡片仍进整页详情。
9. `cargo test --workspace`、launcher 测试、真实 Desktop CDP 路径
   至少覆盖 3/4/5/6。
