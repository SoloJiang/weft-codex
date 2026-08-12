# Design

PRODUCT.md 说「跟随宿主」「不使用与 Codex 不一致的控件、间距、颜色或交互模式」。
这份文档把那句原则变成可执行的东西：**跟到什么程度、具体是哪些数值、宿主没给答案
时怎么办、以及怎么证明自己真的跟上了。**

三份文档分工，不要混写：

| 文档 | 回答 | 性质 |
|---|---|---|
| `PRODUCT.md` | 我们在做什么产品、什么不做 | 原则，很少变 |
| `DESIGN.md`（本文） | 控件长什么样、怎么构造、怎么验证 | 规则，随宿主版本演进 |
| `docs/compat/codex-builds.md` | 某个 build 上实测到了什么 | 回归基线，只追加不改写 |

**本文所有数值都是真机实测**（Codex Desktop build 6321，2026-08-11），不是设计稿也
不是估计。宿主大版本变化后这些数字可能全部失效——重测的方法见 §8。标注了主题的
数值只在该主题下成立，另一主题需另测。

---

## 1. 第一原则：宿主是真相，不是参考

用户的成功状态是「感觉自己始终在使用 Codex」。因此：

> **任何"看起来差不多"的自造值都是 bug，哪怕它更好看。**

判据只有一条：

1. 这个控件在宿主里**有**对应物 → 照抄它的构造（不是照抄观感，是照抄 CSS 构造）
2. **没有**对应物 → 走 §6 的流程，并把理由写进代码注释

不接受的理由：「宿主那个值不好看」「我们的场景不一样」「差 1px 看不出来」。前两条
要走 §6 留证，第三条是错的——1px 边和 0.5px ring 肉眼可辨，这正是我们踩过的坑。

## 2. Token：只用转发的，不自造

宿主 token 经 renderer agent 转发进 Host Context，`ui/src/index.css` 把它们映射成
本地语义变量。**不要在组件里直接写颜色值。**

| 本地变量 | 宿主 token | 实测（浅色 / 深色） |
|---|---|---|
| `--text` | `--color-token-foreground` | `#383a42` / `#abb2bf` |
| `--border` | `--color-token-border` | `rgba(56,58,66,.078)` / `rgba(171,178,191,.084)` |
| `--border-strong` | `--color-token-border-heavy` | `rgba(56,58,66,.117)` / `rgba(171,178,191,.156)` |
| `--hover` | `--color-token-list-hover-background` | — / `rgba(171,178,191,.078)` |
| `--accent` | `--color-token-primary` | `#526fff` / `rgb(146,173,224)` |
| `--panel-2` | `--color-token-dropdown-background` | `rgb(251,251,251)` / `rgb(52,56,65)` |
| `--focus` | `--color-token-border` | 同 `--border` |
| `--r-sm/md/lg` | `--radius-sm/md/lg` | `7.5 / 10 / 12.5px` |

### 2.1 三条硬约束

**`--focus` 就是 border token，不是独立颜色。** 宿主把它写在自己的控件类上：
`focus-visible:outline-2 outline-offset-2 outline-token-border`。照用。

它很淡（~8% alpha），焦点可见性明显弱于常见无障碍基线。**这是已知且已接受的后果**：
对齐宿主是规则本身，宿主是基准而不是下限，不因为我们觉得某个值不够好就单方面调高。
真要改，那是产品层面推翻「对齐宿主」的决定，先改 PRODUCT.md，再改这里，最后才改
`--focus`——不要反过来从一行 CSS 开始。

**rem 单位的 token 必须在宿主侧解析成 px 再转发。** `rem` 按**消费方**根字号解析：
Codex 根字号 16px，Weft 表面是 13px。直接转发 `calc(.375rem * 1.25)` 会让每个圆角
小 19%（7.5px → 6.09px）。`renderer-agent.ts` 的 `usedLength()` 用探针元素解析后
转发，按根字号缓存（context 每次 mutation 都发布，探针会触发 layout）。

**不要拿 `aria-label` 或文案当锚点。** 它随宿主界面语言变。宿主的搜索/活动按钮
身上没有任何 `data-app-action-*`，唯一可区分的就是 `aria-label`——正确做法是按
**结构**定位（「模式行里除模式按钮之外恰好一个元素子节点」），探针与运行时共用
同一条判据。

## 3. 构造规则

这一节是本项目最容易做错的地方：**观感对了不代表构造对了**，而构造错了在宿主旁边
一眼就能看出来。

