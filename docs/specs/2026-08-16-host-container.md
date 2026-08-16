# Weft 容器架构：宿主槽位（2026-08-16）

管容器：Weft 的表面挂在窗口的哪一块、那一块归谁、几何怎么算。
不管产品形态——那是 `2026-08-16-weft-third-mode-design.md`（canonical）。
不管编排：weftd store、thread_binding、bus、worktree 一律不动。

取代 `codex/native-right-panel-container` 分支上的
`docs/specs/2026-08-13-host-slot-layout.md`（PR #68，未合入）。那份文档的容器
判断成立并在此保留；它的产品判断「Weft 是 filter 不是第三模式」已被 08-16 spec
否定，此处剔除。它假设的 iframe 与「右侧是一块谁占谁的单槽」也都已过时，此处
按 build 6662 实测重写。

## 1. 问题

容器层把三件不同的事揉成一根 `mode × view` 轴：产品过滤、主区所有权、原生
chrome 所有权。而实现上只做了两件事：用 CSS 把原生列表藏掉，再把 Weft 表面盖
上去。

**根因不是少一块 UI，而是 host 没有窗口管理，只有隐藏和覆盖。**

这条诊断至今有效。2026-08-16 修掉的三个 bug 都是它的直接后果：workspace 铺满
`main` 压住原生底栏与右侧面板；看板视图上方挂着上一条线程的原生标题；同文档壳
之后两个 `/` 监听同时响应。

## 2. 判断

1. **Weft 是第三种模式**，与 Work / Codex 并列。不降级为 filter。
2. **host agent 是窗口管理器。** 它给每个槽位指定唯一 owner，按 owner 挂载或
   让位。**Weft 绝不绘制自己未拥有的槽位。**
3. **优先扩展宿主 chrome，而不是画平行容器。** 宿主已经有的东西不重做一份：
   模式菜单插第三项，右侧 tab 条插 Weft tab。
4. **几何只从可见 DOM 实测。** 不写死尺寸；测不到当 0。
5. **减法失败 = 不能进 Weft**（08-16 spec §4）。但「减法」只涵盖功能性锚点，
   纯配色 token 缺失不在此列，理由见 `docs/compat/codex-builds.md` §8.2。

## 3. 槽位（build 6662 实测）

| 槽位 | 宿主锚点 | 允许的 owner | 现状 |
|---|---|---|---|
| `chrome` | `header[data-pip-obstacle="app-shell-header"]`，自身即拖拽区 | 永远 `native` | 已让位；workspace 下藏掉残留线程标题 |
| `nav` | `[data-app-action-sidebar-scroll]` | `weft` / `native` | 已落地 |
| `stage` | 可见 `main`，扣除 inspector 与 dock | `weft-workspace` / `native-thread` | 已落地 |
| `right` | `[data-app-shell-focus-area="right-panel"]` | **tab 容器**，见 §5 | 未落地 |
| `dock` | `[data-app-shell-focus-area="bottom-panel"]` | 永远 `native` | 已让位 |
| `overlay` | Weft 自建 root | `weft` | 已落地 |

两个 `focus-area` 锚点**按需渲染**：Codex 没打开过侧栏或底栏时，整个属性在文档里
一次都不出现。第一次探到空数组不等于锚点消失——同 `codex-builds.md` §2.2 记的
模式菜单。它们一旦创建就留在 DOM，关闭时塌成 inline `width/height: 0`。

## 4. 表面怎么挂

PR #72 之后是**同文档 shadow**，不是 iframe。三个 root 挂在宿主文档里，各自
`attachShadow`，共用一份 adopt 进去的 CSS。

这比 iframe 简单：不需要 host-context 跨帧协议，宿主 CSS 变量自动继承进 shadow，
Weft 表面之间也不必再靠 postMessage 对话。代价是**共用一个 `window`**——`/`
监听曾因此一次开两个搜索面，那一类接缝要按同文档重新检查。

新增表面就是第四个 shadow root，不是第五个 iframe。

## 5. 右侧面板是 tab 容器，不是单槽

