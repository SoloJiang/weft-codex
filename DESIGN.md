---
version: "alpha"
name: Weft in Codex
description: 宿主即真相。Weft 不建立独立于 Codex 的视觉语言，取值一律来自宿主 token。
omitted:
  - colors
rounded:
  sm: 7.5px
  md: 10px
  lg: 12.5px
  xl: 15px
  full: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
typography:
  root:
    fontSize: 13px
    lineHeight: 1.45
  title:
    fontSize: 16px
  subtitle:
    fontSize: 14px
  heading:
    fontSize: 18px
    lineHeight: 1.35
  body:
    fontSize: 12px
    lineHeight: 1.45
  label:
    fontSize: 11px
    fontWeight: 600
  meta:
    fontSize: 10.5px
    lineHeight: 1.35
  micro-caps:
    fontSize: 9.5px
    letterSpacing: 0.03em
components:
  input:
    rounded: "{rounded.md}"
    height: 32px
    padding: 6px 9px
    typography: "{typography.body}"
  textarea:
    rounded: "{rounded.lg}"
    padding: 6px 9px
    typography: "{typography.body}"
  select-trigger:
    rounded: "{rounded.md}"
    height: 32px
    padding: 0 8px
    typography: "{typography.body}"
  select-content:
    rounded: "{rounded.xl}"
    padding: "{spacing.xs}"
  select-item:
    rounded: "{rounded.lg}"
    padding: 5px 8px
    typography: "{typography.body}"
  header-entry:
    size: 26px
    rounded: "{rounded.md}"
---

## Overview

Weft 嵌在 Codex Desktop 内运行，不建立独立于宿主的视觉语言。

> **宿主是真相，不是参考。** 控件在宿主里有对应物，就照抄它的构造；没有对应物，
> 才自行决定。

**偏离宿主的三步**：找最近的宿主对应物并继承其构造 → 只在确有必要处偏离且幅度
最小 → 理由写进代码注释与「Do's and Don'ts」。宿主对同一件事有两种行为时跟通则、
不跟例外，那不算偏离。

颜色、字体族、圆角尺度由宿主在运行时提供，本文记录的是**角色与构造**。参考值取自
Codex Desktop build 6321（2026-08-11），随宿主版本与主题变化，重测流程见
`docs/compat/codex-builds.md`。

## Colors

Weft 没有自己的色板（front matter 中 `colors` 为 `omitted`）。语义角色映射到宿主
token，由 `ui/src/index.css` 统一声明；**组件中不出现字面颜色值**。

| 角色 | 变量 | 宿主 token | 用途 |
|---|---|---|---|
| 前景 | `--text` | `--color-token-foreground` | 正文、图标 |
| 次级前景 | `--dim` | `--color-token-text-secondary` | 元信息、占位说明 |
| 描边 | `--border` | `--color-token-border` | 浮层轮廓、分隔线、焦点环 |
| 强描边 | `--border-strong` | `--color-token-border-heavy` | 字段轮廓 |
| 悬停 | `--hover` | `--color-token-list-hover-background` | 行与触发器的悬停底 |
| 表面 | `--panel-2` | `--color-token-dropdown-background` | 浮层与字段底 |
| 主色 | `--accent` | `--color-token-primary` | 选中标记、角标 |
| 焦点 | `--focus` | `--color-token-border` | 焦点环 |

**焦点色即描边色**，不是独立角色——宿主在自身控件上声明
`focus-visible:outline-2 outline-offset-2 outline-token-border`。它约 8% alpha，
对比度低于常见无障碍基线，是对齐宿主的既定代价；变更属于产品决策，先改 PRODUCT.md。

**强调用透明度表达，不换色相。** 悬停加前景 alpha 底色，字段悬停提升轮廓 alpha。
不引入主色悬停。

**无宿主环境沿用同一套角色。** `--fb-*` 复刻宿主约定而非另立一套：焦点在宿主内是
描边色，降级环境即取降级自身的描边色。

## Typography

字体族由宿主提供（`--font` / `--mono`），**不指定字体族**——用户自定义字体会改变
实测值，字体 token 只断言非空。

根字号 13px（宿主 16px，Weft 表面信息密度更高）。

| 角色 | 字号 | 行高 | 用途 |
|---|---|---|---|
| `heading` | 18px | 1.35 | 视图标题 |
| `title` | 16px | — | 详情页、产物、弹窗标题 |
| `subtitle` | 14px | — | 仓库名、弹窗正文等需要高于正文的一档 |
| `body` | 12px | 1.45 | 正文、行标题、控件文本 |
| `label` | 11px | — | 分区标题、计数、字段标签 |
| `meta` | 10.5px | 1.35 | 次要说明、产物元信息 |
| `micro-caps` | 9.5px | — | 全大写类型徽标，字距 0.03em |