### 3.1 边 = ring + 投影，不是 border

宿主**从不用 `border` 画边**。实测它的 composer：

```css
border: 0;
box-shadow: 0 0 0 0.5px rgba(fg, .157), 0 3px 7.5px rgb(0 0 0 / .04);
background: <半透明表面>;
```

菜单浮层是同一构造、更淡的 alpha（`.082`）。1px 实线边在它旁边明显更重——**这才是
表单控件「像网页表单」的根本原因**，比圆角和填充更致命。

所以本项目：`input` / `textarea` / 浮层一律 `border: 0` + hairline ring + 投影。
只有需要占位不跳动的透明按钮才保留 `border: 1px solid transparent`。

### 3.2 focus 只有一层

```css
outline: 2px solid var(--focus);
outline-offset: 2px;
```

全站唯一的 focus 处理，`index.css` 里那一条规则统管。**不要再叠 ring/box-shadow。**
历史教训见 §7.1。

输入框同样有 ring。宿主的 command menu 输入框确实没有，但那是**例外而非通则**——
它在模态里自动聚焦、独此一个，没有需要区分的对象；宿主的按钮、侧栏行、下拉触发器
都带。我们的字段在密集单列里并排存在，适用的是通则。

### 3.3 hover = 前景色透明度，不换色相

宿主表达强调的方式是「在前景色上加 alpha」，不是切换到另一个颜色。行按钮 hover 是
`rgba(fg, .078)` 底色；字段 hover 提升 ring 的 alpha。**不要引入主色 hover。**

### 3.4 圆角随尺寸分级

宿主实测：图标触发器 `10px` · 菜单项与行按钮 `12.5px` · 模式按钮与浮层 `15px` ·
composer `25px`。

规则：单行控件 `--r-md`，多行控件与列表项 `--r-lg`，浮层 `15px`——15px 对应不到
任何已转发的 token（`--r-lg` 是 12.5px），所以写字面值并在注释里注明它是实测来的。
若将来发现宿主对应的 token，换回 token。

## 4. 控件清单

| 控件 | 宿主实测 | 本项目 |
|---|---|---|
| 图标按钮 | h32、radius 10px、1px 透明边、透明底 | 同 |
| 行按钮 | radius 12.5px、padding 5px 8px、hover `rgba(fg,.078)` | 同 |
| 下拉触发器 | **不是 `<select>`**：透明按钮 + Radix menu | Radix Select，透明触发器 |
| 浮层 | radius 15px、`border:0`、ring `.082` 0.5px + 投影、padding 4px | 同 |
| 菜单项 | radius 12.5px、padding 5px 8px | 同 |
| 单行输入 | 全站仅一个（command menu）：`border:0`、透明底、radius 0、无 ring | `border:0`、ring `--border-strong` + 投影、radius `--r-md`、有 ring（§3.2） |
| 多行输入 | composer：radius 25px、ring `.157` + 投影 | 同构造，radius `--r-lg` |
| focus | `outline 2px` / `offset 2px` / border token | 同 |

**宿主全应用 0 个 `<select>`、0 个 `aria-haspopup="listbox"`、14 个
`aria-haspopup="menu"`。** 任何新的下拉都必须是 button + popover，不许回到原生
`<select>`。

### 4.1 快捷键：宿主已占的不要抢

`⌘/` 可调出宿主自己的快捷键表，那是权威来源。已知被占用且与我们相关的：

| 功能 | 绑定 |
|---|---|
| Open command menu | `⌘K`、`⇧⌘P` |
| Toggle activity view | `⌥⌘U` |
| Find | `⌘F` |
| Search Files… | `⌘P` |
| Switch to Chat / Work / Codex | `⌃1` / `⌃2` / `⌃3` |

而且这些绑在 **Electron 菜单 accelerator 层**——renderer 大概率收不到，也就无从
拦截。所以 Weft 搜索用 `/`（无修饰键，且需 `isTypingTarget()` 守卫）。
**新增快捷键前先查这张表。**

## 5. 层叠规则：unlayered 永远赢 Tailwind

`ui/src/index.css` 在 `@import "tailwindcss"` 之后写的裸元素规则是 **unlayered**，
而 Tailwind utilities 在 `@layer` 里。**unlayered 永远赢 layered**，与选择器权重无关。

因此本仓库的分工是固定的：

- **视觉属性写 `index.css`**（尺寸、颜色、圆角、边、状态）
- **组件只留结构与行为**（`data-slot`、a11y 属性、事件）

