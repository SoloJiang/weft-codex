# Weft 迁移至 Codex Desktop 设计（2026-08-08）

## 1. 背景与目标

停发 Weft Tauri 客户端，把产品能力移植进 Codex Desktop。聊天表面全部委托给
Codex 原生线程；Weft 退位为一个无头编排引擎（weftd）+ 一层嵌入 Codex Desktop
的薄 UI。

核心判断：Weft 最贵、最不差异化的部分是聊天 UI（ChatTimeline、transcript
解析、虚拟滚动、协议适配），这部分在与 OpenAI 的整个工程团队赛跑；真正差异化
的是编排层——多仓库、围绕 issue 的 lead/worker 模型、direction 并行探索、
bus 通信、worktree 生命周期、workspace/kanban。迁移保留后者，删除前者。

## 2. 范围

In：

- 多仓库（workspace / repo_ref / repo_profile 原样保留）
- 仓库录入与拆解：curator 分析管线（录入 → agent 分析 → repo_profile →
  repo map），执行层改造见第 5.5 节
- issue → lead + 多 direction 的编排模型
- lead/worker 均为真实 agent 会话，聊天在 Codex Desktop 原生渲染
- bus 通信（agent ↔ lead、跨 direction）
- worktree materialize 与 git 生命周期
- workspace home / kanban / issue detail / repo map 四个 UI 表面

Out（本阶段明确割舍）：

- 审批流 / Ask 桥（app-server 的 approval 由 weftd 按策略自动应答）
- 多引擎（claude / opencode；交互式线程全面转向 Codex）
- lead_chat 引擎全部（engine / proto / delta_hub / out_hub / window /
  revive / rewind / sentinels）——被 app-server 取代
- 整个 `src/session/` 聊天 UI、Needs You 治理（仅保留看板 attention 信号）

## 3. 总体架构

```
weftd（独立 daemon，Rust；剥离 Tauri 壳）
├─ store      workspace / repo_ref / thread(issue) / direction / worktree / bus
├─ orchestrator   lead/worker 线程创建、brief 渲染、事件 → 状态推导
├─ curator    仓库录入与拆解（分析 turn → repo_profile → repo map）
├─ app-server client   codex_app_server.rs Stage 2（全局多路复用，keyed by thread）
├─ bus server   MCP-over-HTTP（bus/server.rs 原样，身份从 URL path 派生）
├─ materialize / git   worktree 创建与分支生命周期
└─ http        REST/SSE（UI）+ MCP（agent 工具）

Codex Desktop（官方，不修改安装包）
├─ 原生聊天：lead 线程 + 每个 direction 线程（共享 ~/.codex store）
└─ 扩展 UI（weftd serve 的 web app，经 CDP 注入挂载）
   workspace home / kanban / issue detail → 点击跳转原生线程
```

关键性质：

- 所有业务逻辑在 weftd，对 Codex 升级免疫；扩展 UI 是纯展示层。
- kanban 首先是一个独立 web app（浏览器可用），Desktop 嵌入只是宿主之一；
  注入被 Sparkle 更新打破时降级为浏览器标签页，不是瘫痪。
- 每个 direction 与"一个 Codex 线程 + 一个 worktree"一一对应，与现有
  `direction` 实体（单 repo 写入、branch、mandate、五态状态机）天然吻合。

## 4. 数据模型变更

- `thread`：+ `lead_codex_thread_id`（string, nullable）；删除 `lead_tool` /
  `lead_command`（恒为 codex app-server）；`lead_meta` 废止（session 面板
  由 Desktop 取代）。
- `direction`：+ `codex_thread_id`（string, nullable）。status 推导来源由
  引擎事件改为 app-server 线程事件 + 看板人工操作，五态不变
  （queued | planning | working | review | done）。
- `session` 实体废止（被 Codex 线程取代）；历史数据随客户端一起退役。
- `lead_message` / bus 记录保留。
- 迁移：一次性迁移脚本为存量 open issue 标记 `legacy`，不为其创建 Codex
  线程；新流程只服务新 issue。

## 5. 会话引擎替换：lead_chat → orchestrator

lead/worker 会话即 Codex 线程，由 weftd 经 app-server 创建与驱动：