新增文本从上表取值，**不要新增第八档**。

## Layout

间距基于 4px 栅格。

| 级别 | 值 | 用途 |
|---|---|---|
| `xs` | 4px | 图标与文本间距、浮层内边距 |
| `sm` | 8px | 控件内水平间距、行间距 |
| `md` | 12px | 相邻控件组 |
| `lg` | 16px | 区块间距 |
| `xl` | 20px | 主区域留白 |

控件基准高度 **32px**，与宿主一致。

## Elevation & Depth

**边界由 ring 与投影表达，不使用 `border`。** 宿主全程如此：其 composer 为
`border: 0` 配 `0 0 0 0.5px` 描边环加柔和投影，浮层为同一构造的更低 alpha。1px 实线
边在其旁明显更重。

ring 的**颜色**区分可交互与否，**投影的深度**区分贴在页面上还是浮在其上：

| 层级 | 构造 | 用于 |
|---|---|---|
| 内联表面 | `0 0 0 0.5px var(--border)` | 看板列、任务列表、仓库块、详情头、代码区 |
| 抬升表面 | 内联 + `0 3px 7.5px rgb(0 0 0/.04)` | 看板卡片 |
| 字段 | `0 0 0 0.5px var(--border-strong)` + `0 3px 7.5px rgb(0 0 0/.04)` | input、textarea |
| 字段·悬停 | ring 提至 `color-mix(in srgb, var(--text) 26%, transparent)` | input、textarea |
| 字段·错误 | `0 0 0 1px var(--danger)` + 同上投影 | `aria-invalid` |
| 浮层 | 抬升 + `0 12px 32px rgb(0 0 0/.12)` | select-content、toast |
| 模态 | `0 0 0 0.5px var(--border)` + `0 24px 64px rgb(0 0 0/.18)` | 宿主级弹窗 |

**语义状态改 ring 的颜色，不要退回 `border-color`。** toast 的成败、告警块的边都
走同一条 ring，换的只是颜色。

**但不要给容器描彩色边来表达状态。** 宿主从不为此着色容器；一圈环绕整卡的彩色轮廓
比它所报告的事情还响。状态由内容承载——文字加颜色，容器保持普通边。这同时满足
「状态不能只依赖颜色」：文字本身已经说清楚了。

chip / tag / 徽标用 **inset ring**：`box-shadow: inset 0 0 0 0.5px …`。它们尺寸小、
常处在紧凑行里，inset 落在原 `border` 的位置，不会被父级 `overflow` 裁掉，也不改变
外框尺寸。

`border` 只保留 `1px solid transparent` 一种用法：占位，使 ring 与 hover 不引起尺寸
跳动。

### 焦点环

```css
outline: 2px solid var(--focus);
outline-offset: 2px;
```

全站唯一焦点表现，由 `index.css` 单条规则统管，**不叠加 ring 或 box-shadow**。

输入框同样带环。宿主的 command menu 输入框无环属**例外**——模态内自动聚焦、独此
一个；其按钮、侧栏行、下拉触发器均带环，密集并列的字段适用通则。

## Shapes

**圆角随元素高度递增**，这是宿主自身的规律：图标触发器（26px 高）10px · 菜单项与
行按钮 12.5px · 模式按钮与浮层 15px · composer 25px。

| 级别 | 值 | 用于 |
|---|---|---|
| `sm` | 7.5px | 树行、chip、徽标等低于宿主最小控件高度的元件 |
| `md` | 10px | 单行控件、图标按钮、结果行 |
| `lg` | 12.5px | 列表行、菜单项、多行控件 |
| `xl` | 15px | 浮层、模态 |
| `full` | 999px | 胶囊：状态 chip、计数徽标 |

`sm` 之下宿主没有对应物——它承接的是比 26px 更矮的行，取值继续沿这条斜坡下延，
而非套用一个在该高度会被钳成胶囊的更大值。

`xl` 无对应宿主 token（`--radius-lg` 为 12.5px），为实测字面值；发现对应 token 后
换回引用。

**圆角 token 必须以 px 转发。** 宿主以 rem 声明，而 rem 按消费方根字号解析
（宿主 16px、Weft 13px），直接转发字符串会使圆角整体缩小 19%。

## Components