在 shadcn 组件上堆 Tailwind 视觉类是无效的——它们看起来在工作，实际一个都没生效。
唯一的例外是 `index.css` 没有声明的属性（比如 box-shadow 曾经就是），那种"漏网"
恰恰是最难查的 bug 来源。

## 6. 宿主没有答案时怎么办

宿主是聊天应用，没有多字段表单、没有看板、没有 issue 列表。这些地方必须自己决定。
流程：

1. 找**最近的**宿主对应物，继承它的构造（ring 而非 border、alpha 而非色相、同一套
   radius 分级）
2. 只在**确有必要**处偏离，且偏离幅度最小化
3. **把理由写进代码注释**，包含"宿主是怎么做的"和"为什么这里不能照做"

注意区分两种情况：宿主对同一件事有**两种行为**时，跟通则、不跟例外，那不算偏离
（focus ring 就是这样，见 §3.2）。本节只收宿主**确实没有对应物**的决定。

已有的两个先例，可作为判据的参照：

**6.1 面板覆盖而非挤压。** 搜索/收件箱面板 `position: absolute; inset: 0` 盖住
侧栏，而不是把下面的树推开——它们是瞬时的，重排整棵树会让人丢失阅读位置。

**6.2 `bus.parked` 不进收件箱。** 它表示人正在该线程上说话、turn 结束会自动 flush，
不需要任何人做任何事。列出来只会让收件箱塞满"读着读着就自己好了"的条目。收件箱只
放真正等人处理的东西。

## 7. 反模式（都是本仓库真实犯过的）

**7.1 两层 focus 环。** shadcn 的 `focus-visible:ring-3` 走 box-shadow，躲过了
`index.css` 的覆盖，和 outline 叠成 ~7px 的环。**新增组件时删掉自带的 ring 类。**

**7.2 给降级路径开特例。** 曾让 focus 在有宿主时用 border token、无宿主时用饱和蓝。
错的：两条路径应是同一套构造，只是取不到宿主调色板。**`--fb-*` 的职责是复刻宿主的
约定，不是另立一套。**

**7.3 拿 locale 文本当锚点。** 见 §2.1。

**7.4 用 rem token 不做换算。** 见 §2.1。

**7.5 把死代码当活代码维护。** `.select-shell` 曾有近 30 行样式（自绘箭头、
focus-within 变色、disabled 降透明），没有任何组件在用。改样式前先确认它真的生效。

## 8. 怎么验证

**不要靠肉眼，也不要靠推理。** 这一节的每条都对应一次真实误判。

**8.1 用 `CSS.forcePseudoState`，不要用 `.focus()`。** 程序化 focus 不匹配
`:focus-visible`。用它测出的"没有 focus 环"是假的——本仓库在宿主和自己身上各误判
过一次。

**8.2 先确认 daemon 服务的是哪份 bundle。** `ensureWeftd()` 会复用默认 URL 上
**任何**健康的 daemon。跑私有实例三个参数一起给：

```bash
node launcher/dist/cli.js start --weftd-url=http://127.0.0.1:<空闲端口> --weft-home=<私有目录> --profile-dir=<私有目录>
```

只给 `--weft-home` 不给 `--weftd-url` 时，若默认 URL 上已有 daemon，`--weft-home`
**完全不生效**，数据会写进默认 home。验证前 `curl <weftd>/ | grep assets/` 对一下
hash。

**8.3 无宿主路径这样测**：剥掉 sidebar iframe `documentElement` 上宿主写入的全部
inline 自定义属性，同一张样式表就会落到 `--fb-*`，即标准的无宿主状态。比另起一个
浏览器实例更省事，且保证是同一份构建。

**8.4 null 结果不是结论。** 合成事件没反应可能是事件没送达（`⌘K` 那次就是被 OS
菜单层拦下）。先验证探针本身有效（能测到已知为真的东西），再解读 null。

**8.5 属性是否存在可以静态求证，属性的语义必须运行时验证。** 见
`docs/compat/codex-builds.md` §5.1 的订正记录。

---

## 改这份文档的规矩

- 数值变了 → 先在真机上重测，同时更新 `docs/compat/codex-builds.md` 的对应行
- 新增偏离宿主的决定 → 写进 §6，附理由，不要只留在代码注释里
- 又踩了一个坑 → 加进 §7 或 §8。**这两节的价值来自它们都是真事**，不要填入
  未曾发生的假想反模式。