- spawn lead：cwd = issue 主 repo（或 workspace 根），首条输入为 lead brief
  （issue 上下文 + 可用 MCP 工具说明）。
- spawn worker：materialize 出 worktree（repo_id + base_branch）→ 创建线程
  （cwd = worktree）→ 首条输入为 direction brief（按 mandate 渲染，
  plan+impl / impl-only，沿用现有 brief 模板）。
- 事件订阅：app-server notification → direction.status 推导
  （turn 进行中 = working；turn 完成 = review；error/idle 超时 = attention）。
- approval：app-server 把 approval 请求发给发起 turn 的 client（weftd）；
  weftd 按配置策略自动应答（默认接受只读与工作区内写入，其余拒绝并记录）。
  不做人工审批 UI。
- 线程对人类可见：线程写入共享 `~/.codex` store，出现在 Desktop 线程列表；
  人在 Desktop 打开线程即手动接管（此时 weftd 对该线程转为只观察）。

## 5.5 仓库录入与拆解（curator）

保留，且迁移顺手修复其已知脆弱点：

- 录入：repo_ref / repo_profile 实体与 Workspace home 的注册 UI 原样保留。
- 拆解执行层：从 `codex exec` one-shot（2026-06-18 spec 记录的 root cause——
  手写 argv 随 CLI 升级静默失效）切换为 app-server：
  - 每仓库分析 = 一个 **ephemeral** `thread/start`（不污染 Desktop 线程
    列表）+ 一个分析 turn；
  - 结构化产出走 `turn/start` 的 `outputSchema`（JSON Schema 约束最终
    消息），取代 `parse_repo_class` 式的文本解析；
  - 进度流 = app-server notifications → `repo_profile` run-state
    （idle | running | failed 语义沿用，重启可恢复）。
- 产物不变：tier / stack / summary / relations / monorepo components 仍落
  `repo_profile`；RepoMapView / RepoGraph（含 components 展开视图）作为
  扩展 web app 的第四个表面保留。

**已验证（2026-08-08 晚，Stage 2.5 真机冒烟）**：

