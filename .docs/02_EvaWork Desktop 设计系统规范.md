# EvaWork Desktop · 设计系统规范

本文件描述**当前代码里真实存在**的设计约定，不是愿望清单。落地位置：`apps/desktop-ui/src/styles/app.css`（全局令牌与通用类）+ 各组件 `<style scoped>`（页面级样式）。

## 1. 两套视觉体系

| 体系 | 用于 | 落地 |
|---|---|---|
| 亮色主壳 | 全部主壳页面（`#/`、`#/market`…）与浮层 | `app.css` 的 `:root` 令牌 |
| 深色控制台 | 管理账户 `#/admin/*` | 各 admin 组件内硬编码色值（**尚未抽成令牌**，见第 7 节技术债） |

## 2. 亮色令牌（`styles/app.css` 的 `:root`）

| 类别 | 变量 | 值 |
|---|---|---|
| 背景 | `--bg` | `#f5f6f7`（应用底色） |
| | `--panel` | `#ffffff`（卡片/弹层） |
| | `--line` | `#ebecee`（常规描边） |
| | `--line-2` | `#f1f2f3`（浅底、hover 底） |
| 文字 | `--t1` | `#212429`（主文字） |
| | `--t2` | `#868c94`（次要文字/说明） |
| | `--t3` | `#b9bec5`（占位符、图标） |
| 语义色 | `--green` / `--green-bg` | `#0cb277` / `#e5f7f0` |
| | `--blue` / `--blue-bg` | `#4d80f0` / `#ecf2fe` |
| | `--violet` / `--violet-bg` | `#5b57d9` / `#efedff` |
| | `--orange` / `--orange-bg` | `#e8930c` / `#fdf3e1` |
| | `--red` / `--red-bg` | `#e5484d` / `#fdebec` |
| 强调 | `--ink` | `#1b1c1f`（深色按钮底） |
| 形状 | `--radius` | `12px`（卡片圆角） |
| | `--shadow` | `0 8px 32px rgba(23,25,30,0.12)` |

其它全局约定：字号 14px；字体 `'Segoe UI', 'Microsoft YaHei', system-ui, -apple-system, sans-serif`；滚动条 8px、滑块 `#d6d8db`；`user-select: none`；`button/input/textarea` 全部重置为继承字体与透明背景。

## 3. 深色控制台色值（管理账户）

| 用途 | 值 |
|---|---|
| 页面底色 | `#0c0d0e` |
| 卡片/面板 | `#141517`（次级块 `#101112` / `#1b1d1f`） |
| 描边 | `#212325`（浅分隔 `#1e2022`） |
| 主文字 | `#e6e8e9` |
| 次要文字 | `#a6abaf` / `#8b9094` / `#6f7478` |
| 强调绿 | `#24d07a`（浅 `#7fd8a5`） |
| 侧栏选中 | `#1d1f22`，hover `#17181a` |

## 4. 字体与层级

| 层级 | 规格 |
|---|---|
| 页面标题 `.page-title` | 24px / 700 / 字距 0.2px |
| 页面副标题 `.page-sub` | 13px / `--t2` |
| 区块小标题 | 14px / 600 |
| 卡片标题、行标题 | 13–13.5px / 600 |
| 正文 | 13px |
| 说明、时间、辅助 | 11.5–12px / `--t2` |
| 等宽（版本号、命令名、权限范围） | `ui-monospace, Menlo, Consolas, monospace` |

## 5. 通用组件类（`app.css`）

