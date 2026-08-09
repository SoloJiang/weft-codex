# Product

## Register

product

## Users

需要在本地同时协调多个代码仓库、围绕 issue 拆解并推进复杂工程任务的开发者。用户在 Codex 中查看 workspace、仓库、issue、任务与看板，并在必要时进入原生线程与 lead 或 worker 协作。

## Product Purpose

把 Weft 的多仓库编排、issue 拆解、lead/worker、线程通信、worktree、workspace 与 kanban 能力移入 Codex，同时把聊天、主题、语言和基础应用体验交给 Codex 原生能力。成功状态是用户感觉自己始终在使用 Codex，只是多了一套 issue 驱动的工程编排工作区。

## Brand Personality

原生、克制、任务导向。界面应安静地服务工程工作流，不建立独立于 Codex 的品牌壳或视觉语言。

## Anti-references

- 不呈现成另一个 Weft 客户端或嵌在 Codex 里的外来管理后台。
- 不向用户暴露 direction、bus 等内部实现概念。
- 不使用“在 Codex 中打开”等暗示当前体验不属于 Codex 的文案。
- 不重复 Codex 已有的主题、语言、聊天或模式能力。
- 不使用与 Codex 不一致的控件、图标、间距、颜色或交互模式。

## Design Principles

- Codex 原生体感优先：扩展能力融入宿主，产品边界尽量不可见。
- Sidebar 只承载全局导航：workspace、kanban、仓库、issue 与 attention 摘要；
  仅允许单字段的新建 issue，复杂表单和任务操作留在主工作区。
- 以 issue 和任务表达工作：direction 只作为内部编排实体存在。
- Lead 拥有任务拆解权：任务只能由 lead 会话创建，用户界面不提供手工新建任务。
- 运行时健康状态默认不可见，只有具体失败需要进入用户界面。
- 编排与聊天分层：Weft mode 管理工程上下文，沟通使用 Codex 原生线程。
- 复杂度渐进披露：默认界面只呈现完成当前动作所需的信息。
- 跟随宿主：主题、语言、模式入口和通用交互尽量复用 Codex。

## Accessibility & Inclusion

至少保持 Codex 宿主同等级的键盘可达性、可见焦点、明暗主题对比度和系统语言适配；动效尊重 reduced-motion，状态不能只依赖颜色或无文本图标表达。