### Input

单行文本字段。`{rounded.md}` · 32px · `6px 9px` · `{typography.body}`。

| 状态 | 表现 |
|---|---|
| 默认 | 表面底 + 字段级 ring |
| 悬停 | ring 提至 26% 前景 alpha |
| 焦点 | 叠加焦点环，ring 不变 |
| 错误 | ring 转 `--danger` |
| 禁用 | `opacity: .5`，`cursor: not-allowed` |

### Textarea

多行文本字段。同 Input，圆角取 `{rounded.lg}`，最小高度 96px，仅纵向可缩放。

### Select

**下拉一律为触发器加浮层，不使用原生 `<select>`。** 宿主全应用 0 个 `<select>`、
0 个 `aria-haspopup="listbox"`、14 个 `aria-haspopup="menu"`。实现基于 Radix Select，
以获得方向键、Home/End、首字母跳转与 Escape。

**Trigger** — `{rounded.md}` · 32px · `0 8px` · 透明底 · `1px solid transparent`。

| 状态 | 表现 |
|---|---|
| 默认 | 全透明，仅文本与 chevron |
| 悬停 / 展开 | `--hover` 底色 |
| 焦点 | 焦点环 |
| 占位 | 文本转 `--placeholder` |
| 禁用 | `opacity: .5`，`cursor: not-allowed` |

**Content** — `{rounded.xl}` · `{spacing.xs}` 内边距 · 表面底 · 浮层级 elevation ·
最小宽度对齐触发器。

**Item** — `{rounded.lg}` · `5px 8px`。

| 状态 | 表现 |
|---|---|
| 默认 | 无底色 |
| 高亮 | `--hover` 底色 |
| 选中 | 行尾 `--accent` 勾选标记 |
| 禁用 | `opacity: .5` |

### 列表行的尾部槽位

宿主的会话行把次级控件（Pin / Archive）放在行尾，**静置 `opacity: 0`、hover 转 1**，
空间始终预留所以不跳动（build 6321 实测）。行本身是一个扁平的点击目标，没有展开
控件。

Weft 的 issue 行需要展开，宿主没有对应物，因此沿用它对这个槽位的处理方式：展开箭头
静置不显形，hover / `focus-within` 时出现；**已展开是状态而非悬停反馈，必须常驻**。
触屏（`hover: none`）下始终显示。

### Header entry

注入宿主侧边栏头部的 Weft 入口，26px 方形，克隆宿主原生按钮以继承其尺寸、悬停、
焦点与主题。角标为 `--accent` 圆点，14px，右上角外溢 1px。

### 快捷键

宿主已占用下列绑定，且绑定在 Electron 菜单层，渲染进程无法拦截。**新增快捷键前先
以 `⌘/` 调出宿主快捷键表核对。**

| 功能 | 绑定 |
|---|---|
| Open command menu | `⌘K`、`⇧⌘P` |
| Toggle activity view | `⌥⌘U` |
| Find | `⌘F` |
| Search Files… | `⌘P` |
| Switch to Chat / Work / Codex | `⌃1` / `⌃2` / `⌃3` |

Weft 搜索使用 `/`，无修饰键，需守卫输入类元素。

## Do's and Don'ts

**Do** 以宿主 token 表达颜色与尺度。
**Don't** 在组件中写入字面颜色值或自定尺度。

**Do** 用 ring 与投影表达边界。
**Don't** 用 `border` 画字段与浮层的边。

**Do** 让焦点只有一层 outline。
**Don't** 叠加组件自带的 ring 工具类——它们走 box-shadow，不会被元素规则覆盖。

**Do** 把视觉属性写在 `ui/src/index.css`，组件只保留结构与行为。
**Don't** 在组件上堆 Tailwind 视觉类——`index.css` 的裸元素规则未分层，恒定胜过
分层的 utilities，这些类不会生效。

**Do** 以结构定位宿主元素。
**Don't** 以 `aria-label` 或文案定位——它随宿主界面语言变化。

**Do** 保持无宿主环境与宿主内一致。
**Don't** 为降级路径单独设计。

**Do** 修改样式前用真机计算值确认目标规则生效。
**Don't** 依据阅读推断——无人引用的类名与被整段覆盖的声明都能长期存活。

## Container architecture

weft-codex 的容器宪法。新界面、容器改动、宿主注入，先对照本节与上文视觉系统，再看日期规格。

关联：