- `outputSchema` 在 ChatGPT 后端**非严格**：管线完整（turn/start →
  turn_context → prompt → Responses `text.format` json_schema strict），
  但模型仍可能输出散文 + fenced ```json。weft 的平衡括号扫描作为兜底
  解析保留（取最后一个含必需键的对象），brief 里显式要求"最终消息只
  有 JSON"后收敛。Ephemeral 线程确认不落 rollout 文件、不进 Desktop
  线程列表。
- agent 的 layers 自然产出是**分组形** `{label, rank, repos: [...]}`，
  而非 weft 时代的单库形 `{repo_id, label, rank}`——schema 改为分组形，
  解析两种都容。repo 引用按名字或数字 id 双通道解析。
- stack/components 需容错包装：agent 会把 array 字段产出成裸字符串
  （weft `lenient_confidence` 同类经验）。
- relations-only 重跑（`POST /api/workspaces/{id}/analyze-relations`）
  独立于全量分析，供画像未变时快速迭代。

## 6. Bus 通信机制

现有设计平移，仅投递侧更换：

1. agent 调用其 per-thread MCP endpoint（`/bus/:thread/:dir/mcp`，身份从
   URL path 派生，不可伪造）。
2. weftd bus server 记录并路由（BusRegistry 原样）。
3. 投递：orchestrator 经 app-server 把消息作为输入注入收件方 Codex 线程；
   线程在 Desktop 原生聊天中展示该消息。
4. 收件方通过自己的 MCP 工具回复，闭环。

创建线程时为每个线程配置其专属 bus MCP URL。**已验证（2026-08-08 spike）**：
`thread/start { config: { mcp_servers: {...} } }` 生效，per-thread 配置可用；
查询须用 `mcpServerStatus/list { threadId }`（不带 threadId 只列全局配置）。

进行中线程的消息注入语义，**已验证（2026-08-08 spike）**：

- 线程空闲：`turn/start` 正常开新 turn。
- 线程有活跃 turn：**禁止用 `turn/start`**——服务端返回成功（新 turn id、
  status=inProgress）但该 turn 实际从不执行（无 `turn/started`，活跃 turn
  结束后也不补跑），等于静默丢弃。
- 活跃中注入必须用 `turn/steer { threadId, expectedTurnId, input }`：
  实测重定向生效（steer 消息与模型回应均进入历史）。因此 weftd 必须按线程
  跟踪当前活跃 turn_id（与 `turn/interrupt` 的前置条件相同）。
- 读完整历史用 `thread/resume`（`thread/read` 默认只回元数据）。

**已验证（2026-08-08 晚，Stage 2 真机闭环，weftd + 真实 app-server）**：

- MCP 工具 annotations 是硬性要求：codex core 把无 annotations 的工具视为
  destructive/open-world（`requires_mcp_tool_approval`），在
  approvalPolicy=never + Managed 沙箱下审批请求被自动拒绝，工具返回
  "user rejected MCP tool call"。bus_post 须声明
  `{destructiveHint: false, openWorldHint: false}`，bus_read 加
  `readOnlyHint: true`。**注册成功 ≠ 可调用**，spike 只验证了前者。
- 全链路闭环：direction 线程按 spec 建文件并提交 → bus_post 成功 →
  orchestrator steer/start 注入 lead 活跃线程（消息以 user 身份入历史）→
  lead 自主核验 direction 分支。watcher 把 TurnEnd 折成 kanban 状态
  （working→review）。
- direction 需要 `spec` 字段（任务正文）：无烟情况下 agent 只能从 direction
  名字猜任务（把 hello.txt 建成了 hello）。已加列 + brief 渲染。
- 线程落库：rollout 文件即写，`state_5.sqlite.threads` 表即见（Desktop
  线程列表读这里）；`session_index.jsonl` 有滞后，不作为可见性依据。
  API 建线程 source 默认 "vscode"，名称留空（Desktop 显示回退名）。

**已验证（2026-08-09，human takeover 边界与溯源）**：

- 溯源标注：codex 0.145.0 **没有** `--session-source` CLI 旗标（该参数只
  存在于更新的 codex-rs git 源码），`threads.source` 只能是 "vscode"。
  可用杠杆是 `thread/start { threadSource }`（v2 协议的自由串字段），
  原样落库到 `threads.thread_source`（probe_thread_source.py）。weft-codex
  全部线程携带 `threadSource: "weft-codex"`，可与人手开的 vscode/Desktop
  线程区分。注意：thread/start 只建句柄，sqlite 行要首个 turn 才物化。
- turn 生命周期通知**不跨 app-server 进程**（probe_takeover.py）：第二个
  app-server 模拟 Desktop 接管（thread/resume + turn/start），weftd 的
  watcher 收不到对方的 `turn/started`/`turn/completed`。因此 foreign-turn
  检测只对同进程启动生效；真正的静默丢弃防线是**启动确认**：同进程
  `turn/started` 必然到达（probe_turn_started.py），inject 在每次
  `turn/start` 后等 watcher 路由到匹配 id（3s 超时），缺确认即判定丢弃、
  清除幻影 active_turn、消息留 inbox 并发 `bus.undelivered`。真机复核：
  接管期间发消息 → 状态停在 review（不再出现幻影 working）→
  bus.undelivered 到达。局限：外部 turn 结束无信号，积压消息要等下一次
  wake 才补投（agent 侧始终可 `bus_read` 拉取）。
- 同一 watcher 上的 `turn/started` 若 id 与己方 active_turn 不符仍标记
  foreign（同进程接管场景），其 TurnEnd 时清标并冲刷积压——该路径保留，
  若 codex 将来提供跨进程线程通知即自动激活。

## 7. UI 表面（weftd serve 的 web app）

- Workspace home：workspace 切换、repo 注册与状态。
- Kanban：direction 卡片按 status 分列；卡片显示 repo / branch / mandate /
  attention 信号；拖拽改状态。
- Issue detail：lead 卡片 + direction 卡片列表，各自跳转 Desktop 原生线程；
  bus 活动时间线（**已完成 2026-08-09**：看板标题点击进入独立详情视图，
  时间线聊天式渲染 + `bus.message` SSE 实时刷新）。
- Repo map：仓库依赖图与 components 展开视图（RepoMapView / RepoGraph 平移）。
- 全部 i18n 字符串沿用 en/zh 双文件约束。
- **主题同步（2026-08-09 落定，引用式而非快照式）**：Codex 本身的主题可
  配置（dark/light、corner-radius scale），所以 web app 不硬编码颜色，
  而是**引用宿主 CSS token**——每个语义变量形如
  `var(--color-token-…, fallback)`：嵌入 Codex 应用（Weft mode）时宿主
  实时 token 生效，宿主切主题我们零成本跟随；独立浏览器里 fallback
  呈现 codex-dark 解析值（`prefers-color-scheme: light` 时切 codex-light
  解析值）。token 名逐一核对自发行包（ChatGPT.app webview 资产）：
  表面 `--color-token-main-surface-primary` /
  `--color-token-dropdown-background` / `--vscode-sideBar-background`、
  文本 `--color-token-foreground` / `--color-token-text-secondary`、
  边框 `--color-token-border` / `--color-token-border-heavy`、
  accent `--color-token-primary`（经 link-foreground → blue-500
  `#0169cc`）/ `--vscode-button-hoverBackground` /
  `--color-token-button-foreground`、链接
  `--color-token-text-link-foreground`、状态色
  `--color-token-charts-green|yellow|red`、表单
  `--color-token-input-background|border`、字体 `--font-sans` /
  `--font-mono`、圆角 `--radius-lg|md|sm`（随宿主 corner-radius-scale
  缩放）。已实测三层：dark fallback（`#131313`/`#fcfcfc`/`#0169cc`）、
  light fallback（`#fcfcfc`/`#0d0d0d`）、宿主注入任意主题（紫系 +
  radius 20px）时全部变量跟随宿主而非 fallback。