6662 上 `[data-app-shell-focus-area="right-panel"]` 里有
`data-app-shell-tabs` / `tab-strip-controller` / `tab-controller` /
`tab-panel-controller`，四个原生 tab：Review ⌃⇧G、Terminal ⌃`、Browser ⌘T、
Files ⌘P。tab 条是 dnd-kit 可拖拽排序列表。

因此**不存在「占用右侧面板」这件事**。08-13 文档 §6 花大篇幅设计的「Weft 详情 /
Chats / Diff 三者互斥、共用一颗 Toggle、共用一条拉伸条」，前提已经不成立——宿主
自己把这块地做成了多 tab 容器。

正确做法是**往 tab 条里插 Weft tab**，与模式菜单插第三项同一个模式。实测结论
（2026-08-16，克隆原生 tab 注入）：

- 注入的节点能在原生 tab 自身重渲染后存活（终端标题变化后仍在）；
- 整个侧栏面板关闭再打开后仍在；
- 渲染外观与原生 tab 一致，含关闭按钮。

未验证：宿主增删 tab 导致 tablist 子节点列表重建时是否存活。agent 现成的
MutationObserver + 幂等 `ensure*` 是兜底手段，与模式菜单同一套。

**选中态仲裁是这条线的风险集中处**，尚未设计：点原生 tab 时 Weft 内容要让位，
点 Weft tab 时要盖住原生内容，而选中态由宿主 React 托管。

## 6. 会话数据按原生对齐

**决定（2026-08-16）：issue 的会话数据不再由 Weft 在侧栏自绘。** 会话树与 issue
详情都进原生右侧面板，各占一个 Weft tab；详情的入口就是原生侧滑，与看板卡片点击
同效。

这与「优先扩展宿主 chrome」是同一条原则：宿主已经有承载会话的表面，Weft 不该在
侧栏里再画一棵树。

**这会改动 08-16 spec §8.7**——它现在写着侧栏含「issue 树（Lead / Tasks /
fork）」。落地时同步修订，不要让两份文档各说各话。

现状仍是侧栏内联 `.sidebar-expanded-issue` + `IssueConversationTree`，迁移完成
前保持不变。

## 7. 几何（已落地）

```
stage.top    = 拖拽区底边
stage.left   = 0
stage.right  = right-panel 盒子宽度
stage.bottom = bottom-panel 盒子高度
```

量盒子即完整判据：面板没创建过读 0，创建后关闭也读 0，两种「读不到」都对应
「Codex 在这没占地方」。缺失即 0 是 fail-open 的正确方向。

面板带过渡动画，必须把面板本身喂给 `ResizeObserver`；只在 inline style 翻转那
一刻量一次，会把 workspace 冻在动画中间尺寸。

**藏原生元素一律 `visibility: hidden`，不用 `display: none`。** 拖拽区挂在
`<header>` 自己身上，而 `stage.top` 正是从拖拽区底边反推的；塌掉盒子会让 top
算成 0，workspace 直接滑到窗口控件底下。

## 8. 点击契约

容器层对外的唯一交互合同，业务组件不得私自改 stage。

| 用户动作 | 布局变化 | 现状 |
|---|---|---|
| 点侧栏 issue 行 | 打开 Primary Lead，stage=thread | 已落地 |
| 点看板卡片 | stage 不变，右侧开该 issue 详情 tab | **待落地**，现在是整页详情 |
| 点会话行 | 切原生线程 | 已落地 |
| 点详情里的「打开对话」 | 切原生线程 | 已落地 |
| 切 workspace / 切出 Weft | 关闭 Weft 占用的右侧 tab | 待落地 |

## 9. 落地顺序

1. ~~几何收敛：给 dock 与右侧面板让位~~（PR #89）
2. ~~workspace 下藏掉残留线程标题~~（PR #89）
3. Weft tab 之一：注入与生命周期（出现、dispose 摘除、被摘掉自愈）
4. Weft tab 之二：选中仲裁与内容挂载，详情先原样搬 `IssueDetailView`
5. 重接点击契约：看板卡片 → 详情 tab
6. 会话树迁入第二个 Weft tab，同步修订 08-16 spec §8.7

每步单独可验收。3 与 4 之间可以停。

## 10. 验收

真机 build 6662，Weft 模式，隔离 profile 与 weftd：

1. 开底栏：workspace 底边停在目录条上方，「weft-codex / weft」切换可点。
2. 开右侧面板：看板被挤窄而非被盖住；拖分隔条时 workspace 同步跟随。
3. 看板视图：标题栏不显示上一条线程标题；切到 thread 视图后恢复。
4. 点看板卡片：人留在看板，右侧滑出该 issue 详情 tab。
5. 点原生 tab：Weft tab 让位；再点回来内容还在。
6. 切出 Weft：Weft tab 摘除，原生 tab 条恢复原样。

1–3 已通过（PR #89）。4–6 随 §9 步骤 3–5 落地。
