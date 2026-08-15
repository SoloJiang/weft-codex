# Lead 聊天内会话浮层（Conversation Popover）交互设计

状态：方向已定稿，并已在 Desktop 落地。现行原则见 [DESIGN.md](../../DESIGN.md)。
Chats 占用原生 `right-panel`，不再自绘浮层；「详情」切到同一槽的 Weft inspector。
关联：本文修订 `2026-08-08-codex-desktop-migration-design.md` §7 中
「sidebar 展开会话树」的交互；store / bridge / 编排语义不变。

## 1. 背景与问题

原设计里，sidebar 的 issue 主行右侧有 chevron，点击展开一个常驻的会话树
区域（Lead / Tasks 分组、fork、artifacts 摘要），问题有三个：

1. 会话树是「线程切换器」，它的消费场景 100% 发生在看 Lead 聊天的时候；
   常驻 sidebar 只是在占用导航面板的垂直空间。
2. 常驻展开区域打断 issue 列表的扫读节奏——用户的核心扫描对象是 issue
   本身，不是它下面的线程。
3. 与 Codex 原生的「当前聊天」心智冲突：原生线程视图里，和「这个 issue
   还有哪些会话」最自然的距离是**就在聊天里**，而不是回到侧边栏。

## 2. 交互模型

一句话：**sidebar 只负责 issue 导航；会话切换收进 Lead 聊天上下文内的
悬浮卡片，到达时默认打开。**

### 2.1 sidebar（导航层）

- Issue 列表是干净的平铺列表：状态点 + 标题 + 计数徽章，**没有展开箭头、
  没有常驻展开区域**（chevron 已于 2026-08-13 移除）。
- 点击 issue 行 = 打开它的 Primary Lead 原生线程，并默认打开本浮层。
  详情不再跟进 workspace 整页；需要看任务/活动时，从浮层「详情」打开
  右侧 inspector 槽（见 `2026-08-13-host-slot-layout.md`）。

### 2.2 Lead 聊天头部入口

- 在原生标题栏右侧 `header-shell-slot` 里，与「Toggle side panel / Diff view」同一簇，
  提供一个原生样式的「会话」图标按钮。不要再挂到左侧栏或 mode switcher 旁。
- 入口按钮带未读指示：当前非活跃任务会话有新消息/attention 信号时，
  显示一个小红点；活跃会话本身不计未读。

### 2.3 会话面板（Conversation / Chats）

- 位置：占用原生右侧 `right-panel`，与 Diff view / Toggle side panel
  同一套 chrome。不要再自绘左侧胶囊，也不要再做一张漂在聊天上的卡片。
- 标题栏：「会话」+ 关闭（×）按钮；Esc 与再次点击同一原生按钮同样关闭。
- 分组（复用现有会话树的数据与排序，不改 store）：
  - **Lead**：主会话行（在线状态点 + 「主会话」+ 最近活跃时间）；
  - **任务**：各 direction 会话行（标题 + 状态 chip「进行中 / 待接手 /
    待验收」+ 时间）。
- 当前活跃会话行高亮；点击任意行即切换到对应原生线程并关闭浮层。
- fork 会话收在其逻辑 Lead / Task 分组下，fork 行保留 promote 为
  primary 的动作（复用现有 `lead-thread` POST）。
- 行数超出卡片高度时卡片内部滚动；底部保留「查看全部任务」入口，跳转到
  同一只原生 `right-panel` 里的 Weft inspector，并关闭 Chats。不再把人送回
  workspace 整页详情。
- artifacts 摘要不进浮层：它是文档不是会话，仍由 issue detail 承载。

### 2.4 默认打开语义

- 从 sidebar 点击 issue 行进入 Lead 聊天时，浮层**默认打开**（本次导航
  的上下文是「我刚选了这个 issue，现在想看看它有哪些会话」）。
- 用户一旦手动关闭（× / Esc / 点击外部），本次会话内不再自动打开；
  之后从 sidebar 再次点击任一 issue 行，重新默认打开。
- 已经在 Lead 聊天里、仅切换工作区或刷新页面时，不自动打开。

## 3. 状态机

popover 的可见性只有一个判别值，穷举映射：