## 7.5 模式切换（Weft mode）

入口级模式开关，挂载到应用既有的顶层模式切换上：应用本身已有
Work（everyday work）/ Codex 双模式（bundle 实证：`isEverydayWorkMode`、
跨模式 handoff 链接），Weft 作为**第三个并列模式**加入，而不是自造一套
独立开关：

- Weft 模式下隐藏 Codex 常规会话列表与无关聊天入口，只保留 workspace /
  issue / kanban / repo map 表面；线程聊天仍使用原生线程视图（唯一不隐藏
  的原生表面）。
- 线程归属数据化：weftd 创建线程时设置 `threadSource` 并遵循命名规范，
  模式过滤基于 weftd store 中的 issue/direction 归属关系判定，不靠 DOM
  结构猜测。
- 实现分层：
  - Tier 1（默认，additive）：原生 UI 不动，仅注入 workspace 入口与视图。
  - Tier 2（Weft mode，subtractive）：隐藏原生侧边栏会话区并挂载
    workspace 导航。按版本做结构 probe，不匹配时 **fail-open 回 Tier 1**
    （宁可露出原生 UI，不可藏错或藏坏）。
- 开关形态（优先级从高到低）：
  1. 既有模式切换器加第三项 Work / Codex / **Weft**——用户已理解的模式
     语义，一等 UI 锚点也比侧边栏内部结构更稳定；
  2. launcher flag 决定启动默认模式；
  3. 自有 toggle（持久化在 weftd 侧）——模式切换器结构 probe 失败时的
     回退，保证 Weft mode 永远可达。
- 浏览器降级路径天然就是 Weft mode 的完整形态（没有任何 Codex chrome）；
  只有 Desktop 嵌入路径需要 Tier 2。

桌面嵌入：launcher 以 `--remote-debugging-port` 启动 ChatGPT.app（不改包、
不破签名），经 CDP 挂载上述 web app 到侧边栏入口；Host 在 launcher 进程，
renderer 仅 thin surface agent，通信走 CDP binding。未知版本 fail-closed
进入 safe mode（不注入，提示用浏览器打开）。

## 8. 删除清单

- `src/session/` 全部（ChatTimeline / WorkerConversation / LeadTab /
  SessionInfoPanel / transcriptBits / MindMapEditor 等）