- 产品目的与反例：[PRODUCT.md](PRODUCT.md)
- 容器几何与 action：[docs/specs/2026-08-13-host-slot-layout.md](docs/specs/2026-08-13-host-slot-layout.md)
- Chats 状态机：[docs/specs/2026-08-13-lead-chat-conversation-popover.md](docs/specs/2026-08-13-lead-chat-conversation-popover.md)

本节记录 2026-08-14 / 08-15 在 Codex Desktop 真机（profile CDP）验证后仍然成立的判断。日期规格里若与本文冲突，以本文为准。视觉 token、控件构造仍以上文为准。

### 1. 产品是什么

用户始终待在官方 Codex Desktop 里。Weft 不是第三个对等模式，也不是罩在 Codex 上的管理后台。

Work / Codex 仍是 Codex 自己的模式。Weft 是一层 **filter**：打开后，左侧导航、看板、issue 详情、会话树归 Weft；聊天、标题栏、底栏、Diff、拉伸条仍归 Codex。

成功标准不是「Weft 看起来完整」，而是「人感觉自己还在用 Codex，只是多了一套 issue 驱动的工程编排」。

### 2. 不可妥协的原则

1. **扩展宿主，不替换宿主。** 左侧栏、右侧栏、标题栏按钮、底栏都先找 Codex 已有槽位。Weft 只填内容或让位，不另画一套平行 chrome。
2. **槽位有且只有一个 owner。** `nav` / `stage` / `right-panel` / `dock` 同一时刻不能既给 Weft 又给 Codex 正文。层（modal）可以盖住 stage，但不能改 chrome / dock 的几何。
3. **隐藏不是架构。** 用 CSS 把原生列表藏掉、再用 iframe 全铺 `main`，必然把标题、底栏、Diff、拉伸条一起弄乱。先指定 owner，再挂载或让位。
4. **对话属于 Codex，交付上下文属于 Weft。** Lead / Worker 是原生 Thread。看板、详情、会话树只提供归属与进度，不复制一套聊天客户端。
5. **点击契约比组件路由更稳。** 业务组件不得私自改 `stage`。谁打开 Lead、谁打开详情、谁占用右侧槽，只走 host action。
6. **真机优先。** 容器结论必须在 Codex Desktop + profile CDP 上复验。静态预览、规格段落、旧注入截图都不是交付证明。

### 3. 窗口怎么拆

```text
chrome     标题栏 / 红绿灯 / 模式开关 / Toggle side panel / Toggle bottom panel
nav        左侧栏。Weft filter 开时改写成 Create issue / workspace / Kanban / Repos / Issues
stage      主区。workspace = Kanban 或仓库；thread = 原生 Lead / Worker 聊天
right      原生 [data-app-shell-focus-area="right-panel"]。Weft 详情、Chats、Diff 互斥共用
dock       原生底栏 / 源目录。Weft 只观察并让位
modal      host 级创建弹层。不进 workspace / sidebar iframe
```

含义：

- workspace iframe 的矩形 = stage 的矩形。禁止再写成从标题栏铺到窗口底。
- 打开右侧槽时，stage 被挤窄，而不是被盖住。
- dock 打开时，stage / 右侧槽底边上移。测不到高度就当 0，fail-open。
- sidebar iframe 在 Weft 模式下是隐藏控制器（0×0），可见行是改写后的原生 sidebar。

### 4. 点击契约

这是容器层对外的唯一交互合同。

| 用户动作 | 结果 |
|---|---|
| 点左侧 issue 行，且已有 Lead | `stage=thread`，打开 Primary Lead；Chats 默认打开（`open-auto`） |
| 点左侧 issue 行，尚无 Lead | 先 spawn Lead，成功后同上；失败则留在 workspace，打开该 issue 详情 |
| 点看板卡片 | 留在 Kanban，打开 Weft 详情；不跳聊天，不弹 Chats |
| 点标题栏 Toggle side panel | 开关当前右侧槽。workspace 下是上次的 Weft 详情；thread 下先是 Chats |
| 点 Chats 里的「详情」 | 关掉 Chats，同一 `right-panel` 切到 Weft 详情；人仍留在当前 Lead |
| 关详情 / 再点 side panel | 右侧槽还给 Codex，stage 回到全宽 |
| 点侧栏 Kanban / 仓库 | `stage=workspace`，Chats 关闭 |
| 切出 Weft | 拆掉所有 Weft 表面，恢复原生 nav / 会话列表 |

看板卡片不再带跳会话按钮。Lead 的入口只有左侧 issue 列表，以及详情里的显式「打开主会话」。