```
popoverState =
  | "closed"            // 默认；入口按钮可见
  | "open-auto"         // 由 issue 行点击触发，用户尚未交互
  | "open-pinned"       // 用户主动点入口按钮打开（不随后续导航自动关）
```

- `closed → open-auto`：sidebar issue 行点击。
- `closed → open-pinned`：入口按钮点击。
- `open-auto → closed`：× / Esc / 点击外部 / 切换了会话（选中某行）。
- `open-pinned → closed`：同上；区别在于 open-auto 在「宿主线程切换」
  时也关闭，open-pinned 只在用户显式动作时关闭。
- 任何状态 → closed：切换 workspace。

## 4. 与既有实现的映射

- 数据：完全复用 sidebar 会话树现有的 `BoardEntry` /
  `branchesFor(entry, …)` / `primaryBranch` 推导，以及
  `/api/issues/{id}/lead-thread` promote 接口；不新增 store 字段。
- 挂载：浮层是线程视图上层的独立宿主级表面，**不把 workspace iframe 当
  弹层容器**（沿用既定 modal 约束）；与 Toggle Summary 共享宿主锚点机制。
- 未读红点：数据源复用 attention 信号与 bus 活动时间线里「非活跃会话」
  的最新事件；不引入新的通知通道。
- sidebar 侧已完成的清理：移除 issue 行 chevron、`sidebar.expandIssue`
  i18n 串与相关样式（ui/src/SidebarApp.tsx、i18n en/zh、index.css）。
  剩余的常驻展开区域（`sidebar-expanded-issue` + `IssueConversationTree`
  挂载）在浮层上线时移除，组件逻辑迁为浮层内容。

### 4.1 已实现形态（2026-08-13）

- **ui 侧**：新增 `popover` surface（`?surface=popover`）。`PopoverApp` 通过
  `host-context.threadId` 定位当前原生线程，用 `/api/threads/resolve` +
  board 扫描反查所属 issue，再渲染迁移到共享组件
  `ui/src/components/conversation-tree.tsx` 的会话树。sidebar 的常驻展开区、
  `expandIssue` 状态、`ArtifactSummaryList` 挂载与相关样式全部移除；
  会话树组件由 sidebar 和 popover 共用。
- **launcher 侧**：renderer-agent 把会话面板挂进原生 `[data-app-shell-focus-area="right-panel"]`，
  并复用标题栏右侧同一颗 `Toggle side panel` / Diff 按钮作为入口。打开时让原生
  面板自己展开，Weft 只替换面板内容；关闭时把面板还给 Codex。可见性仍由单一
  `popoverState` 驱动：`closed | open-auto | open-pinned`。从 sidebar 发出的
  `thread.open` 成功后置 `open-auto`；从 popover 内部发出的 `thread.open`
  成功后关闭；离开 thread 视图或切出 weft 模式一律关闭。
- **留白（后续迭代）**：入口按钮未读红点与 Esc/点击外部关闭暂未实现——
  前者需要「非活跃会话新事件」的聚合信号，后者宿主点击捕获与原生线程
  视图的 Esc 语义有冲突风险，都留给浮层上线后的实测。

## 5. 验收要点（实现后 QA）

1. sidebar issue 列表任何状态下一行只有一个可点击主行，无 chevron、无
   常驻展开区。
2. 点击 issue 行：Primary Lead 线程打开 + 浮层默认打开，且浮层内 Lead
   主会话行高亮。
3. 浮层内点任务行：切到对应原生线程，浮层关闭，再次从 sidebar 点同一
   issue 浮层重新默认打开。
3b. Chats「详情」：关掉 Chats，同一 `right-panel` 切到 Weft inspector；人仍留在当前
    原生聊天，不回到 workspace 整页。
4. Esc / × / 点击外部均关闭浮层；本次会话内不再自动弹出。
5. 非活跃任务会话有新事件时，入口按钮出现未读点；打开浮层后未读点消除。
6. fork 行的 promote 动作在浮层内可用，promote 后 Lead 分组主会话立即
   更新（复用 `thread_for` 语义）。
7. 中/英与明/暗主题下浮层 token 与宿主同步（沿用 Host Context Bridge
   白名单，不新增 token）。