| 类 | 用途 | 关键点 |
|---|---|---|
| `.page` / `.page-head` / `.page-title` / `.page-sub` | 页面容器与页头 | `.page` 内边距 36px 44px，最宽 1280px |
| `.grid3` | 三列卡片网格 | gap 16px |
| `.btn` / `.btn-dark` / `.btn-green` / `.btn-link` / `.btn-plain` | 按钮五态 | 高 32px、圆角 8px |
| `.icon-btn` | 纯图标按钮 | 正方形，hover 出浅底 |
| `.card` | 卡片容器 | 白底 + `--line` 描边 + 12px 圆角 |
| `.tag` + `.tag-green/orange/violet/blue/gray` | 标签 | 11px、圆角 6px、语义底+语义字 |
| `.badge` | 未读数 | 红色小圆标 |
| `.seg` / `.seg-item` | 分段切换（Tab、账单周期） | `.seg-item.active` 浅灰底；`.on-dark` 用于深色底 |
| `.chip` / `.chip.active` | 分类胶囊 | 可换行（`flex-wrap`） |
| `.input` / `.search-box` | 输入框、搜索框 | 搜索框是"图标 + 无边框 input"的组合 |
| `.switch` / `.switch.on` | 开关 | 打开时 `--green` |
| `.radio-card` / `.radio-dot` | 可点选的大卡片（审批模式等） | 带标题+说明 |
| `.modal-mask` / `.modal` / `.modal-title` / `.modal-close` | 弹层 | 遮罩点击自身关闭 |
| `.row-card` | 行式列表项 | 图标 + 主信息 + 操作区 |
| `.empty` / `.empty-icon` | 空态 | 居中、64px 上下留白、说明文字 |
| `.muted` / `.small` | 次要文字 / 12px | |

## 6. 图标系统

- **全部内联 SVG**，无图标字体、无雪碧图、无位图。统一 24×24 视窗、`stroke` 描边、`currentColor` 取色。
- 字典在 `src/components/icons.ts`（62 个键），组件 `src/components/UIcon.vue` 通过 `v-html` 渲染，`size` 以 px 传入。
- **缺 key 不会报错，但会渲染空路径**（静默空白）。新增图标前先确认字典里有没有同名键。
- 常见键：`plus / send / mic / search / chevron-* / x / check / user / bell / gear / globe / star / zap / shield / cloud / code / box / book / doc / video / image / slides / chart / database / github / link / qr / sparkle / palette / clock / folder / grid / list / upload / download / refresh / filter / dots / arrow-* / home / key / monitor / phone / web / table / bag / help / logout / sliders / sun / card / external / info / calendar`。

## 7. 图形与插画原则

- **不引入外部图片**：二维码、活跃热力图、设计系统色板、模板封面、Hero 插画、手机 mock 全部用 CSS 渐变、圆角方块与几何图形拼出来。
- 模板库封面有 7 种装饰形态：`bars / radar / chart / kpi / site / photo / doc`，由 mock 数据的 `deco` 字段决定。
- 需要"确定性"的视觉噪声（如 53×7 活跃热力图）用固定算式生成（`(i * 7919) % 23`），避免每次渲染跳变。

## 8. 交互与状态约定

- 有列表就有**空态**：空态要说清"为什么空"和"怎么才有内容"（参考收藏盒、我的文件、执行历史）。
- 有搜索/分类就要**真的过滤**；过滤后为空要有对应文案，不允许静默无变化。
- 控件禁用要看得出来（如首页发送按钮在空输入时禁用）。
- 悬停态统一：按钮 hover 换底、导航 hover 出浅底、卡片 hover 加深描边。
- 弹层统一从 Pinia `ui` store 的开关读写，关闭方式一致（关闭按钮 + 点遮罩）。

## 9. 技术债（影响一致性，记在这里以免忘记）

1. 深色控制台色值是**逐组件硬编码**，没有令牌；主壳若要做暗色需先抽主题变量。
2. 主壳与管理账户有**两套按钮/面板样式**（`.btn-a`、`.panel` 等 admin 侧自造类），未合并。
3. 语言（简体中文/English/日本語）与主题（亮色/暗色）入口只改文案，没有 i18n 与主题切换实现。
4. 无动效规范与统一的过渡时长；目前各处零散写 `transition: 0.15s`。