从 sidebar 进 Lead 时：若详情已为同一 issue 打开，先清详情再开 Chats，但 **不要顺手关掉原生 `right-panel`**，否则 Chats 会找不到槽。

### 5. 右侧槽：详情、Chats、Diff

Weft 详情和 Chats 都挂进原生 `right-panel`，入口就是标题栏那颗 `Toggle side panel`。不要在主区自绘抽屉，也不要再做左侧 Chats 胶囊。

互斥：

- workspace + 看板卡片 → Weft 详情占用 `right-panel`
- thread + sidebar issue → Chats 占用 `right-panel`
- thread + Chats「详情」 → 同一槽切到 Weft 详情，Chats 关
- 用户关 side panel → Weft 状态清掉，槽还给 Codex

实现上必须记住三件事：

1. **不要程序化地点 workspace 下的 side panel 去“借”Diff。** 那会把 Electron `webview` 和底栏一起打开，详情被盖住，只剩 icon 亮着。
2. **不要 `display:none` 掉整个 Diff 骨架。** 原生面板宽度来自 React 状态和内部 `width/min-width`。藏掉骨架，`right-panel` 会收成 0。只藏 Diff 正文，保留宽度壳。
3. **拉伸条是原生 chrome，不是 Weft 控件。** 详情 / Chats 内容相对 `right-panel` 左缘内收 8px，把 `[role=separator]` 露出来。拖拽时把宽度写回面板，并让 stage 跟着让位。默认约 420px，可拖范围约 280–720px。

标题栏 side panel 的点击要让原生 toggle 自己完成，再同步 Weft 内容。捕获阶段拦截再 `preventDefault`，会把面板关不掉，或关了状态还停在 `inspector=N`。

### 6. 左侧栏

Weft 不替换 sidebar，只改写原生滚动区：

- Create issue 拦截原生 New chat
- workspace 名、Kanban、Repositories、Issues 都是原生行
- Weft sidebar iframe 只做控制器，不画可见导航
- issue 行没有展开箭头，也没有常驻会话树

会话树只活在 thread 的 Chats 面板里。把它放回左侧，会和 Codex「当前聊天」抢扫描对象。

### 7. Host context 必须够用

iframe 不能靠猜当前 issue。host 至少发布：

- `filter` / `stage` / `inspector` / `conversation`
- `threadId`：同时认 `data-app-action-sidebar-thread-active` 与 `thread-selected`
- `issueId`：当前焦点 issue，供 Chats 在 thread 绑定尚未对上时回退
- `workspaceId`：当前 workspace，供 popover / inspector 拉看板

只传原生 thread id 不够。Desktop 里选中的 Lead 行 id 可能和 `issue.lead_codex_thread_id` 不是同一个字符串，Chats 会永远停在「正在载入工作区」。

### 8. 看板上的布局

- 五列固定 272px，列间距 20px，`width: max-content`，横向滚动。
- 不要在 iframe 变窄时改走 720px 移动端堆叠。那会让列叠在一起。
- workspace 自己的「Kanban」标题留在 stage 里。标题栏残留的 Lead 文案用 `visibility: hidden` 藏掉，不要拆 header 拖拽区。

### 9. 验证标准

容器改动未完成，除非 Codex Desktop + profile CDP 上能逐条看到：

1. 看板点卡片：人仍在 Kanban，右侧出现该 issue 详情；无 Diff webview，底栏不跟着开。
2. 再点 Toggle side panel：详情和 `right-panel` 一起关掉，看板回全宽。
3. 再开 side panel：回到上次的 Weft 详情，不是 Diff / New tab / Annotating。
4. 点左侧 issue：进入 Lead，Chats 自动出现在同一右侧槽，能看到 Main chat / Details。
5. 点 Chats「详情」：同一槽切到 Weft 详情，人还在 Lead，底栏仍关。
6. 拖右侧分隔条：详情变宽或变窄，看板同步让位。
7. 窗口缩窄：五列仍是 272px，不重叠，出现横向滚动。

规格、截图、旧 bridge id 的注入结果，都不能代替这一轮。

### 10. 明确不做

- 不把 Weft 做成和 Work / Codex 对等的第三产品模式。
- 不在 workspace iframe 里做弹层、详情整页或平行 sidebar。
- 不把 agent profile / 跨 workspace 编排塞进当前容器。具名 agent 仍强绑定某个 workspace；没有绑定的 engine 是以后的事。
- 不暴露 direction、bus 等内部名词。
- 不为了“看起来像原生”去复制一套 sidebar / header / splitter。要用 Codex 自己的。
