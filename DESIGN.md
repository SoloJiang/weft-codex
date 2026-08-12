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
| `body` | 12px | 1.45 | 正文、行标题、控件文本 |
| `label` | 11px | — | 分区标题、计数、字段标签 |
| `meta` | 10.5px | 1.35 | 次要说明、产物元信息 |
| `micro-caps` | 9.5px | — | 全大写类型徽标，字距 0.03em |

新增文本从上表取值。当前代码尚存 14 个字号，上表是收敛目标而非现状。

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

| 层级 | 构造 | 用于 |
|---|---|---|
| 字段 | `0 0 0 0.5px var(--border-strong)` + `0 3px 7.5px rgb(0 0 0/.04)` | input、textarea |
| 字段·悬停 | ring 提至 `color-mix(in srgb, var(--text) 26%, transparent)` | input、textarea |
| 字段·错误 | `0 0 0 1px var(--danger)` + 同上投影 | `aria-invalid` |
| 浮层 | `0 0 0 0.5px var(--border)` + `0 3px 7.5px rgb(0 0 0/.04)` + `0 12px 32px rgb(0 0 0/.12)` | select-content |

保留 `border` 的唯一情形是透明控件的 `1px solid transparent`——占位以避免悬停时
尺寸跳动。

### 焦点环

```css
outline: 2px solid var(--focus);
outline-offset: 2px;
```

全站唯一焦点表现，由 `index.css` 单条规则统管，**不叠加 ring 或 box-shadow**。

输入框同样带环。宿主的 command menu 输入框无环属**例外**——模态内自动聚焦、独此
一个；其按钮、侧栏行、下拉触发器均带环，密集并列的字段适用通则。

## Shapes

| 级别 | 值 | 用于 |
|---|---|---|
| `sm` | 7.5px | 密集行：issue 行、待办行、思维导图行、卡片菜单触发器 |
| `md` | 10px | 单行控件、图标按钮 |
| `lg` | 12.5px | 多行控件、列表项、行按钮 |
| `xl` | 15px | 浮层 |

宿主参考：图标触发器 10px · 菜单项与行按钮 12.5px · 模式按钮与浮层 15px ·
composer 25px。

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