- `src-tauri/src/lead_chat/` 全部
- `src-tauri/src/ask.rs`、approval 相关命令
- claude / opencode 适配（`claude.rs` / `opencode.rs` 及 engine routing）
- `curator.rs` 的 `run_agent_once` exec 路径（分析改走 app-server，见 5.5）
- Tauri 壳（commands.rs 的 UI 命令、窗口、WebView 配置）；`codex.rs` 的
  exec 路径在 Stage 2 切换后删除

## 9. Spike 验证项（先于一切实现）

Desktop 相关（1、3）待验；app-server 相关（2、4、5）**已于 2026-08-08 验证**，
脚本与日志在 `docs/superpowers/spike-app-server/`：

1. `open -a ChatGPT --args --remote-debugging-port=...` + CDP attach 稳定，
   注入脚本活过页面导航与会话切换；探针需同时覆盖 Tier 2 所需的侧边栏
   结构与顶层模式切换器锚点（见 7.5）。**（待验）**
2. weftd 经 app-server 创建的线程出现在 Desktop 线程列表，事件订阅正常。
   **PASS（store 层）**：`thread/start` 后 `session_index.jsonl` 同步写入、
   `state_*.sqlite threads` 表异步落库（秒~分钟级滞后，`thread/list` 读该表），
   `thread/resume` 正常。Desktop 视觉确认待做（遗留两个名为
   `weft-spike-20260808` 的测试线程供人工查看）。
3. 从扩展内以编程方式跳转指定线程。**PASS（静态证据）**：`codex` scheme
   已在 ChatGPT.app Info.plist 注册；app bundle 内确认路由
   `codex://threads/<threadId>` 被官方 Chrome 扩展的 "Open in app" 用于
   线程跳转（另有 `codex://threads/new`、`codex://settings/connections`）。
   仅剩运行时确认（运行中 app 的聚焦/导航行为），随 Desktop spike 一起做。
4. per-thread MCP 配置能力。**PASS**：见第 6 节。回退方案不触发。
5. 进行中线程注入语义。**PASS**：见第 6 节。关键结论：bus 投递在活跃 turn
   期间必须用 `turn/steer`，`turn/start` 会被静默丢弃。

附带的协议经验（写入 weftd 实现注意）：

- app-server stdout 单行可超 64KB，reader 必须用大缓冲。
- `approvalPolicy: "never"` + 只读沙箱下无任何 approval/elicitation 请求。
- API 创建的线程 `source` 默认为 `"vscode"`；weftd 应设置
  `threadSource` / `sessionStartSource` 做正确分类。
- weftd 自行持久化 thread_id 与活跃 turn_id，不依赖 `thread/list` 的
  索引时效。

任何一条不成立：UI 通道降级为纯浏览器 web app（产品仍成立），bus/编排
不受影响（不依赖注入）。

## 10. 分阶段落地

- Stage 0：Spike 五项（days 级）。
- Stage 1：weftd 抽离——`src-tauri` 核心剥为独立 daemon（axum server 已有），
  Tauri 客户端同期继续可用。
- Stage 2：orchestrator——`codex_app_server.rs` Stage 2 接线 + lead/worker
  spawn + bus 投递 + 事件 → 状态推导。本迁移最大的一块。
- Stage 3：扩展 UI v1——workspace home + kanban + issue detail（**web app 已
  完成并浏览器实测**：三视图、拖拽、SSE 自刷新、codex:// 深链；注入嵌入
  随后，依赖 Desktop spike）。
- Stage 4：切换——新 issue 全走新流程；停发 Tauri 客户端；删除清单落地。

## 11. 风险与对冲

- Codex 平台演进吃掉编排层：编排逻辑在 weftd 内、UI 是薄皮，官方若推出
  原生多 agent 编排，迁移成本限于 UI 层。
- 注入脆弱性：fail-closed + 浏览器降级路径（见第 3、9 节）。
- app-server 协议漂移：`generate-ts` / `generate-json-schema` 生成绑定，
  min-version 硬开关（沿用 Stage 2 既定策略）。
- 多引擎损失：接受。若未来需要，非 Codex 引擎以无头任务形态回归，
  不进入 Desktop 聊天表面。
