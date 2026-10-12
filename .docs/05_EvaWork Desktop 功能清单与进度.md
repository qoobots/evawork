# EvaWork Desktop · PRD 任务清单（Electron + Python）

> 本文档由「功能清单与进度」升级为 **PRD 任务清单**：把界面原型阶段的功能清点，转成可排期、可验收、可追踪的实施方案。
> 技术栈已定：**Electron 主进程 + Vue 渲染层（复用）+ Python 智能体后端（FastAPI）**。详见 `04_技术架构文档`。

## 0. 基线说明

- **前端现状**：Vue 界面（18 路由 / 27 组件）已按稿完成，数据来自 `data/mock.ts`，属"界面原型"阶段。
- **后端现状**：`apps/desktop-py` 智能体内核雏形完成——任务状态机、SSE 事件流、真实模型接入（OpenAI 兼容协议）、审批策略三档；离线冒烟测试全绿（`pnpm smoke`）。
- **环境限制（2026-09-25 复核）**：出网经 **TLS 拦截代理**（代理根 CA 在 Windows 系统证书库）。git 用 `http.sslbackend=schannel` 读系统库 → `git push` 通；npm registry 直连 200；但 **Node 默认不信任代理 CA** → 直连 `github.com` 报证书错，electron 二进制此前下载失败。解法：`NODE_OPTIONS=--use-system-ca`（Node 24）或 `NODE_EXTRA_CA_CERTS=<代理根CA>`。已实测：设该变量后 `pnpm rebuild electron` 成功下载 v31.7.7（~172MB），`electron.exe --version` 正常。故 T-000/T-003/T-004 的阻塞已解除，待实机启动验证。Python 后端能力全部离线可用。
- **目标**：把"看起来能用"的 Mock 界面，逐个接成"真能用"的真实能力，并补齐工程能力（持久化、加载态、主题化、a11y、打包）。

> **⚠️ 文档复核（2026-09-25）**：本文档曾严重滞后于代码——经逐文件核对，T-000/T-003/T-020/T-024/T-030/T-031/T-041 等"标注未做"的任务**实际已在代码中完成**，而 T-061 被错误标为已完成（零实现）。本次已全量修正任务表与细化块。**T-004 打包已可出 NSIS/免安装包**（壳+UI+后端随包分发，且**自带 Python 运行时**，不再要求用户装 Python）。T-053 axe 自动走查已落地（18 路由 0 违规）。P1/P2 任务已全部闭环；a11y 自动走查 18 路由=0 违规（T-053）；**T-004 的 Python 运行时捆绑已完成并端到端验证**（捆绑 python 能起 `python -m evawork` 并返回 health）。**admin 深色样式令牌化已完成**（11 个 admin 页面 224 处写死色值→`.admin-console` 令牌，零视觉回归）。剩余——dmg（macOS，用户暂缓）。**实机双击启动验证 ✅ 已完成**（2026-09-25：双击打包 exe 实机启动，壳+捆绑 Python 后端+UI 本地服务全链路 OK、无崩溃；当前 dist UI 经 e2e 18/18 渲染验证）。现有打包嵌入 0.1.0 旧 dist，`pnpm dist` 重建被本沙箱环境拦截（npm 安装/批量删除安全机制），需你本地执行。请以任务表为准。**（2026-09-25 追加）新增 Epic E7「Harness 能力复刻」（T-070~T-080）**：对照 `deepseek-harness`（已同步 `477b4f4205` / 0.1.7-rc.2）移植真实 agent 编排与工具生态——核心是 T-070 把 `runner.py` 的"关键词猜 action"升级为 harness 式 **tool-use 循环**（根因：`_openai_stream` 只取 `delta.content`，丢弃了模型 `tool_calls`）。同时记录一条前置依赖：E1 各列表当前仍以 `data/mock` 兜底，复刻前应改为"在线拉真实 + 离线兜底"。**（2026-09-26 追加）T-070「Agent 内核 tool-use 循环」已完成**：模型真正决定调用哪个工具（不再由关键词猜 action），工具结果回填形成闭环，审批 gate 覆盖模型发起的调用，UI 可见 `tool_call`/`tool_result`；验证含真 socket 假 OpenAI 端点的端到端用例。E7 下一个推进项为 T-071（turn/step + 单请求重试）。

> **（2026-09-30 追加）新建任务页布局改为「输出在上、输入吸底」**：`.thread`（任务执行面板 + 建议区）占满剩余高度，`.dock`（输入框 + 工具条 + 本地/文件夹）`position: sticky; bottom: 0` 沉底；DOM 顺序与视觉顺序一致。`vue-tsc` 通过，Playwright（1280×820）实measure：运行态执行面板 top≈38px、输入框吸底 top≈663px 且滚动时不跟随移出。同步更新 03 文档第 1 节。

> **（2026-10-02 追加）对标基线升级 + 新增 Epic E8「架构升级」**：对照仓库 `d:\05workspaces\deepseek-harness` 已拉取至 **`639ed01539` / 0.2.0-rc.2**（2026-09-29；较 E7 记录时的 `477b4f4205` / 0.1.7-rc.2 新增 448 个提交）重新做了一轮全量对比，结论落到 **E8（T-081~T-094）**：核心差距不是"功能少"，而是 **dsh 把能力做成可替换的 seam（Definition / Provider / Consumer 三角色），EvaWork 把能力写死在模块里**。E8 的 P0 三项（T-081 消息正文落盘 / T-082 沙箱真隔离 / T-083 上下文治理）分别对应"重启丢历史、不安全、长任务必炸"三个硬伤，**建议优先于其余 P3 任务推进**。E7 条目中的版本记录（0.1.7-rc.2）已过时，以本节为准。

> **（2026-10-02 追加）口径变更：升级权益 / 订阅 / 积分整体下线，只保留使用量记录**。产品面向**企业内部员工**，不做商业化付费：没有套餐档位、没有积分余额、没有购买记录与发票，因此也就不需要"升级权益"入口。具体处置：删除 `UpgradeModal.vue`（4 档套餐/连续包月/二维码/协议）、mock `plans` 与 `usageRewards`、`ui.upgradeOpen`、i18n `menu.upgrade_disabled`/`menu.plan_local`、用户菜单里的升级按钮与每日签到、设置里的"¥29.9 升级权益"与积分卡片；删除 `SubscriptionPage.vue` 及其路由、admin 导航项、用户菜单项、`api/usage.ts` 的 `Subscription`；后端删除 `GET /api/subscription` 与 `usage.subscription()`（冒烟新增断言 `not hasattr(usage, "subscription")`，防止这套口径被接回去）。**保留**：`/api/usage` 与 `UsagePage`——任务数、产物数、趋势与估算 token 仍为真实统计，用于容量与成本观察；文案统一为"企业内部员工使用：本页只记录使用量，不涉及积分、套餐与计费"。T-041 验收标准同步改写。

## 1. 状态与优先级约定

| 标记 | 含义 |
|---|---|
| ✅ | 前端已实现（数据 Mock） |
| 🟡 | 后端/工程已脚手架或示例接入，待完善 |
| ◻ | 静态：界面存在但无副作用（诚实标注，不假装能用） |
| ✗ | 未实现 |

**任务状态**：待办 / 进行中 / 已完成 / 阻塞。
**优先级**：P0（打通主链，必做）/ P1（核心能力）/ P2（增强）/ P3（打磨）。

## 2. 史诗（Epic）划分

| Epic | 主题 | 目标 |
|---|---|---|
| **E0** 工程基线 | Electron 壳 + Python 后端 + 契约层 + 构建 | 一条能跑的真链路：启动→后端就绪→界面出内容→设计系统读真实资产 |
| **E1** 数据接入 | 各页面 Mock → 后端 | 列表/搜索/收藏/开关真实可用，不再纯展示 |
| **E2** 智能体内核 | 任务状态机 + 流式 + 模型接入 + 审批策略 | 输入一句话能真跑、真出产物、真受权限约束 |
| **E3** 工具与能力 | 插件安装 / 模板 / MCP / 文件 / 办公助理绑定 | 把"能力市场"从展示变成可调用的工具 |
| **E4** 持久化与账户 | SQLite 落盘 + 用量/订阅/登录 | 设置/命令/授权/任务关掉不丢；账户口径明确 |
| **E5** 体验与合规 | 三态 / 暗色 / i18n / a11y / 更新 | 工程化收尾，达到可交付质量 |
| **E6** 质量与验证 | e2e 冒烟 / 性能基线 | 改动能被自动化守住 |
| **E7** Harness 能力复刻 | 对照 `deepseek-harness` 移植真实 agent 编排与工具生态 | 模型驱动 tool-use 循环、事件日志即真相、统一工具管线、Skills / 规划模式 |
| **E8** 架构升级（对标 0.2.0） | 补安全底线、上下文治理与可扩展 seam，把"写死的能力"变成"可替换的能力" | 真沙箱、消息落盘、spill/压缩、工具扩容、能力 seam、审批 preset、检索与前端产品化 |

## 3. 任务清单

### E0 工程基线（壳与后端脚手架）

| ID | 任务 | 优先级 | 前端现状 | 后端/工程 | 验收标准 | 依赖 |
|---|---|---|---|---|---|---|
| T-000 | Electron 主进程：拉起 python、等 health、开窗口、IPC 注入后端地址 | P0 | — | ✅ 已完成 | `npm start` 出窗口、后端存活、渲染层拿到 URL | electron 二进制已下载(v31.7.7)；代码完整，待实机启动验证窗口尺寸 |
| T-001 | Python 后端骨架：health + chat(SSE) + design-systems | P0 | — | ✅ 已完成 | 三接口实测通过（health/design-systems 62KB/SSE 流式） | — |
| T-002 | 渲染层契约 `backend.ts`（Electron 注入 + `VITE_BACKEND_URL` 直连 + mock 兜底） | P0 | ✅ 已完成 | — | 无后端用 mock；注入/配 env 后自动切真实数据 | — |
| T-003 | 一键 dev（`scripts/dev.mjs`）：vite + python + electron | P0 | — | ✅ 已完成 | 单命令拉起三进程 | T-000/T-001 |
| T-004 | 打包：electron-builder 出 NSIS/免安装版（壳+UI+后端+Python 运行时随包分发） | P1 | — | ✅ 已完成 | `pnpm dist` 出 NSIS 安装包 + 免安装 exe；壳/UI/Python 后端源码 + **自带 Python 运行时**随 resources 分发（不再要求用户装 Python）；实机启动待验证 | T-000 |

### E1 数据接入（Mock → 后端）

| ID | 任务 | 优先级 | 前端现状 | 后端/工程 | 验收标准 | 依赖 |
|---|---|---|---|---|---|---|
| T-010 | 设计系统：后端读 `.docs` 真实 css.json + 前端接入（**已示例**） | P0 | ✅ | 🟡 | 设计系统列表/详情显示真实色板；无后端时回退 mock | T-001/T-002 |
| T-011 | 插件市场接后端：`/api/plugins`、`/api/skills`、`/api/catalog` + 前端三态接入 | P1 | ✅ 已完成 | ✅ 已完成 | 后端 15 插件/20 技能，分类与关键词命中正确；`vue-tsc` + `vite build` 通过 | T-001 |
| T-012 | 模板库接后端：`/api/templates`(+meta/favorites) + 收藏落 SQLite + 前端三态接入 | P1 | ✅ 已完成 | ✅ 已完成 | 12 模板/10 分类；**收藏杀进程重启仍在**；`vue-tsc` + `vite build` 通过 | T-040 |
| T-013 | 自动化接后端：CRUD + 开关落盘 + 轮询调度 + 执行历史 | P1 | ✅ 已完成 | ✅ 已完成 | HTTP 全链路通过；`tick` 执行生成 task 并记入历史；非法入参返回 400 | T-040 |
| T-014 | 我的文件接后端：`/api/files` 只读扫描 + 类型/关键词筛选 + 网格/列表双视图 | P2 | ✅ 已完成 | ✅ 已完成 | 扫描命中真实文件；**深度限制与越权校验生效**；非法 root→400；云端/飞书保持占位 | T-040 |
| T-015 | 设置 + 管理账户（规则/命令/授权/MCP）落盘 | P1 | ✅ 已完成 | ✅ 已完成 | 通用集合接口 `/api/console/{key}`；四类均**跨重启仍在**；非法 key→404、类型错→400 | T-040 |

### E2 智能体内核

| ID | 任务 | 优先级 | 前端现状 | 后端/工程 | 验收标准 | 依赖 |
|---|---|---|---|---|---|---|
| T-020 | 任务状态机（planning→running→waiting_approval→done/failed）+ 步骤/产物 | P0 | ✅ 已完成 | ✅ 后端已完成 | 冒烟：auto 档跑到 done、产 3 个产物；前端 NewTaskView 消费 SSE 含审批拦截 | T-001 |
| T-021 | SSE 全链路：后端产出 + 前端消费（流式正文/步骤/产物/审批拦截） | P0 | ✅ 已完成 | ✅ 已完成 | Node 复刻前端解析跑真后端：44 事件、3 产物；`vue-tsc` + `vite build` 通过 | T-001/T-020 |
| T-022 | 真实模型接入：httpx + OpenAI 兼容协议，Key 走环境变量，无 Key 降级占位 | P0 | — | ✅ 已完成 | 配 Key 走真实流式；未配则离线占位（未用真 Key 实测） | T-021 |
| T-023 | 审批策略三档 + 动作风险分级 + 沙箱判定 | P1 | ✅ 可选档 | ✅ 已完成 | 冒烟：manual+write_file 拦截 → waiting_approval | T-020 |
| T-024 | 工具注册表 + 本地工具（文件/Office/浏览器/电脑控制） | P2 | ✅ 已完成 | ✅ 已完成 | 注册表 6 工具；write_file 真落盘、run_command 沙箱拦截/full 放行、越权/越界拦截；任务步骤映射到工具真实执行；审批 gate 修通；MCP 工具经 `register_into_registry` 并入注册表；冒烟 + API 层全绿 | T-022/T-023 |

### E3 工具与能力

| ID | 任务 | 优先级 | 前端现状 | 后端/工程 | 验收标准 | 依赖 |
|---|---|---|---|---|---|---|
| T-030 | 插件安装/启用：npm 形态 MCP 走 Node sidecar；启用后在市场反映 | P2 | ✅ 已完成 | ✅ 已完成 | 后端 `plugins.py` 真实 npm 安装/本地命令→注册 MCP（握手失败不入库）；前端 install/toggle/uninstall 真调用；npm 离线诚实报错 | T-024 |
| T-031 | MCP 接入：直连 stdio MCP server（subprocess JSON-RPC，零 SDK 依赖） | P2 | ✅ 已完成 | ✅ 已完成 | 后端 `mcp.py` 自实现 stdio JSON-RPC（initialize/tools/list/call、超时、孤儿进程清理），并入 T-024 注册表；经 T-030 安装路径即可被 agent 发现调用；`McpPage.vue` 暂走 console 简化存储（未直连 /api/mcp/servers），后续可改 | T-024 |
| T-032 | 模板详情页 + 应用模板生成产物 | P2 | ✅ 已完成 | ✅ 已完成 | 点卡片进详情弹层（标题/分类/描述/指令预览）；"应用模板"创建真实任务并流式执行、出产物、受审批约束；模板补 desc 字段并单源生成 catalog | T-012/T-020 |
| T-033 | 设计系统"创建副本"/自定义：写入用户目录 css.json | P2 | ✅ 已完成 | ✅ 已完成 | `DesignSystemView` 副本/删除/新建均接 `api/design`；后端 `design_assets.py` 真往 `~/.evawork/design-systems/<slug>/css.json` 写（内置只读、绝不改动 `.docs` 原件）；`vue-tsc`+`vite build` 通过 | T-010 |
| T-034 | 办公助理绑定：飞书/微信 OAuth（占位或真实） | P3 | ✅ 已完成 | ✅ 已完成 | `OfficeAssistantView` 接 `fetchIntegrations`/`bindIntegration`，弹层显示 reason/needs、「去绑定」→ 后端 501 诚实返回未接入；后端 `api.py` `/api/integrations`+`bind`（NotReadyError→501）、`console` 已含 `integrations` key | T-040 |
| T-035 | 我的文件本地读写 + 简单预览 | P3 | ✅ 已完成 | ✅ 已完成 | `MyFilesView` 接 `fetchFileContent`/`writeFileContent`（文本预览/编辑保存）、`saveArtifactToFiles`（产物回写）；后端 `/api/files/content`(GET/PUT)、`/api/files/save` 真读写落盘；越界/体积约束在后端 | T-014 |

### E4 持久化与账户

| ID | 任务 | 优先级 | 前端现状 | 后端/工程 | 验收标准 | 依赖 |
|---|---|---|---|---|---|---|
| T-040 | SQLite 持久化：任务/步骤/产物落盘（`evawork/store.py`，write-through） | P1 | — | ✅ 已完成 | 杀进程重启后 `/api/tasks` 仍返回 done/steps=3/artifacts=3 | T-001 |
| T-041 | **用量口径**：只记录使用量（企业内部员工使用，不计费） | P2 | ✅ 已完成 | ✅ 已完成 | 后端 `usage.py` 真实统计任务/产物/趋势（token 标 `estimated`）；**无积分 / 套餐 / 订阅**：`usage.subscription()` 与 `GET /api/subscription` 已下线，冒烟断言 `usage` 模块不再暴露该口径，防止"升级权益"回流；前端页面与设置只标"真实统计/估算值"，不再出现额度与升级入口 | T-040 |
| T-042 | 账户与登录态：本地会话或 OAuth 占位 | P3 | ✅ 已完成 | ✅ 已完成 | `UserMenu` 真有登录/退出（本地会话，落库）；`account` store 记 `loggedIn`/`displayName`/`load/login/logout`；登录态跨重启 | T-040 |

### E5 体验与合规

| ID | 任务 | 优先级 | 前端现状 | 后端/工程 | 验收标准 | 依赖 |
|---|---|---|---|---|---|---|
| T-050 | 加载/错误/重试三态：所有列表/接口页补齐 | P0 | ✅ 已完成 | — | 已抽出可复用 `UAsync` + `useAsyncData`（含竞态保护）；首页任务面板、插件市场、模板库、自动化、管理账户、我的文件全部列表页已覆盖 | T-002 |
| T-051 | 暗色主题令牌化 + 主壳暗色 | P3 | ✅ 已完成 | ✅ 已完成 | `app.css` 完整亮/暗令牌（`:root`+`[data-theme='dark']`）；`stores/theme.ts` 真写 `<html data-theme>`、`main.ts` 挂载前应用、`UserMenu` 亮/暗/随系统三档切换 | — |
| T-052 | i18n 落地（至少中/英） | P3 | ✅ 已完成 | ✅ 已完成 | `i18n/index.ts` 真实 zh/en 字典 + `translate()`；`stores/i18n.ts` 真切换并落 localStorage、同步 `<html lang>`；`UserMenu` 语言下拉、`MyFilesView` 等已用 `i18n.t()`（业务长描述尚未逐条翻译，切英文仍为中文，范围写在注释） | — |
| T-053 | 无障碍：键盘可达 + axe 走查 | P3 | ✅ 已完成 | ✅ 已完成 | 焦点环+`.sr-only`+`<button>`菜单；`scripts/a11y-axe.mjs` 自动走查 18 路由 **0 违规**（landmark/h1/button-name/对比度/可滚动全过）；修复=admin `<main>`+8 视图 h1+图标按钮 `aria-label`+亮色令牌提深+深色弱文字提亮 | — |
| T-054 | 自动更新（electron-updater）+ 崩溃上报 + 日志 | P2 | — | ✅ 已完成 | electron-updater 接入（GitHub releases，仅打包态，菜单"检查更新"可触达）；崩溃捕获落盘 `userData/crash` + 上报 `/api/crash`（已实测 202+落盘）；主进程文件日志落 `userData/logs`；自动更新真连通需发布 release | T-004 |
| T-055 | 全局快捷键：Cmd/Ctrl+Shift+N 新建任务（Cmd/Ctrl+1·2·3 切模式已由 T-142 移除） | P3 | ✅ 已完成 | ✅ 已完成 | 主进程 `globalShortcut` 注册→preload 桥接 `onShortcut`→渲染层新建任务路由；类型检查+脚本语法通过，待实机验证 | T-000 |
| T-142 | 侧栏模式切换 → 品牌区：移除 Work/Code/Design 三档切换，换成 EvaWork 品牌标识 | P3 | ✅ 已完成 | — | SideNav 左上角改为渐变方块+文字品牌区（仍作窗口栏拖拽带）；i18n 删 `mode.work/code/design`；NewTaskView 删 Design/Code 死分支；主进程与渲染层删 Ctrl+1·2·3 快捷键及 mode 分支；`vue-tsc` + `vite build` 通过 | T-055 |

### E6 质量与验证

| ID | 任务 | 优先级 | 前端现状 | 后端/工程 | 验收标准 | 依赖 |
|---|---|---|---|---|---|---|
| T-060 | e2e 冒烟：API 层（`scripts/api_smoke.mjs`）+ 浏览器层（Playwright） | P1 | ✅ 已完成 | ✅ 已完成 | API 层全接口 200+结构校验通过；浏览器层 `scripts/e2e-ui.mjs` 遍历 18 路由全绿、0 未捕获异常；借此修复 file:// CORS 与一处 TDZ 崩溃 | T-000 |
| T-061 | 性能基线：release 测首屏/路由切换，避免 debug 误导 | P2 | — | ✅ 已完成 | `scripts/perf-baseline.mjs` 实测冷加载 Load 203/FCP 224/LCP 272ms，18 路由挂载中位 4–33ms；基线落盘 `scripts/perf-baseline.json` 供回归对比 | — |

### E7 Harness 能力复刻（对照 `deepseek-harness`）

> **来源**：`D:\05workspaces\deepseek-harness`（已同步至 `477b4f4205` / 0.1.7-rc.2）。
> **探查结论**：harness 的真实 agent 内核在 **TypeScript**（`packages/core/agent-loop`），其 Python `python/sdk` 只是拉起 TS 运行时的 JSON-RPC 客户端——故本 Epic 移植的是**内核模式**，不是 Python 代码。
> **现状基线（2026-09-26 复核）**：**T-070 已落地并验证**——`runner.py` 不再是"预分配 action → 调工具"，改为模型驱动的 tool-use 循环（`_run_agent_step`）与工具 schema 管线（`tools.openai_schemas`）；下表其余条目为对照 harness 继续补齐的任务。

| ID | 任务 | 优先级 | 前端现状 | 后端/工程 | 验收标准 | 依赖 |
|---|---|---|---|---|---|---|
| T-070 | Agent 内核：**tool-use 循环**（模型驱动工具调用，取代预分配 action） | P0 | ✅ 已展示调用/结果 | ✅ 已完成 | 模型返回 tool_call → 增量拼接分片参数 → 审批 gate → 真执行 → `role=tool` 回填 → 再请求模型，至无 tool_call 或达 `MAX_TOOL_ROUNDS=8`；SSE 产出 `tool_call`/`tool_result`；冒烟含**真 socket 端点**用例（tools_sent=2、result_back=1、文件真落盘） | T-024 |
| T-071 | `turn/step` 双层循环 + 步骤级重试（request-error → retry，不重装配请求） | P1 | ✅ 重试可见 | ✅ 已完成 | 一次模型请求=一个 step（`stream_step`）；瞬时错误（超时/网络/429/5xx）重试**同一份 messages**（≤2 次，退避 0.5/1.5s）并产出 `retry` 事件；终态错误（401/403/404/400）一次即 failed；已吐 token 后中断不再重来（避免重复正文） | T-070 |
| T-072 | **事件日志即真相**：任务事件落盘 + 增量回放（revision 递增，断线可续） | P1 | ✅ 续跑带 `since` | ✅ 已完成 | 每帧 SSE 落盘（全局自增 `rev`）并回传 `rev`；`GET /api/tasks/{id}/events?since=<rev>` 增量拉取；SSE 支持 `since` 先补发缺失帧再接实时流；已结束/待审批只补历史不重跑；续跑不再重复补发 plan、不重跑已完成步骤 | T-070/T-040 |
| T-073 | 协作式取消：abort 任务 + 已下发文本以 interrupted 锚点保留进历史 | P2 | ✅ 可停可续 | ✅ 已完成 | 任务持 `asyncio.Event` 取消信号，runner 在轮次/步骤/token 边界协作式停下；`POST /api/tasks/{id}/cancel`（无流在跑时直接落持久态，不假报"已取消"）；已吐出正文带 `[已中断]` 锚点进 `task.messages` 与步骤详情；被中断步骤重置为待执行，可从断点续跑；前端执行中「停止」、中断后「继续」 | T-070/T-072 |
| T-074 | 统一工具管线：`pre-execute`(deny)/`execute`(超时)/`post-execute`(归一化·截断) + **并行/独占**调度，本地与 MCP 走同一管线 | P2 | ✅ 批量调度 | ✅ 已完成 | `ToolSpec` 增 `execution_mode`/`timeout`；三段式管线（`pre_execute`/`_dispatch_pipeline`/`post_execute`）由 `run_pipeline` 串联，本地与 MCP 共用；`execute_batch` 按模式调度（parallel 并发、exclusive 独占 barrier）；`tool_call` 事件在审批前发出（待审批也能看见意图）；`tool_result` 带 `elapsed_ms`/`mode` | T-024/T-031/T-070 |
| T-075 | PTC（`run_code`）：模型写代码批量编排工具调用 | P3 | — | ✗ 未实现 | agent 可生成一段代码批量调用工具，减少多次往返，产出可审计 | T-074 |
| T-076 | **Skills 技能系统**：`SKILL.md` 发现与加载，会话内 `/name` 直调 | P2 | ✅ 可唤起 | ✅ 已完成 | 新增 `skills.py`：用户级 `~/.evawork/skills/` + 项目级 `.evawork/skills/` 发现（按 mtime/size 签名自动重扫，删除即消失）；front-matter 自解析（不引 PyYAML）；`/name 参数` 唤起 → 正文注入系统提示 + 工具收窄到 `allowed-tools`；技能目录 `scripts/*.py` 注册为工具并**走既有管线**（`action=run_command`，继承审批与沙箱）；端点 `/api/skills/installed`、`/api/skills/{name}`、`/api/skills/reload`，市场列表标注"已加载"；前端 `+` 菜单列出已加载技能、输入框 `/name` 直达、运行头显示技能标签 | T-074 |
| T-077 | 规划模式 plan-mode：`/plan` 进入规划、`exit_plan_mode` 提交计划待审批 | P3 | ✗ 未实现 | ✗ 未实现 | 规划期工具只读可用；计划需人工批准后才转入执行（与 T-023 审批策略衔接） | T-070 |
| T-078 | 交付物记录：声明最终产物 + 每轮改动文件（workspace-changes） | P2 | ✅ 产物面板已有 | ✗ 未实现 | 每轮改动（新增/修改/删除）可查；产物可追溯到来源轮次（当前仅 artifact 列表，无改动集） | T-040 |
| T-079 | 传输升级：WebSocket 多路逻辑流（事件/快照/控制），帧格式 `item/end/error` | P3 | — | ✗ 未实现 | 单条 WS 复用多类流；支持断线续传与 revision 跳号修复（当前为裸 SSE，单流单向） | T-072 |
| T-080 | 自动化增强：webhook 外部触发 + ACP 协议入口（子代理/脚本驱动持久 agent） | P3 | ✅ 自动化已有 | 🟡 现有 `tick` 轮询 | 支持外部事件触发任务；提供 ACP 标准协议 stdio 入口供脚本/子代理驱动 | T-013 |

> **前置依赖（非本 Epic，但会阻塞演示效果）**：E1 的 T-011/T-013/T-014 等虽已标 ✅，但 `AutomationView` / `DesignSystemView` / `MyFilesView` / `TemplateView` 等**列表在无后端时仍回退 `data/mock`**，后端端点（`/api/automations`、`/api/design-systems`、`/api/files`、`/api/templates`）均已就绪。复刻 E7 前建议先把这些列表改成"在线拉真实 + 离线兜底"，避免演示时看到假数据。

### E8 架构升级（对标 `deepseek-harness` 0.2.0-rc.2）

> **来源**：`d:\05workspaces\deepseek-harness`，已拉取至 `639ed01539` / **0.2.0-rc.2**（2026-09-29）。
> **一句话差距**：dsh 把能力做成**可替换的 seam**（Service Definition / Provider / Consumer 三角色），EvaWork 把能力**写死在模块里**（`tools.py` 6 个工具写死、`policy.py` 与 `tools.py` 互相 import）——所以 dsh 能在 20 天内加进桌面端、语音、4 种浏览器 provider 而**不动内核**。
> **不照搬什么**：Cordis 全插件化改造成本极高且 Python 生态无等价物，**只在 T-085 的四个边界做 seam 抽象**即可。

**对照速览**

| 维度 | dsh 0.2.0-rc.2 | EvaWork 现状 |
|---|---|---|
| 扩展方式 | 能力 seam：`subprocess` / `shell` / `terminals` / `sandbox` / `approval` / `fs` / `web` / `llm` + `mcpResources` / `browserUse` / `computerUse` / `sessionQuery` / `skills` 等 | 无 seam；换实现 = 改源码 |
| 工具 | ~40（edit/read/write/glob/grep/str_replace_editor/bash/pwsh/持久化 terminal/web_fetch/web_search/lsp/run_code/subagent/job_*/todo/goal/schedule/ask_user/session_search…） | **6**（且 `computer_control` 恒返回不支持） |
| 沙箱 | 三档 read-only / workspace-write / danger-full-access；Linux bwrap→Landlock、macOS Seatbelt、**Windows 受限令牌 + ACL**；探测失败 **fail-closed**，绝不裸跑；回报 full/partial | `tools.py:172` 仅路径前缀校验；`run_command` 沙箱开=全拒、full 档 `shell=True` 裸跑；无命令白名单、无资源限额 |
| 持久化 | append-only 事件日志 `session.jsonl[.zstd]` + 世代迁移 vN→vN+1 + checkpoint + projection 缓存 | SQLite 5 表 + `events(rev)`；**`messages` 不落盘**（`store.py:109-157`） |
| 上下文治理 | compaction：`min(W×0.8, W−O−64K)` 触发、保最新 16% 逐字、**先裁工具结果再摘要**；spill 超大结果落盘、模型只拿 head/tail + 路径 | 无；仅 `tools.py:415` 的 4000 字硬截断，**原文丢失** |
| 检索 | `session-query-sqlite` **FTS5 派生索引**（独立库，不污染持久库）+ 5 个只读检索工具 | 无索引，内存子串过滤 |
| 审批 | `ctx.approval`（ask/never，无应答者 fail-closed，**只做一次性授权**）+ permission preset 打包"沙箱档 + 审批策略" | 三档 manual/auto/full + `auto_approved` **永久记忆放行** |
| 循环 | plan 可修订、subagent、job 控制、模型重试/降级 | plan 一次性 ≤4 步**不重规划**；无 subagent；`FatalError` 直接 failed |
| 前端 | — | 无 PTY、无文件树、无 diff 审阅、无 Markdown/Mermaid（`package.json` 无相关依赖） |

**任务清单**

| ID | 任务 | 优先级 | 前端现状 | 后端/工程 | 验收标准 | 依赖 |
|---|---|---|---|---|---|---|
| T-081 | **消息正文持久化**：`messages` 落盘（写成 events 帧或独立表），重启不丢历史 | P0 | ✅ 回显已靠回放 | ✅ 已完成 | 杀进程重启后打开历史任务，用户/助手消息与正文完整回显；`GET /api/tasks/{id}` 返回 messages 非空；回放与实时两条路径结果一致 | T-072/T-040 |
| T-082 | **沙箱升级为真隔离**：Windows 受限令牌 + ACL（capability-SID allow ACE、父目录 deny 删除 ACE、Low integrity label）+ 功能探测失败 fail-closed；档位改三档 read-only / workspace-write / danger-full-access | P0 | ✅ 三档可选 | ✅ 已完成 | 非 danger 档下越权写/删被**系统层**拒绝（而非 Python `if`）；`run_command` 不再是"沙箱开=全拒、full=裸跑"；无可用隔离后端时任务 fail-closed 并给出明确原因，**绝不降级裸跑** | T-023/T-024 |
| T-083 | **上下文治理**：spill（超大工具结果落盘，模型只拿 head/tail + 路径）+ compaction（阈值触发、保最近 N 轮逐字、旧轮摘要，先裁工具结果再摘要） | P0 | — | ✅ 已完成 | 单轮工具输出 100KB 时不撑爆上下文且原文可从磁盘取回；长任务跑到 50 轮后请求 token 数不持续增长；压缩后仍能正确续跑 | T-070/T-072 |
| T-084 | **工具集扩容 6 → ~15**：grep/glob、str_replace_editor、web_fetch/web_search、todo_write、terminal（持久化会话）、read_image、http_request | P1 | 🟡 工具面板已有 | ✅ 已完成（本地 15 个） | 新工具全部走 T-074 统一管线（审批/沙箱/并行独占**自动继承**）；模型能真实调用并回填；`/api/tools` 数量增至 15 左右 | T-074 |
| T-085 | **能力 seam 抽象**：至少把 sandbox / approval / llm / fs 四个边界做成"定义 + provider"两层 | P1 | — | ✅ 已完成 | 换沙箱后端或审批源**不改** runner/tools 代码；新增 provider 只需注册 | T-082 |
| T-086 | **审批升级 permission preset**：把"沙箱档 + 审批策略"打包成用户可见档位；**取消 `auto_approved` 永久记忆**（改一次性授权） | P1 | ✅ 三档切换 | ✅ 已完成 | 切一次档位即同时决定沙箱与审批；不再出现"点过一次就永远放行"；审批无应答者时 fail-closed 且有明确提示 | T-023 |
| T-087 | **计划动态修订**：步骤失败/工具报错后可重规划，而非一次性生成 ≤4 步 | P1 | ✅ 步骤可见 | ✅ 已完成 | 注入一次工具失败后任务重规划并继续到 done；不因单步失败整任务 failed | T-070/T-071 |
| T-088 | **全文检索**：events/messages 加 SQLite **FTS5 派生索引**（独立库，不污染持久库）+ 给模型一个只读检索工具 | P2 | ✅ API + 工具可用（UI 入口归 T-089） | ✅ 已完成 | 历史任务可按关键词召回；索引库删掉后可重建，主库不受影响 | T-081 |
| T-089 | **前端产品化**：PTY 终端（xterm + 真 ConPTY）、文件树、diff 审阅、Markdown/Mermaid 渲染、代码高亮 | P2 | ✅ 四项全落地 | ✅ 已完成 | 任务面板可看终端与文件树；文件改动可 diff 审阅；正文支持 Markdown/图表/代码高亮渲染 | T-078 |
| T-090 | **subagent / 任务分派 + job 控制**（kill/list/output）+ 解除 exclusive 全局串行以支持并发会话 | P2 | ✅ 三项全落地 | ✅ 已完成 | 主任务可分派子任务并回收结果；可列出/终止后台任务；两个任务可同时跑 | T-074 |
| T-091 | **模型降级与多模型路由**：`FatalError` 换通道/换模型重试，而非直接 failed | P2 | ✅ 已完成 | ✅ 已完成 | 主通道 401/超限后自动切备用通道并继续；失败原因如实暴露给前端 | T-022/T-071 |
| T-092 | **checkpoint / 回滚**：写文件前快照，支持按轮次撤销 | P2 | ✅ 已完成 | ✅ 已完成 | 写类工具（`write_file` / `str_replace_editor`）落盘**前**留快照进主库；`GET /api/tasks/{id}/checkpoints` 列出各轮、`POST /api/tasks/{id}/undo` 撤销最近一轮；撤销后新建文件删除且对应产物一并清掉；被后来的改动覆盖过的文件如实报 conflict 不撤销 | T-078 |
| T-093 | **传输与调度升级**：MCP 支持 http/sse transport（现仅 stdio）；自动化改 cron 表达式 + 并发去重 | P3 | ✅ 已完成 | ✅ 已完成 | `mcp.py` 重构为 Session 基类 + 三种传输（`_StdioClient` / `_StreamableHttpClient` / `_SseClient`），**不依赖第三方 SDK**（http.client 自实现，SSE 手工解析）；协议版本 2025-06-18 优先、失败回退 2024-11-05；注册时真握手列工具，连不上/传错类型直接拒收（无幽灵服务）。新增 `cron.py`：5 段 cron 解析/下一次触发/中文描述，**日与周同时限定取并集**（Vixie 语义）、语法正确但永不触发的表达式当场拒绝；自动化条目 `cron` 优先于间隔分钟，调度循环"睡到下一个触发点"（不再固定 30s 粗轮询）；**跑前先占格写盘**（跑得比周期慢不会层层叠加）+ 进程内执行锁（调度 tick 与手动触发并发只执行一次）；UI 支持传输选择/地址填写与 cron 实时预览（中文描述 + 未来 3 次触发时刻）。验证：Node 跨语言真 fixture（`scripts/fixtures/mcp-http.mjs`）覆盖 streamable 两种响应形态（SSE 流/单条 JSON）+ 旧版 HTTP+SSE 双通道 + 连不上/缺字段等负向路径；全量冒烟通过；API 层 TestClient 实测相关路由；页面截图确认渲染 | T-031/T-013 |
| T-094 | **可观测**：任务级遥测（耗时 / token / 工具成功率）+ 结构化日志落盘 | P3 | — | ✗ 未实现 | 一个任务跑完能导出完整时间线与用量；异常可定位到具体轮次 | T-072 |

**保留优势（不要推翻）**：`events(rev)` 增量回放 + `resume` 续跑、SQLite 单文件部署、审批门禁 UI 直观、Python 生态与已有业务外壳（IAM / 自动化 / 模板 / 设计资产）。

**战略备选**：若目标是产品级而非内部助手，更划算的是把业务外壳（审批 UI / IAM / 自动化 / 模板 / 设计资产）**移植成 dsh 的 profile + bundle**，而不是在 Python 内核上补齐 ~40 个工具与真沙箱。

### E9 分析可信度与产物质量（2026-10-02 新增）

> **来源**：与 traework **同题**分析 `D:\05workspaces\deepseek-harness` 的实测对比（2026-10-02）。
> **一句话差距**：不是"写得少"，是**产出不可信**。EvaWork 四份产物里 `PROJECT_ANALYSIS_ZH.md` 把项目幻觉成 `@electron/asar`（真实是 `@deepseek-ai/dsh-root`，Cordis 插件化智能体框架）、`DEPENDENCY_MAP.md` 是**未填充的模板**（`Module A / [Provide a detailed description]`）、`TESTING_STRATEGY.md` 是通用模板（Jest/Cypress/85%，项目实为 Vitest 4 + 快照 + 60 余个 `verify-*` 门禁）；traework 那份 37KB 给出的是实测数字（58 包组 / 316 个 package.json / 5,143 个 TS 文件 / 1,892 测试 / 20,470 提交 / 1,052 份决策记录）与成体系的架构解读。
> **根因（已从 `~/.evawork/evawork.db` 的四个任务复盘确认）**：① 63 次工具调用里绝大多数是 `**/*.ts`(44KB) / `**/*.js`(78KB) / `**/*.tsx`(54KB) / `**/package.json`(67KB) 的**全量 glob**，上下文被路径字符串灌满、spill 后**未回读** → 模型只剩路径碎片 → 脑补；② 没读高密度入口（`AGENTS.md` 17KB / `docs/` 63 页 / `.agents/notes` 1,052 份 / `packages/README.md` 包组映射 / `scripts/verify-*` / CI 矩阵）；③ 无凭据时走**离线占位**，占位文本被当成结论继续流转（`task-f02e174b` step2 detail 原文即「[离线占位 · 未配置模型]」）；④ 产物落盘**无门禁**；⑤ 分析类任务用 **qwen-plus** 弱档；⑥ `dispatch_subagent` 回话「我无法访问文件系统」。
> **不照搬什么**：不为了"写得长"去凑字数——门禁只卡"与已读证据矛盾 / 模板没填 / 结构空壳"，不卡文风。
>
> **2026-10-02 补 T-102（会话即任务）**：T-101 的"每次追问建新任务 + 携带历史"只是过渡——任务库里同会话仍有多条记录。按用户要求升级为**真正的单任务多轮**：追问走 `POST /api/tasks/{tid}/messages` 追加到同一任务并置回 `pending`，前端 `runFollowUp` 用 `since=lastRev` 只接本轮新帧；`plan` 帧即轮次边界（回放清过程区）。好处：会话=任务，产物/回滚点/审批都归在同一条会话下。
>
> **2026-10-02 补 T-101（会话连续性）**：用户实测发现"同一会话的多个提问裂成 5 条任务、模型对之前的问答一无所知"。根因：前端每次 `submit()` 都 `createTask()`，本地 `history` 只做 UI 展示从不传后端，后端规划请求也只拿 `task.title` 一行。修复跨前后端（见 T-101 行）。验证手法沉淀：headless 无 IAM 登录态 → 纯前端逻辑用 **mock 路由 + `addInitScript` 注入 `window.trawork`** 验证；模型上下文用 **API 直调带历史** 验证。
>
> **2026-10-03 补 T-105（步骤必须有结论 / 产物只来自真实文件）**：用户截图报"完全没有按照要求输出"——正文空白、产物全是步骤标题。查库（`task-27747cd6` / `task-79f78daa` / `task-cb3a9d6c`）两个根因：
> ① **产物是伪造的**：`_run_agent_step` 末尾"没写文件就按**步骤标题**编一个 `.md`"（内容 = 模型那句预告 + 工具日志）——截图里 6 个产物名全是步骤标题、其中 3 个正文只有 4 个字符。产物必须是**模型真的写出来的文件**（`write_file`/`str_replace_editor` 结果里的 `diff`+`path` 才是凭据），没写就如实为空。
> ② **步骤在没给出结论时就结束了**：实测 qwen-plus 在"要调工具"的那一轮只吐一句「让我查看 packages 目录结构：」，随后一路调工具到 `MAX_TOOL_ROUNDS` 用尽 —— 这句**执行预告**被当成这一步的成果写进 `messages`/产物/下一步上下文，用户拿到的正文因此是空的（截图上 assistant 消息全是 25~41 字的"让我查看…"）。
> 修法：工具轮次用尽或只吐预告（短、单行、冒号收尾）→ 摘掉工具补一轮**收尾**（`CLOSING_SYSTEM`，只能用已有证据作答）；收尾仍无结论 → 步骤**判失败**并写明原因，绝不把预告当成果；预告句不再进 `messages`（否则把后续步骤也带进"我要去查…"的死循环）；新增 `narration` 事件帧，把预告沉进前端的执行过程区，不粘在答案前面。
>
> **2026-10-03 补 T-106（窗口一矮对话区叠成一团）**：用户截图里快捷 chips、建议卡、输入框全压在一起。根因不是某个元素写错，是布局策略本身：`.new-task` 用 `min-height:100%` 让内容把盒子顶高、`.dock` 再用 `sticky bottom:0` 吸底 —— 内容一高，sticky 就把输入框从它自己的位置整块抬起（实测 864x416 抬 147px、1080x270 抬 157px），抬起后不占位，直接盖住上面的建议卡。改为整个视图 `height:100%` 铺满视口、`.thread` 自己滚、`.dock` 回到普通流（独占一行）。
>
> **2026-10-03 补 T-104（正文双倍行距）**：用户截图报"AI 正文行距是两倍"。根因不是行高，是 **`white-space` 用错了对象**：`.ai-out` 是 T-089 把纯文本日志面板换成 Markdown 渲染时留下的属性，`pre-wrap` 会把 markdown-it 输出 HTML 里**块级标签之间的换行符**也渲染成真换行 —— 每个 `<p>`/`</li>`/`</ul>` 后都凭空多一个空行（实测块间距 10px → 41.6px、列表项 4px → 31.6px，正好各多一个行高 23.6px；`<li>` 里的前导换行还把列表符号和内容顶到了两行）。修复：`.ai-out` 去掉 `pre-wrap`，正文分行语义交还渲染器（`MarkdownView` 新增 `breaks` 开关，对话正文 `true` → 单换行生成 `<br>`，文档预览保持 `false` 以免把 80 列硬折行的 `.md` 拆断）；行高统一由 `.md` 持有；另给 `li > p` 单独压边距（松散列表会被包 `<p>`，段落外边距叠加同样让条目间距翻倍）。
>
> **2026-10-02 补 T-100（正文可选中 / 可复制）**：同源问题——全局 `body{user-select:none}` 把正文一起禁了，用户拿到结论却一个字都摘不走。已在 `app.css` 反转策略（内容默认可选，只在 `nav/aside/header/footer/button/[role=tab]/[data-coming]` 禁用；`input/textarea/pre/code` 与正文/产物/工作区预览/终端等容器显式 `user-select:text`），`AdminLayout` 也去掉整页禁用，并补了深色主题下可见的 `::selection` 高亮。
>
> **2026-10-02 收尾**：T-096 / T-097 / T-098 / T-099 **四项全部完成**。新增 `evawork/qa.py`（产物门禁，`write_file` 与 `str_replace_editor create` 落盘前拦截，拒收即不落盘）；`agent._require_credentials()` 让"没凭据"变成 `FatalError(kind=auth)`，占位只在显式离线演示下存在，runner 另有 `_is_placeholder()` 兜底判失败；`runner._model_for()` + `agent.heavy_model()` 做分档，`plan` 帧带 `model` 便于核对；`PLAN_SYSTEM` 注入证据优先要求，`tools` 新增 `count_files`（工具 21 → 22），`glob` 返回体附 `stats` 聚合。冒烟新增 4 条断言全绿、全量 `ALL SMOKE TESTS PASSED`。

**任务清单**

| ID | 任务 | 优先级 | 前端现状 | 后端/工程 | 验收标准 | 依赖 |
|---|---|---|---|---|---|---|
| T-106 | **矮窗口下对话区不再重叠**：`.new-task` 由 `min-height:100%` 改 `height:100%`（视图铺满视口），`.thread` 自己滚（`overflow-y:auto`），`.dock` 去掉 `sticky` 回到普通流 | P0 | 🔴 核心（用户报"样式崩"） | ✅ 已完成（2026-10-03） | 真浏览器实测 1080x270 / 864x416 / 1024x500 / 1280x800 四档：`.new-task` 高度 == 视口高度、`.thread` 内部可滚（978/223、812/77 等）、**重叠 0px**（改前 sticky 把 dock 抬起 147~157px）、dock 始终在视口内、把 thread 滚到底后正文最后一行完整露出、`pageerrors` 为空 | T-089 |
| T-105 | **步骤必须有结论 + 产物只来自真实落盘**：产物改为只认"模型真的写出来的文件"（写类工具结果里的 `diff`+`path`），删掉"按步骤标题编 `.md`"的伪造分支；步骤循环结束后，若"用过工具却没有结论"（工具轮次用尽，或最后一段是"让我查看…"这类执行预告）→ 摘掉工具补一轮收尾作答，仍无结论则**判失败**并写明原因；预告句不进 `messages`；新增 `narration` 事件帧把预告沉进执行过程区 | P0 | 🔴 核心（用户报"完全没有按照要求输出"） | ✅ 已完成（2026-10-03） | 真模型复跑同一条 prompt（`task-eff42a94`）：正文由**空的**变为 899 字实体答案（技术架构/功能架构分节）、产物 **6 → 0**（没写文件就没有产物，不再有"步骤标题.md"）；冒烟新增两条用例（`test_step_must_conclude`：轮次用尽→补收尾、结论进 detail/messages、产物为 0、有 narration 帧；`test_step_no_conclusion_fails`：收尾仍给预告→步骤 failed 且 detail 写明"没有给出结论"）；全套 `smoke_test.py` ALL PASSED | T-070/T-081/T-097 |
| T-104 | **正文双倍行距修复（排版）**：`.ai-out`（对话问答正文）去掉 `white-space: pre-wrap`——该属性会把 markdown-it 输出 HTML 里块级标签之间的换行符渲染成真换行，每个块后面多一个空行；正文分行语义改由渲染器负责：`MarkdownView` 新增 `breaks` 开关（对话正文 `true` → 单换行生成 `<br>`，文档/产物预览保持 `false`），行高统一由 `.md` 持有；`li > p` 单独压边距（松散列表的段落外边距叠加同样让条目间距翻倍） | P0 | 🔴 核心阅读体验 | ✅ 已完成（2026-10-03） | 真浏览器实测同一条任务（含 markdown 嵌套列表）：块间距由 41.6px → **10px**、列表项间距由 31.6px → **4~8px**（多出来的正好各是一个行高 23.6px）；`getComputedStyle(.ai-out).whiteSpace = normal`；段内单换行的正文仍保持两行（`brCount=1`，行距 23.6px）；`pageerrors` 为空 | T-089 |
| T-096 | **产物质量门禁**：文档类产物落盘前自检——未替换占位符（`[Provide` / `Module A` / `TODO`…）拒收、与已读证据（项目名/包名/仓库名）矛盾拒收、结构空壳拒收，把原因退回模型重写 | P0 | — | ✅ 已完成（2026-10-02） | 写入含未填模板的 `.md` 被**拒绝落盘**并给出具体原因（实测 `WRITE-GATE: False \| 落盘: False`）；正常文档与小文件不受误伤；`TRAWORK_QA_DOC=0` 可关 | T-074 |
| T-097 | **占位输出硬失败**：无凭据/未登录时**不得**用占位文本冒充模型输出；仅显式离线演示（`TRAWORK_LLM_ENABLED=0`）才允许占位 | P0 | — | ✅ 已完成（2026-10-02） | 无可用通道跑任务 → `failed` 且错误写明原因（实测 `FatalError: 自建模型通道未配置（OPENAI_API_KEY 为空）`），正文**不含**"（真实模型输出占位）"；`TRAWORK_LLM_ENABLED=0` 下演示链路照常 done | T-022/T-091 |
| T-098 | **模型分档**：分析/写作/长文档类任务自动用高档模型（`qwen-max`，可配 `TRAWORK_MODEL_HEAVY`），轻量问答仍用默认档 | P0 | 🟡 设置里已有模型概念 | ✅ 已完成（2026-10-02） | 真模型实测：标题含"分析…文档"的任务 `plan` 帧 `model=qwen-max`；"你好"这类仍 `auto` | T-091 |
| T-102 | **会话即任务（同一任务多轮）**：追问不再新建任务——新增 `POST /api/tasks/{tid}/messages` 把追问追加到**同一个任务**并置回 `pending`（清步骤/授权/错误，授权是一次性的不带到下一轮），前端 `runFollowUp` 以 `since=lastRev` 接新帧；回放按 `plan` 帧作轮次边界清过程区（旧轮步骤不再堆在本轮）。侧栏条目、任务 id、URL 全程不变 | P0 | 🔴 核心体验 | ✅ 已完成（2026-10-02） | 真模型端到端：同一 task id 跑两轮，第二轮答出第一轮埋的暗号 `PINEAPPLE-42`，任务库只多 1 条；mock UI 验证：追问只调 `/messages`、`createTask` 全程 1 次、侧栏/URL 不变 | — |
| T-101 | **会话连续性（上下文传递）**：① 同一会话的追问不再新建侧栏条目；② 历轮 user/assistant 随 `createTask.messages` 落进 `task.messages`（T-102 后由后端自身累积，此路径仅首轮生效）；③ 规划请求补上"对话至今"（最近 6 轮、每条截 600 字）；④ 模型档位判定改用**最新一条**提问（首问是分析、追问是改错别字时不再误上高档）；⑤ 打开历史任务时按 `messages` 重建完整对话流（最后一轮仍走事件回放） | P0 | 🔴 核心体验 | ✅ 已完成（2026-10-02） | API 级真模型验证：带历史的任务准确答出历史中的暗号 `PINEAPPLE-42`；mock 后端 UI 验证：追问后侧栏仍 1 条且换绑新任务、`createTask` body 携带 3 条 messages | — |
| T-100 | **正文可选中、可复制**：取消 `body{user-select:none}` 全局禁用，改为"内容默认可选，只在界面外壳（侧栏/顶栏/按钮/标签）禁用"；深色主题补可见的选中高亮 | P0 | 🟡 全站受影响 | ✅ 已完成（2026-10-02） | 浏览器实测：正文元素 `user-select:auto`，鼠标拖选到 19 字，`Ctrl+C` 后剪贴板读回同一段文本；侧栏 `.sidenav` 仍为 `none`（外壳不误选） | — |
| T-099 | **编排：高密度入口 + 规模统计**：系统/规划提示要求先读 `README`/`AGENTS.md`/`CLAUDE.md`/`docs/`/包组 README/notes/`verify-*`；新增 `count_files` 统计工具（文件数/按后缀/按目录/行数），`glob` 结果附聚合统计 | P1 | — | ✅ 已完成（2026-10-02） | 真模型实测：计划第一步即"读取高密度入口文件（README、AGENTS.md、CLAUDE.md、docs/…）"，第二步"用 count_files 统计规模"；`count_files` 实测 4 文件 / 26 行 / 后缀分布正确；`glob` 返回体带 `stats.by_ext` | T-083/T-084 |

## 4. 进行中（细化）

### T-003 一键 dev —— ✅ 已完成
- **已完成**：`scripts/dev.mjs` 编排 vite(1420) + python(18765) + electron；根 `pnpm dev` 指向它；新增 `pnpm backend` / `pnpm shell` / `pnpm smoke`；vite 配置清除旧壳残留（端口仍 1420）。
- **未完成**：三进程联跑未实测。
- **阻塞已解除**：electron 二进制已下载（见 T-000）。
- **下一步**：本机已可 `pnpm install && pnpm dev`（若 electron 未下载，先设 `NODE_OPTIONS=--use-system-ca` 再 install；已下载则直接 `pnpm dev`）。

### T-000 Electron 壳 —— ✅ 已完成（代码完整，待实机启动验证窗口尺寸）
- **已完成**：`src/main.js`（spawn python、轮询 `/api/health`、开窗口、IPC 注入后端地址）、`src/preload.js`（`window.trawork`）。
- **未完成**：启动冒烟、窗口尺寸与最小尺寸验证。
- **阻塞已解除**：2026-09-25 经 `NODE_OPTIONS=--use-system-ca` 成功下载 v31.7.7 二进制（~172MB），待实机启动验证窗口与尺寸。
- **容错设计**：主进程最多等后端 ~24s；超时仍开窗口，渲染层回退 mock，**不会白屏**。

### T-050 三态补齐 —— 🔄 部分完成（继续推进）
- **已完成**：首页任务面板落地加载态（规划中/流式执行中）、错误态（带原因文案）+ 重试、审批拦截态；无后端时明确提示"未连接后端"，不假装执行。
- **已完成（基建）**：抽出 `src/composables/useAsyncData.ts`（加载/错误/重试 + **响应竞态保护**，避免快速切筛选时旧响应覆盖新结果）与 `src/components/UAsync.vue`（统一三态容器）。
- **已接入**：首页任务面板、插件市场、模板库、自动化、管理账户（规则/命令/授权/MCP）、我的文件 —— **全部列表页已覆盖**。
- **未完成**：无（三态基建与页面接入均已落地）。
- **下一步**：三态基建收尾，转入 T-060（e2e 冒烟）用自动化守住这些页面。

### T-015 持久化 —— ✅ 已完成
- **已完成**：
  - 后端 KV 表 + `/api/settings`（GET/PUT 合并写入）；
  - 前端 `SettingsModal.vue`：**打开即回填**、改动 400ms 防抖写回、右上角状态指示（读取中/保存中/已保存/未连接后端·改动不保存/错误+重试）；
  - 回填只认已知字段（`hasOwnProperty` 校验），脏数据不会污染界面；回填期间不触发写回，避免"读一次写一次"死循环。
  - 管理账户的规则 / 命令 / 外部授权 / MCP 四类经 `console.py` 走统一 KV 落盘（`store.kv_*`，SQLite 写穿，`persistent()` 默认开启），**重启不丢**；前端经 `/api/console/{key}` 读取，刷新后保留。
- **未完成**：无（设置 + 控制台四类均已落盘）。
- **下一步**：转入 T-060（e2e 冒烟）守住持久化与三态。

### T-060 e2e 冒烟 —— ✅ 已完成
- **已完成（API 层）**：`scripts/api_smoke.mjs` 一次遍历全部接口（health / policy / design-systems / catalog / plugins / skills / templates / favorites / automations / runs / console×4 / files / chat），断言状态码与结构；SSE 接口按**文本流**校验（不能按 JSON 解）。**全部通过**。
- **已完成（浏览器层）**：`scripts/e2e-ui.mjs`（Playwright + 本地 Node 静态服务器托管 UI，避开 file:// CORS）；遍历 18 条 hash 路由，收集 `console.error` / `pageerror`；**18/18 渲染、0 未捕获异常**。
- **过程中修复两隐患**：① `loadFile` 走 file:// 会被 Chromium CORS 拦截 ES module（前端整页打不开）→ `main.js` 改本地 HTTP 托管 UI（T-004 配套）；② `DesignSystemDetailView` 的 `errMsg` 在 `watch(immediate)` 触发的 `loadRemote` 中先于初始化被访问（TDZ 崩溃）→ 声明提前。
- **未做**：CI 集成、可视回归、交互级断言（当前仅渲染冒烟）。

### T-024 工具注册表 + 本地工具 —— ✅ 已完成
- **已完成（后端 `evawork/tools.py`）**：
  - 单一事实来源 `TOOLS` 注册表：read_file / write_file / list_dir / run_command / open_url / computer_control，含动作类别、参数、离线可用性，agent / 前端 / 未来 MCP 共用。
  - **真实执行**：`write_file` 真把文件写到沙箱工作目录（`TRAWORK_WORK_DIR`，默认 `~/.evawork/workspace`）；`run_command` 在 full 档且沙箱关闭时真跑，manual/auto 档一律拦截；`open_url` 调系统浏览器（无头环境诚实告知）；`computer_control` 无头沙箱不支持、明确返回。
  - **沙箱**：文件工具禁越界（路径穿越直接拒）；命令执行受沙箱开关约束。
  - **审批**：步骤级 gate 已修通——manual 档 write_file 步骤会被拦截、前端 `/approve` 后状态置 `approved`、续跑跳过 gate 真实落盘；`/api/tools/run` 对风险工具无 `approved` 一律 403。
  - 任务步骤动作（`write_file` 等）映射到工具，执行结果如实写进 step 明细与 artifact（kind=file 指向真实路径）。

### T-032 模板详情页 + 应用模板生成产物 —— ✅ 已完成
- **后端**：`catalog.get_template(title)` 返回模板完整记录（含按 desc 生成的 `prompt`）；新增 `GET /api/templates/{title}`，不存在 → 404。
- **数据**：`mock.ts` 12 个模板补 `desc` 字段（单源），`scripts/gen-catalog.mjs` 同步解析 `desc` 并重生成 `catalog.json`（数量自检未破，仍 12 条）。
- **前端**：新增 `TemplateDetailModal.vue`——点击模板卡片开详情弹层（标题/分类/描述 + 将要发给 Agent 的指令预览）；"应用模板"调用 `createTask`+`streamTask`，复用任务执行面板（步骤/流式正文/产物/审批拦截/错误重试），与首页同源；无后端时诚实提示"未连接后端，未真正执行"。
- **验证**：`smoke_test.py` 新增 `test_template_detail`（详情含 prompt、不存在返回 None）；`scripts/api_smoke.mjs` 新增 `templates/detail`（200 + prompt）与 `templates/missing`（404）；后端两项全绿。
- **已在本机验证**：前端 `vue-tsc`/`vite build` 通过（2026-09-25，`ELECTRON_SKIP_BINARY_DOWNLOAD=1` 跳过 electron 二进制下载即可编译）。
- **下一步**：T-033 已完成（见任务表）。
- **已验证**：`smoke_test.py` 新增 2 项（工具注册表 + 审批后真实落盘）；`scripts/api_smoke.mjs` 新增 tools 接口（列表 200 / gate 403 / 写入 200）；全部通过。
- **前端状态**：工具控制台 UI 已随 T-015/T-024 接入（规则/命令/授权/MCP 页面）；后端能力已就绪，T-030/T-031 已实现、可被 agent 调用。
- **下一步**：E5 收尾——T-054 自动更新 / T-055 全局快捷键 / T-061 性能基线。

### T-004 打包 —— ✅ 已完成（安装包已出，实机启动待验证）
- **已完成**：`apps/desktop-node/package.json` 加 `electron-builder` 配置（`build` 字段：appId/productName/win 目标 `nsis`+`portable`/icon）+ `pack`(`--dir`)/`dist`(`--win nsis portable`) 脚本；`build/icon.ico` 由 PNG 内嵌生成（Windows 合法 ICO）。
- **打包内容**：`resources/ui`（前端 dist）与 `resources/backend`（Python 后端源码）经 `extraResources` 随包分发；壳源码进 `app.asar`；已实测产出 `EvaWork Setup 0.1.0.exe`（NSIS 安装包）与 `EvaWork 0.1.0.exe`（免安装版），各 ~78MB。
- **关键修正**：`vite.config.ts` 改 `base: './'`——否则 `file://` 加载时 `/assets` 指向文件系统根，前端 JS/CSS 全部 404，壳里前端打不开（打包态无法启动）。已验证 `dist/index.html` 与 `resources/ui/index.html` 均改为 `./assets/...`。
- **运行时定位**：`main.js` 改打包态感知——`app.isPackaged` 时从 `resources/ui/index.html` 加载前端、从 `resources/python/python.exe` 拉起 `python -m evawork`；开发期回退 vite 与仓库目录；Python 缺失弹错误框而非静默失败。
- **验证**：本机 `electron-builder --dir` 与 `--win nsis portable` 均成功；`release/` 已 gitignore，不入库。
- **Python 运行时捆绑（子项，✅ 已完成）**：`scripts/bundle_python.py`（已加为 `pnpm bundle:python`，并被 `dist`/`pack` 前置调用）复制**可重定位**的基底 Python 到 `resources/python`（剔除全局污染的 site-packages 与 test/idlelib/tkinter/tcl/Tools/Doc/libs），`ensurepip` 引导 pip，仅装后端依赖（fastapi/uvicorn/pydantic/httpx + 传递依赖，走清华镜像），`extraResources` 已加 `python` 随包分发；`.gitignore` 忽略该产物（约 120MB）。**已实测**：捆绑后的 `resources/python/python.exe -m evawork` 能起服务并返回 `/api/health={"status":"ok"}`，且 `sqlite3`(3.49.1)/`ssl`(OpenSSL 3.0.16) 可用（持久化 T-040 无碍）。`main.js` 的 `pythonBin()` 已优先用 `resources/python/python.exe`。
- **未完成（子项）**：dmg（macOS）未做（Windows 优先）。**双击安装/启动 ✅ 已验证**（2026-09-25：双击 `release/win-unpacked/EvaWork.exe` 实机启动，壳+后端+UI 全链路 OK、无崩溃；当前 dist UI 另经 e2e 18/18 渲染验证）。注：现有打包嵌入 0.1.0 旧 dist，需 `pnpm dist` 重建以含当前代码（本沙箱构建被环境拦截，待你本地执行）。
- **下一步**：T-054 自动更新接入 `electron-updater`；或补 dmg。

### T-061 性能基线 —— ✅ 已完成
- **工具**：`scripts/perf-baseline.mjs`（Playwright + 本地 Node 静态服务器托管 UI，机制与 T-060 e2e 一致）。
- **实测基线（本地 HTTP，headless，1280×820）**：
  - 冷加载：TTFB 11ms / DOMContentLoaded 92ms / **Load 203ms** / **FCP 224ms** / **LCP 272ms**。
  - 18 条 hash 路由挂载中位 **4–33ms**（首页 27、市场 31、设计系统 33、订阅 29、规则 31、授权 32 略高，其余 < 16ms）。
- **落盘**：`scripts/perf-baseline.json`（含时间戳、环境、冷加载与各路由中位数），作为回归对比基线——后续改动若让 Load/LCP 或路由挂载明显变慢，可当场发现。
- **说明**：数值为本地托管测量（与打包态同机制：本地 HTTP），不含真实安装包启动开销；真机/安装包环境应再测一次作为发布基线。
- **未做**：Web Vitals 上报、长任务/内存基线、发布流水线自动比对。

### T-054 自动更新 + 崩溃上报 + 日志 —— ✅ 已完成（自动更新真连通待发布 release）
- **日志**：`src/logger.js` 主进程文件日志落 `userData/logs/eva-YYYY-MM-DD.log`（按天滚动），并 `forwardRenderer` 转发渲染层 error/warn 到主日志（info/debug 不收，避免刷屏）。已 Node 实测落盘。
- **崩溃上报**：`src/crash.js` 捕获 `uncaughtException` / `unhandledRejection` / `render-process-gone` / `child-process-gone`，写 `userData/crash/crash-*.json` 并尽力 POST 到后端 `/api/crash`；后端 `api.py` 新增 `POST /api/crash`（202 + 落盘 `crash_reports/`）。**已实测闭环**：后端 health→POST→`crash-test1.json` 落盘。
- **自动更新**：`electron-updater` 作为 `dependencies`（确保打进 `app.asar`）；`package.json` 加 `build.publish`（GitHub，owner `qoobots` / repo `eva`）；`main.js` 仅打包态 `setupUpdater`——启动静默检查一次、菜单"帮助 > 检查更新…"可手动触发、`ipcMain` 接收渲染层 `trawork:check-updates`；`autoDownload=false`（提示后由用户确认）。
- **诚实说明（未验证）**：① 自动更新的**真实下载安装**需把构建产物发布到 GitHub Releases，且 Windows 安装包需代码签名（delta 更新要求），本环境未发布故未跑通真更新；② 菜单为精简版（文件/编辑/视图/窗口/帮助），如需更丰富可再补。
- **下一步**：T-053 的 axe 对比度走查（P3）；或补 PyInstaller 捆绑 Python 运行时进 `resources/python`（T-004 子项）。

### T-053 无障碍 / axe 走查 —— ✅ 已完成（18 路由 axe 0 违规）
- **键盘可达基础**：`app.css` 有 `:focus-visible` 焦点环 + `.sr-only`；菜单项用 `<button>`+`aria-expanded`、`useEscape` 关浮层；C/V 模式用 `aria-*`。
- **axe 自动走查（T-053 核心）**：`scripts/a11y-axe.mjs`（`@axe-core/playwright`，复用本地 HTTP 托管 UI），逐路由扫描 wcag2a/aa/21a/aa + best-practice，结果落盘 `scripts/a11y-axe.json`。
- **首测基线 → 修复 → 复测**：首测 18 路由 **47 违规**（color-contrast 161 元素 / landmark-one-main 10 / region 10 / page-has-heading-one 8 / button-name 38 / scrollable-region-focusable 2）。修复后复测 **18 路由 0 违规**。
- **修复清单**：① admin 布局用 `<main>` 包裹内容（消 landmark-one-main + region）；② 8 个 work 视图补 `<h1>`（NewTaskView 加 sr-only h1、DesignSystemDetailView 标题转 h1、其余 `page-title` 转 `<h1>`）；③ 图标按钮补 `aria-label`（`UToggle` 加 `role="switch"`+`aria-label`，plus/mic/send/收藏/视图切换/返回/关闭/授权开关等）；④ 滚动容器 `.a-body`/`.dsd-body` 加 `tabindex`；⑤ 亮色令牌提深以满足 AA（`--t2 #5f646b`、`--t3 #6b7077`、`--blue #1f5fd0`、`--green #007a4f`，改的是写死在令牌里的值）；⑥ 深色弱文字提亮至 `#8b9094`（该值现已归入 `.admin-console` 令牌 `--ac-text-muted`；admin 控制台写死色值已整体令牌化，见下方"已完成"子项）。
- **诚实边界**：仍**未做**真实键盘 Tab 走查（无头环境难验）。
- **admin 深色样式令牌化（子项，✅ 已完成）**：原 11 个 admin 页面共 **224 处**写死色值（`#141517`/`#1b1d1f`/`#212325`/`#8b9094`/`#24d07a` 等面板调色板，含 `<script>` 内热力图/品牌色与内联 `style`），违反"组件不许写死色值"规范。`scripts/tokenize-admin.mjs` 将其全部替换为 `.admin-console` 令牌——`app.css` 新增 `.admin-console` 令牌块（值=原色），`AdminLayout` 根加 `admin-console` 类使令牌级联到整个控制台子树；**零视觉回归**（已 `vue-tsc` + `vite build` 通过）。剩余——真实键盘 Tab 走查（无头难验）。
- **下一步**：dmg（macOS，用户暂缓）。实机双击启动验证 ✅ 已完成（见上「诚实边界」）。

### ◻ 静态控件诚实化 —— ✅ 已完成（T-053 后续，见文档「下一步建议」#1）
- **背景**：文档"诚实控件清单"列了一批 ◻ 静态控件——"看起来可点但点了没反应"，违反"静默失败最伤人 / 界面放了控件就必须真的有动作"的原则。
- **机制**：`app.css` 新增全局 `[data-coming]` 样式（变灰 `opacity:.5` + `grayscale` + `cursor:not-allowed` + `title` 提示，`aria-disabled`），统一把无动作的控件显式标记为禁用外观，不再与可点控件混淆。
- **已接真实动作（而非禁用）**：① 消息弹层"去设置"→ 开设置弹层、"去体验"→ 跳 `/office`、"去详情"→ 跳 `/design`；② ~~升级弹层 4 档套餐可选~~（**2026-10-02 随升级权益一起下线**）；③ 首页快捷 chips / 建议卡 点击填入输入框 `prompt`。
- **已标记禁用态（`data-coming`）**：首页 `+` 菜单 8 项、添加模型、语音输入、本地/选择文件夹；插件市场"管理/上传技能"；自动化"在对话中创建"；设置"添加模型/模型提供商卡/帮助·关于链接"；账户"隐私开关"；admin"下载 TraeCode"、云端"新建环境"。
- **经核对原标 ◻ 已过时（实为真实/已禁用，未改）**：自动化"手动新建"（已接 `createAutomation` 表单）、MCP"手动添加"（已接 `add` 表单）、用量"时间范围切换"（已接 `days` 分段）、~~订阅/用量"升级·开票"~~（**2026-10-02 已随计费口径整体下线**）、Office 助理（已用 T-034 "去绑定/即将上线"诚实模式）。
- **验证**：`vue-tsc` 类型检查通过、`vite build` 通过；无显示环境，视觉级 hover/禁用态需有界面时复核。
- **诚实边界**：仍**未做**真实键盘 Tab 走查（无头难验）；dmg（macOS，用户暂缓）。**实机双击启动验证 ✅ 已完成**（2026-09-25）：双击 `release/win-unpacked/EvaWork.exe` 实测——Electron 壳启动、捆绑 Python 后端 `/api/health` 返回 `{"status":"ok"}`、UI 本地服务（:4280）返回 Vue 应用 HTML、`[electron] backend ready: true`，无致命崩溃；当前 dist（含 ◻ 修复）另经 `scripts/e2e-ui.mjs`（真实 headless chromium）验证 18/18 路由渲染、0 未捕获异常、0 console.error。**说明**：现有打包 exe 嵌入的是 0.1.0 旧 dist（标题仍 EvaWork、不含本轮 ◻ 修复）；用当前代码重建打包（`pnpm dist`）在本沙箱被环境拦截（npm install 后 node_modules 被清空 / electron postinstall 被 allow-scripts 拦 / bundle_python 重捆绑触发 2609 文件批量删除安全确认），需在你本地正常 npm 环境执行 `pnpm dist` 以产出含当前代码的安装包。

### T-070 Agent 内核 tool-use 循环 —— ✅ 已完成（2026-09-26）

**做了什么**

1. `agent.stream_turn()`：带 `tools` 的单轮请求，**把流式 `tool_calls` 按 index 增量拼接**（`function.arguments` 是分片下发，只取最后一片是流式 function-call 的经典 bug）；未配 Key / 无工具清单时退化为纯文本流，**不伪造 tool_call**。
2. `runner._run_agent_step()`：模型请求 → 工具执行 → `role=tool` 回填 → 再请求模型，直到无 tool_call 或 `MAX_TOOL_ROUNDS=8`；原 `infer_action()` 关键词猜动作 + `ACTION_TO_TOOL` 固定映射已删除。审批 gate 对**模型发起的调用**同样生效，并把真实风险动作写回 `step.action`（否则 `/approve?remember=1` 记住的是规划期猜的动作，续跑会被反复拦截）。
3. `tools.openai_schemas()/resolve_name()/action_map()`：注册表（含 MCP）→ OpenAI function schema；MCP 工具名含冒号故别名化，执行前还原真名。
4. 前端：`TaskEvent` 增 `tool_call`/`tool_result`；抽出 `composables/useToolRuns.ts`（新建任务页与模板弹窗共用），可展开查看工具名/参数/成功失败/输出；样式进全局 `app.css`。

**验证**

- 离线冒烟新增 4 个用例全绿：替身模型驱动的「调用→被拦→放行→真落盘」闭环；流式参数分片拼接正确；MCP 别名往返；**真 socket 假 OpenAI 端点**端到端（`tools_sent=2`、`result_back=1`、文件真落盘、任务 done）。
- `vue-tsc` 类型检查 + `vite build` 通过。

**未做（不假装）**

- ~~并行/独占调度（harness 的 `executionMode`）~~：**已解决**（T-074，`execute_batch` 已按模式并发/独占调度）。
- 单请求失败重试：当前失败会被兜成一段错误文本而不是重试，见 T-071。

### T-071 turn/step 双层循环 + 步骤级重试 —— ✅ 已完成（2026-09-26）

**做了什么**

1. `agent.py`：新增 `RetryableError` / `FatalError` 与 `classify()`（httpx 异常 → 类型），并按状态码提前判定（429/5xx 可重试，其余 4xx 终态）。新增 `_text_stream()` 让错误对调用方**可见**；`stream_completion()` 保留旧契约（降级为文本，`/api/chat` 不崩）。
2. `runner.stream_step()`：一次模型请求 = harness 的一个 **step**；瞬时错误退避重试**同一份 messages**（≤2 次，0.5s/1.5s）并产出 `retry` 事件；`FatalError` 直接抛出 → 任务置 `failed`。
3. **重试边界（诚实性关键）**：已经对外吐过 token 的请求**不再重来**（重来会拼出重复正文），而是如实标注 `[连接中断] …` 并把该轮标 `ok=false`，步骤不会被误标 `done`。
4. 规划阶段与工具循环共用同一层重试；前端 `TaskEvent` 增 `retry`，两个执行入口以系统提示展示。

**验证**

- 新增 2 个真 socket 用例：先返 2 次 429 → 产出 2 个 `retry` 事件、重试后任务 `done`；返 401 → 只请求 1 次、无 `retry` 事件、任务 `failed` 且错误信息含 401。
- 离线冒烟全绿；**API 层冒烟（真实后端 + Node 客户端）通过**；`vue-tsc` + `vite build` 通过。

**未做（不假装）**

- turn 层的跨 step 元数据（如 token 用量累计），待 T-072 事件落盘后统一处理。

### T-072 事件日志即真相 —— ✅ 已完成（2026-09-26）

**做了什么**

1. `store.py`：新增 `events(rev PK AUTOINCREMENT, task_id, type, payload, ts)` 表与 `append_event` / `load_events(since)` / `latest_rev` / `has_event`；删任务时一并清事件。
2. `runner.run_task`：**每帧先落盘再产出**，并把 `rev` 带回前端；真实执行逻辑下沉到 `_run_events`，落盘失败只报警、不拖垮任务。
3. `api.py`：`GET /api/tasks/{id}/events?since=<rev>` 增量拉取；SSE 支持 `since`——先把没看到的帧按 rev 顺序补齐再接实时流；**已结束 / 待审批状态只补历史、不重跑**（重跑会制造重复帧）。
4. 顺带修掉两个会造成"重复"的真问题：续跑时不再重复补发 `plan`；`done`/`skipped` 的步骤不再被重跑。
5. 前端：`StreamEvent`（带 `rev`）、`fetchTaskEvents()`、两个执行入口续跑时传 `since=lastRev`。

**验证**

- 离线冒烟 2 个新用例：84 帧全部带 rev 且递增、全量回放一帧不差、`since` 增量帧集与顺序吻合；续跑只产出 `status/done` 两帧（plan 仍为 1、无 step 重跑）。
- API 层冒烟新增 5 项（真实后端 + HTTP）：`events/stream` 84 帧均带 rev、`events/full` 回放 84 帧、`events/since` 补发 41 帧、`events/replay-only` 已结束任务不重跑、`events/404` 删除后 404。
- `vue-tsc` + `vite build` 通过。

**未做（不假装）**

- 前端尚未做"重开窗口回放历史任务"的界面（接口已具备，UI 未接）；事件只增不减，长时间运行需另加清理策略。

### T-074 统一工具管线 —— ✅ 已完成（2026-09-26）

**做了什么**

1. `tools.py`：`ToolSpec` 增 `execution_mode`（parallel/exclusive）与 `timeout`；`run_command`/`computer_control` 默认独占，扩展工具（MCP）未声明时按动作风险推断（动机器状态的一律独占）。
2. **三段式管线**（`run_pipeline` 串联，本地工具与 MCP 扩展共用同一条）：
   - `pre_execute`：解析参数 + **确定性**拦截（未知工具 / 参数非 JSON / 缺必填 / 沙箱硬底线）。
   - `_dispatch_pipeline`：真实执行，**带超时**（`asyncio.wait_for`）。
   - `post_execute`：归一化 + 输出截断（回填模型与展示前端共用一份结构，不再两处各截一次）。
3. **并行/独占调度** `execute_batch`：parallel 用 `gather` 真并发；exclusive 是 barrier——等并行段收尾后逐个串行，且持独占闸（按事件循环缓存，避免跨 `asyncio.run` 的 lock 绑定问题）。结果**与入参同序**，杜绝 tool 消息串台。
4. runner：一轮的多次调用交给 `execute_batch`；`tool_call` 事件移到**审批之前**发出（待审批时人也能看见模型想干什么）；审批 gate 仍是同步关口（`_needs_gate`），命中即挂起整批。
5. 前端：`tool_result` 带 `elapsed_ms`/`mode`，工具行展示耗时与"并发/独占"提示；`pushToolCall` 按 id 去重（续跑会收到同 id 的第二次 tool_call）。

**验证**

- 离线冒烟新增 5 例，全部实测：3 个 0.4s 的 parallel 调用总耗时 **0.41s**（串行应约 1.2s）；2 个 parallel + 1 个 exclusive 耗时 0.71s、并行峰值 2、**独占期重叠 0**；超时用例如实报 `ok=false`/`timeout=true`（上报耗时 310ms）；真 socket 端到端 3 次调用 → 3 条结果 → 回填 3 条 tool 消息且顺序一致；`pre_execute` 对未知工具/坏 JSON/缺参/沙箱四类均拦截。
- API 层冒烟新增 `tools/run(reject)`：缺必填参数被结构化拒绝（此前会解析到沙箱根炸成 500）。
- `vue-tsc` + `vite build` 通过。

**与 harness 的偏差（如实记录）**

- **ask 不放在 `pre_execute`**：人工审批要挂起整个流等人，属于调用方（runner 的 step gate、`/api/tools/run` 的 `approved`）。硬塞进工具层会让工具层反过来驱动交互层。
- **工具不重试**：副作用不可重放，重试只发生在"模型请求"层（T-071）。
- **超时只能放弃等待**：`wait_for` 取消不了线程池里已发出的阻塞调用（杀不掉线程/子进程），如实报错，不假装成功。

### T-073 协作式取消 —— ✅ 已完成（2026-09-26）

**做了什么**

1. **取消信号**：`runner.cancel_scope(task_id)` 为每个任务登记一个 `asyncio.Event`（按事件循环分组，退出即清理）；`request_cancel(tid)` 只**置位信号**，不打断执行。
2. **协作式停点**（不用 `task.cancel()` 强杀——强杀会丢掉已产出的正文，而"内容不丢"正是这个功能存在的意义）：
   - token 之间：收到信号即停止消费剩余流，后续 token 不再进事件流；
   - 工具轮次之间 / 步骤之间 / 规划之后：命中即收尾。
3. **中断锚点**：已吐出的正文 + `[已中断]` 写进 `step.detail` 与 `task.messages`，步骤状态置 `cancelled`；续跑时这段内容带锚点进上下文，模型知道上次停在哪。
4. **API**：`POST /api/tasks/{id}/cancel`——有流在跑走协作式；没流在跑（等审批/已结束/重启过）直接落持久态 `cancelled`，返回体里写明走了哪条路，**不假报"已取消"**。`cancelled` + `resume=1` 允许从断点续跑。
5. **前端**：执行中显示「停止」（请求后端取消，不是关 SSE——关流只是前端看不见，任务还在跑）；中断后显示「已中断」徽标与「继续」按钮；新建任务页与模板弹窗共用同一套。

**验证**（离线冒烟 2 例 + API 冒烟 2 项，均实测）

- 中途取消：任务置 `cancelled`、产出 `cancelled` 帧、正文为 `开头\n[已中断]`（信号置位后的两段文本**确实没进来**）、步骤 `cancelled`、锚点进了 `task.messages`。
- 中断后续跑：第二次跑到 `done`，被中断的步骤重置为待执行并重跑成功，且模型上下文里能看到上一次的中断内容。
- API：无流在跑时取消 → `state=cancelled`（返回模式如实写明）；终态任务再次取消 → `cancelled=false` 并给出"任务已结束，无需取消"。

**诚实边界**：工具一旦下发就等它跑完——线程池里的阻塞调用杀不掉（与 T-074 的超时同理）。取消只保证在"下一个安全边界"停下，不承诺毫秒级。

### T-076 Skills 技能系统 —— ✅ 已完成（2026-09-26）

**做了什么**

1. **发现**：新增 `skills.py`。用户级 `~/.evawork/skills/`（可用 `TRAWORK_SKILL_DIR` 替换）＋ 项目级 `<工作目录>/.evawork/skills/`；支持 `<name>/SKILL.md`、`<cat>/<name>/SKILL.md`、`<name>.md` 三种摆放。
2. **解析**：front-matter（`name` / `description` / `allowed-tools`）**自己解析，不引 PyYAML**——技能文件只需要 `key: value` 与 `- item`，为这点需求加依赖不值得，也避开 YAML 隐式类型转换的坑。
3. **缓存**：按 `(路径, mtime, size)` 签名比对重扫（**没做文件监听**：后台 watcher 线程会引入"缓存与实际不一致"的新问题，而技能目录通常只有几十个文件，重扫代价可忽略）——于是"删掉文件列表就消失"天然成立。
4. **`/name` 直调**：`POST /api/tasks` 新增 `skill` 字段；runner 把技能正文注入系统提示（规划与每步都注入），并把工具收窄到 `allowed-tools ∩ 注册表`（含技能自带脚本）。**技能不存在就 404**，不假装"带技能跑"。
5. **技能脚本**：技能目录下 `scripts/*.py` 注册成 `skill.<技能>.<脚本>` 工具，`action=run_command`——于是**自动继承 T-023 的审批判定与沙箱拦截，技能没有比命令更高的特权**。
6. **端点**：`/api/skills/installed`（已加载清单与目录位置）、`/api/skills/{name}`（详情）、`/api/skills/reload`（手动重扫）；`/api/skills` 市场列表给本地技能打 `loaded`，市场里没有的纯本地技能也会出现在列表里。
7. **前端**：`+` 菜单的"技能"不再是占位——列出已加载技能，点击填入 `/name `；输入框 `/name 参数` 直达；运行头显示技能标签（悬停看它拿到的工具）；市场卡片标注"已加载"。

**验证**（离线冒烟 3 例 + API 冒烟 5 项，均实测）

- 发现与解析：技能被发现、正文/描述/`allowed-tools`/脚本均解析正确，脚本以 `skill.review.echo` 进 `/api/tools`；`parse_invocation("/review 看看这个改动")` 正确；**删掉目录后技能确实消失**（缓存没把它留住）。
- 脚本执行：沙箱档（非 full）**被拦**（`sandbox_blocked`），full 档真实执行并收到参数；技能删掉后脚本工具也调不动了。
- 任务注入：产出 `skill` 事件；技能正文确实进了给模型的 system 消息；工具清单收窄为 `['read_file', 'skill_readonly_noop']`。
- API（真实 HTTP，后端带 `TRAWORK_SKILL_DIR` 启动）：`/api/skills/installed` 能看到、脚本在 `/api/tools` 里、市场列表可见、绑定技能创建任务成功、**未知技能 404**。
- `vue-tsc` + `vite build` 通过。

**诚实边界**：技能脚本只在 full 档（关闭沙箱）可跑；`allowed-tools` 若声明了不存在的工具，交集为空时**退回不收窄**（否则技能会陷入无工具可用的死局）。

### T-078 交付物记录 —— ⏭ 下一步（P2）

- **现状**：只有 artifact 列表（产物面板），**没有改动集**——每轮新增/修改/删除了哪些文件、产物来自哪一轮，一律查不到。用户只能看到"有个文件"，看不到"它怎么来的、改了什么"。
- **方案**：① 每次 `write_file` 成功就把路径与动作记进任务的 `changes`（新增/修改）；② 产物记录 `round`（来自第几轮工具循环）与来源工具名；③ 新增 `GET /api/tasks/{id}/changes`，产物面板展示"本轮改动"并可点开看差异摘要。
- **验收**：跑一个写了两个文件的任务 → `/api/tasks/{id}/changes` 能列出两条改动与所属轮次；重复写同一文件记为"修改"而非"新增"。
- **依赖**：T-040 持久化、T-070 工具循环、T-074 管线（均已达成）。
- **依赖**：T-070/T-071/T-072（均已达成）。

### 本地联调提示（重要）
- Electron 二进制：本沙箱经 `NODE_OPTIONS=--use-system-ca` 已成功下载（v31.7.7），`pnpm dev` 可实机启动；你本地若未下载，先设该变量再 `pnpm install`。
- **不开 Electron 也能验证前端**：在 `apps/desktop-ui/.env.local` 写 `VITE_BACKEND_URL=http://127.0.0.1:18765`，然后 `pnpm backend` 起后端 + `pnpm dev` 起前端即可。

### T-081 消息正文持久化 —— ✅ 已完成（2026-10-02）

**做了什么**

1. `store.py`：新增 `messages(task_id, seq, role, content, ts)` 表 + 索引；`save_task` 一并重写消息、`load_tasks` 按 seq 恢复、`delete_task` 连消息一起删（不留孤儿行）。正文统一 `_msg_content()` 转字符串（模型消息 content 可能是 None 或结构化片段）。
2. `runner.py`：每一步的最终答案 `task.messages.append({"role":"assistant","content":final})` —— 此前正文只落在 `step.detail` / artifact / token 事件帧里，`task.messages` 从头到尾只有一条用户消息，所以"重启后历史对话全空"。
3. 顺带收益：`messages` 本就是每步的上下文来源（ `_run_agent_step` 用 `list(task.messages) + ...`），落盘后**下一步能看到上一步的结论**，多步骤任务的上下文不再互相失忆。

**验证**

- 离线冒烟新增 `test_messages_persist()`：执行后 roles = `user, assistant×3`；**换一个 `TaskStore()` 模拟重启**，重读出的正文与重启前逐条相等；删除任务后不会被重新读出。全量冒烟 **ALL SMOKE TESTS PASSED**。
- 真实后端（含真模型）端到端：创建任务 → `POST /stream` 跑完 → `GET /api/tasks/{id}` 返回 **msgs=5（user + assistant×4）**。
- **杀进程重启后端**后再查同一任务：仍为 **msgs=5**，状态 `done` —— 即验收标准三条全部达成。

**诚实边界**：改前已存在的历史任务，其 `messages` 在库里本来就没写过，仍是空列表（数据没丢，是从来没存过）。这些任务的前端回显继续走 T-072 事件回放（能重建执行过程），但"对话正文"只有新任务才有。

### T-082 沙箱升级为真隔离 —— ✅ 已完成（2026-10-02）

**做了什么**

1. 新增 `evawork/sandbox.py`（沙箱 seam）：三档 `read-only` / `workspace-write` / `danger-full-access` + `probe()` 能力探测 + **fail-closed**（探测不到隔离能力就拒绝，绝不降级裸跑）+ `Report(full/partial/unavailable)` 如实汇报。
2. **沙箱与审批解耦**：`mode_for(approval)` 把"能不能做"和"要不要问人"拆开。注意 `manual` 映射成 **workspace-write**（dsh 的模型是 `workspace-write + ask`），不是 read-only——否则"人批了却写不了"。
3. Windows 后端：复制自身令牌 → `AdjustTokenPrivileges` 禁用全部特权 → 降到 **Low 完整性** → `CreateProcessWithTokenW` 起进程 + **Job Object**（超时能杀整棵进程树，顺带修掉"超时后子进程仍在跑"的老问题）+ `icacls /setintegritylevel Low /T` 给工作区打标签。
4. `tools.pre_execute` 按档位 deny（写/命令），`run_command` 改走 `sandbox.execute`。
5. `skills.py` 改走 `sandbox.execute_argv`：**技能不再比命令拥有更高特权**（此前直接 `subprocess.run` 绕过沙箱，与设计约定自相矛盾）。
6. 顺带修掉一个真实 bug：`subprocess.run(text=True)` 按**系统代码页**解码，中文输出在 GBK 代码页下会 UnicodeDecodeError 被吞成空串——显式改 `encoding="utf-8", errors="replace"`。

**实测踩过的坑（都写进注释了）**

- `CreateProcessWithTokenW` 传 `lpCurrentDirectory` 会报 **267（目录名无效）** → 改成不传 cwd，在命令里 `cd /d`。
- **Safer API 的"受限令牌"不能用**：触发 Windows 双重访问检查，第二遍只用受限 SID 比对 DACL，结果**任何写入都被拒**（连工作区内都写不了）→ 改用"复制令牌 + Low 完整性"。
- 输出文件**不能预先 `mkstemp`**：以普通进程（Medium）建好的文件，Low 完整性子进程写不进去 → 只给路径，让子进程自己创建。
- 完整性标签**不会继承**，且 `/T` 递归必须在**创建临时输出目录之后**执行，否则子进程连输出文件都建不出来 → 输出重定向一失败，cmd 会放弃整条命令（表现为 rc=1 且输出为空）。
- 命令行里塞 JSON 参数，转义结果**随外层 cmd 层数变化** → 技能脚本改走 argv 直执行，不经 cmd。

**验证**（全量冒烟 `ALL SMOKE TESTS PASSED`）

- `test_sandbox_modes`：三档映射、read-only 真的拒写拒命令、路径穿越仍被拒。
- `test_sandbox_confined_write`：**写工作区外 → rc=1、输出"拒绝访问"、文件未被创建**；**写工作区内 → rc=0、文件存在**（双向验证，防止沙箱过紧把工具自己废掉）。
- 技能脚本在两档下都真跑通并收到参数；此前 4 处"非 full 档必须拦截命令"的旧断言已按新语义更新为"受限执行或 fail-closed 拒绝，唯独不接受裸跑"。

**诚实边界**

- Windows 上只能到 **partial**（dsh 同样承认）：SID 未剥离，隔离依赖完整性标签；硬链接、已开放 Everyone 写的目录仍可写。
- Linux/macOS 的 bwrap / Landlock / Seatbelt **尚未接线** → 探测返回 `unavailable`，命令被 fail-closed 拒绝（宁可不做，也不裸跑）。
- `danger-full-access` 档仍是原样执行（用户明确承担风险），仅受 Job Object 的进程树收拢约束。

### T-083 上下文治理（spill + compaction）—— ✅ 已完成（2026-10-02）

**做了什么**

1. 新增 `evawork/context.py`：上下文治理 seam——`estimate_tokens/estimate_messages`（CJK 1 字≈1 token、其余 4 字符≈1 token 的粗估，够做阈值判断即可，不引 tiktoken）、`spill()`、`fit()`、`compact()`。
2. **spill 取代硬截断**：`tools.post_execute` 与 `runner._stringify` 原来各截一刀（4000 字），**原文永久丢失**。现在超过阈值就落盘，模型只拿 `head/tail + 路径`，需要细节时自己 `read_file` 取回。落盘目录是**工作区内**的 `.evawork-spill/`——放在工作区外的话，受限进程里的 `read_file` 反而读不到，等于白落。
3. **compaction 压缩历史**：`runner._run_agent_step` 每步先把 `task.messages` 过一遍 `compact()` 再进上下文。规则与 dsh 一致：system 永远保留 → 最近 N 条逐字保留 → 更早的先逐条瘦身 → 还不够才折成一条摘要。
4. 关键约束：压缩**只作用于"发给模型的这份拷贝"**，不改 `task.messages` 本身 —— 所以 T-081 落盘的历史、续跑与事件回放看到的仍是完整原文。

**验证**（全量冒烟 `ALL SMOKE TESTS PASSED`）

- `test_context_spill_and_compaction`：① 120KB 输出 → 预览仅 1942 字符、落盘文件与原文**逐字节相等**（原文可取回）、预览里带路径；② 50 轮长历史 **80634 → 17335 tokens**，系统提示与最近一条逐字保留，且原 `messages` 未被改动；③ 管线里 `post_execute` 真的返回 `spilled_to` 而非截断。
- 真实管线：写 80KB 文件再 `read_file` → 模型侧只看到 1942 字符 + `.evawork-spill/…txt`，原文完整保留在磁盘。
- 真实任务端到端回归（真模型）：`state=done`，事件流 token 20 / step 6 / tool_call 1 / tool_result 1 / artifact 3 / done 1 —— 压缩与溢出未影响正常链路。

**诚实边界**

- 摘要是**抽取式**的（本地按条裁剪拼接），**不额外调模型**：多一次模型调用既花钱又多一个失败面，等真需要语义摘要时再接。
- token 数是粗估，不追求与厂商计数器一致；估得保守一点，压缩的代价远小于撑爆窗口。
- 阈值可配：`TRAWORK_SPILL_CHARS` / `TRAWORK_SPILL_HEAD` / `TRAWORK_SPILL_TAIL` / `TRAWORK_KEEP_RECENT` / `TRAWORK_CONTEXT_TOKENS`。

### T-084 工具集扩容 6 → 15 —— ✅ 已完成（2026-10-02）

**新增 9 个本地工具**（全部只往 `TOOLS` 注册表 + `_DISPATCH` 加条目，审批/沙箱/并发策略**自动继承**，没有一处重复实现约束）：

| 工具 | 动作类别 | 真实能力 |
|---|---|---|
| `grep` | llm（只读） | 工作区内正则搜内容，返回 `路径:行号:内容`，跳过噪声目录与超大文件，命中封顶 200 |
| `glob` | llm | 通配符列路径，封顶 500 |
| `str_replace_editor` | **write_file** | str_replace / create / view / insert；`old_str` **必须唯一命中**（0 处或多处都报错，不替模型猜） |
| `web_fetch` | network | 抓网页 → 去标签/脚本转纯文本 |
| `web_search` | network | DuckDuckGo HTML 端点（无需密钥）；解析不出结果**如实报错** |
| `http_request` | network | GET/POST/…，带回 status / headers / body |
| `todo_write` | llm | 持久化待办（按 id 合并 = 更新状态），落在**应用数据区**而非用户工作区 |
| `terminal` | **run_command** | 持久化会话：`cd` 记住工作目录，后续命令在同一目录继续 |
| `read_image` | llm | 纯 stdlib 解析图片格式/宽高（不引 PIL）；默认不内联 base64 |

**顺带修掉的一个真实缺陷**：`runner.infer_action` 见"命令"二字就判 `run_command`，于是模型写"用 glob 命令找文件"会被当成要开 shell → 进本不该有的审批等待。现在点名了只读工具（grep/glob/list_dir/read_file/read_image）且没提终端/shell 的，判只读。

**验证**（全量冒烟 `ALL SMOKE TESTS PASSED`）

- `test_tools_expanded`：`/api/tools` 与 `list_tools()` **均为 15**；新工具全部 `registered` 且带 `execution_mode`；`str_replace_editor.action == write_file`、`terminal.action == run_command`（继承关系断言）。
- 真跑：grep 命中 2 条、glob 命中 1 条、str_replace 唯一命中才改（2 处命中报错、create 撞已存在报错）、todo_write 按 id 合并后 `done=1`、1×1 PNG 解析出 `format=png,width=1`、`terminal` cd 后会话 cwd 保持、本地 HTTP server 上 `web_fetch` 拿到 `eva` 且 `<script>` 被剥掉、`http_request` 拿到 `status=200`。
- 真实任务端到端（真模型）：任务 `task-d01f1e92` `state=done`，事件流 `tool_call 2 / tool_result 2`，调用的工具**正是 `glob` 与 `grep`** —— 验收项"模型能真实调用并回填"达成。
- `web_search` 在本机联网不通（URLError 超时）→ 如实返回 `ok=false + 搜索失败：…`，**没有编造结果**。

**诚实边界**

- `terminal` 是**持久化会话**（cwd 保持），**不是真 PTY**——交互型程序需要终端自身能力，不假装提供；进程重启会话即失效。
- `web_search` 走 DuckDuckGo HTML，无密钥但依赖对方页面结构；结构变了会如实报"解析不出结果"。
- `read_image` 只给元数据（当前模型通道是纯文本，内联 base64 读不出内容还会撑爆上下文）；WEBP/PDF 只报格式、不报宽高。
- `todo_write` 落在应用数据区而非工作区：它是 agent 自己的计划状态，不该占用"写用户文件"的审批额度。

### T-085 能力 seam 抽象 —— ✅ 已完成（2026-10-02）

新增 `evawork/seams.py`：四个对外依赖收敛成 **定义（Seam）+ 实现（Provider）** 两层。

| seam | 契约 | 默认 provider |
|---|---|---|
| `sandbox` | mode_for / can_write / can_command / work_dir / resolve / probe / execute / execute_argv | `LocalSandboxSeam`（委托 `sandbox`，行为与改造前逐字一致） |
| `approval` | normalize_mode / needs_approval / describe | `PolicyApprovalSeam`（委托 `policy`） |
| `llm` | provider / gate / config / list_models / stream_completion / stream_turn | `AgentLlmSeam`（委托 `agent`，并把 `agent.RetryableError/FatalError` 翻译成 seam 层异常） |
| `fs` | resolve / read_text / write_text / read_bytes / mkdir_parent / list_dir / is_file / is_dir / size / walk_files / glob | `LocalFsSeam`（真实磁盘，边界走 sandbox seam） |

**消费方全部改走 seam**（不再直接 import 具体实现）：`tools`（沙箱判定 + 全部文件读写）、`runner`（审批 gate + 模型流）、`api`（写文件/工具执行的审批）、`plugins`（装插件审批）、`skills`（技能脚本受限执行）、`context`（spill 目录）。新增 provider 只需 `seams.register("sandbox", X())`，这些文件一行都不用改。

**三条硬约定**

1. 默认 provider **只做委托**，不新增行为——换上默认实现后行为必须与改造前一致；
2. 换 provider 靠**显式注册**，不靠环境变量隐式切换（隐式切换会让"现在跑的是哪个后端"变成玄学，排障最贵的就是这个）；
3. provider 抛的异常**原样上抛**，seam 层不吞成一句话。

**可观测**：`/api/health` 增加 `seams` 字段，一眼看到当前跑的是哪四个 provider（实测返回 `LocalSandboxSeam / PolicyApprovalSeam / AgentLlmSeam / LocalFsSeam`）。

**验证**（全量冒烟 `ALL SMOKE TESTS PASSED`，新增 `test_seams_pluggable`）

- 真换上四个假 provider，行为随之改变：
  - 沙箱换成 `DenySandbox` → 原本放行的 `write_file`（full 档）变成"沙箱已拦截写入：read-only 档不允许写文件"；
  - 审批换成 `AlwaysAsk` → `runner._needs_gate` 对同一个只读步骤从 `False` 变 `True`；
  - fs 换成计数 provider → `read_file` 的 `reads` 从 0 变 1（证明读写真的过了 fs seam）；
  - 模型通道换成 `FakeLlm` → `runner.stream_step` 吐出 `fake-llm-said-hi`。
- **静态锁**：断言 `runner` / `tools` 源码里不再出现 `policy.needs_approval` / `agent.stream_turn` / `sandbox.execute` / `sandbox.mode_for` —— 以后谁再直接依赖具体实现，冒烟当场失败。
- 注册校验抓过一次真问题：只查 `callable()` 会被"继承基类空壳方法"骗过（桩方法可调用但 `raise NotImplementedError`），现在连"是否真的重写过"一起查，缺方法的 provider 注册即 `TypeError`。
- 运行时回归：重启后端后 `/api/health.seams` 四个 provider 可见；真实任务 `task-5c3f926b` `state=done`，`tool_call 2 / tool_result 2`（glob + grep），`approval 0` —— 改造没有引起回归。

**没做的事（诚实边界）**：这是**抽象层**，不是新能力——四个默认 provider 的行为与改造前完全一致，没有换来任何新的隔离能力或新的模型通道。真换后端（如 Linux 的 bwrap/Landlock、远端文件系统）现在只需写 provider，但那些 provider 本身尚未实现。

### T-086 审批 preset —— ✅ 已完成（2026-10-02）

**① 档位 = 沙箱档 + 审批规则打包**（新增 `evawork/presets.py`）

以前是两张各算一份的表（`policy` 管"要不要问"、`sandbox._BY_APPROVAL` 管"用哪档沙箱"），各自演进必然漂移。现在一个 `Preset` 同时回答两件事，判定只有 `presets.decide(mode, action)` **一处**：

| 档位 | 沙箱档 | ask（要问人） | deny（一律拒绝） |
|---|---|---|---|
| `manual` 手动审批 | workspace-write | 全部高风险动作 | — |
| `auto` 自动审批 | workspace-write | run_command / install_plugin / computer_control | — |
| `full` 完全访问 | danger-full-access | — | — |

新增 `deny` 语义，且与 `ask` 有本质区别：**ask = 可以放行但要人点一下；deny = 这个档位下根本没有"同意"这个选项**（安全底线不给它出现在审批弹窗里的机会）。自定义档位可 `presets.register(...)`（内置三档不可覆盖/注销，否则同一个 id 在两个后端上含义不同）。认不出的档位回落 `manual`，**绝不回落 full**。前端经 `GET /api/presets` 拿到清单（`sandbox_mode` / `ask` / `deny` 一目了然）。

**② 取消 `auto_approved` 永久记忆 → 步级一次性授权**

`Task.auto_approved`（"记住动作名 → 永远放行"）已移除，换成 `Task.grants: {action → step_id}`：授权**只对授予它的那一步**有效，换步 / 重跑 / 重启即作废。`/approve` 的 `remember` 参数保留兼容旧调用方，但**不再产生永久记忆**。旧数据里存量的 `auto_approved` 在 `Task.from_dict` 里**不恢复**——否则"点过一次永远放行"会借重启复活。

**③ 审批无应答者 → fail-closed 且有明确提示**

审批是"挂起等人"的操作，没人应答还无限挂着是最难排查的状态（看起来既像没轮到又像卡住了）。现在 `policy.has_responder()` 由 `api` 注册探测（有活跃 SSE 订阅，或最近 60s 内有过人工请求）；确认无人应答时不再进 `waiting_approval`，而是置 `failed` 并产出 `approval_unattended` 事件，message 里写明"需要审批…但当前没有应答者（无活跃界面连接），已按 fail-closed 拒绝执行"。前端两个任务页都新增该事件的分支，把原因显示出来（不静默失败）。

未注册探测时按**有人**处理：控制台/CLI/自动化没有界面连接，一律 fail-closed 会误伤；而"等人"是可恢复的、"放行"不是。

**验证**（全量冒烟 `ALL SMOKE TESTS PASSED`，新增 `test_approval_presets`）

- 档位联动：`sandbox.mode_for("full") == "danger-full-access"`、`("auto") == "workspace-write"`；`needs_approval` 在 manual/auto/full 三档下对 write_file 与 run_command 的判定全部符合表；未知档位回落 manual。
- `deny` 档位：`policy.denied("audit","computer_control") is True` 且 `needs_approval(...) is False`（deny 不是 ask）；内置档位不可覆盖/注销。
- 一次性授权：同一步内 `_needs_gate` 从 `True` 变 `False`；**换一步立刻回到 `True`**（不是永久放行）；旧 `auto_approved` 数据反序列化后 `grants == {}`。
- fail-closed：同一份替身模型，探测返回 `False` → `state=failed` + `approval_unattended` 事件 + **文件没落盘**；探测返回 `True` → 照旧 `waiting_approval` + `approval` 事件（既有行为不变）。
- 运行时：`/api/presets` 返回三档及各自沙箱档/ask/deny；真实任务 `task-fc19bab2` 在 manual 档触发审批 → `/approve?remember=true` 后 `grants={"run_command":"step-69fbac3a"}`（**步级，不是永久白名单**）→ 续跑 `state=done`，三步全 `done`。

**诚实边界**：三档的**规则内容**仍是内置写死的（自定义档位只能靠 `presets.register` 注入，尚无 UI 编辑入口）；应答者探测只看"活跃 SSE 订阅 + 60s 内人工请求"，不看用户是否真的在看屏幕。

### T-087 计划动态修订 —— ✅ 已完成（2026-10-02）

以前计划是"开局生成一次，之后一条道走到黑"：任何一步失败 → 整任务 `failed`。现在改为**失败即重规划**。

**机制**（`runner._replan_steps`，上限 `MAX_REPLANS = 2`）

1. 步骤失败（工具失败或模型请求失败）→ 带着**已做到哪 + 失败原因**让模型重规划**剩下**的步骤；
2. 新步骤追加到 `task.steps` 末尾，`while + 下标` 的循环接着跑；
3. 失败的那一步**留在历史里**（`status=failed`，前端看得见）——删掉它等于假装失败没发生过，用户就无从判断这次修订靠不靠谱；
4. 重规划**必须换一条路**：不把失败原因喂进去，模型多半会把失败那一步换个说法再写一遍 → 同样再失败一次 → 重规划退化成"换个措辞重试"，白花一次模型请求。所以模型若原样复述失败步骤，判定为"未产出可用步骤"并如实收尾；
5. 重规划有上限：每重规划一次就是一次模型请求 + 一轮执行，没有上限的话一个永远失败的任务能把额度烧穿还停在原地。

**失败分两种，必须区分**（新增 `Step.fatal`）：可重规划的（这个办法不行，换个办法）与**终止性**的（审批无人应答被 fail-closed——不是"换个办法"能解决的，重规划只会把它再规划一遍）。

**顺带修掉的一个真实缺陷**：`_run_agent_step` 内部的"挂起等人审批"只 `return` 了它自己的生成器，外层循环不加判断就继续跑后面的步骤——于是**人还没点审批，后续步骤已经执行完了**（真模型实测：任务最终 `done`，而待人审批的那一步永远停在 `waiting`）。现在挂起（`waiting`）与终止性失败（`fatal`）都会让整轮停下。

**验证**（全量冒烟 `ALL SMOKE TESTS PASSED`，新增 `test_dynamic_replan`）

- 注入一次工具失败（`read_file` 一个不存在的文件）→ `replan` 事件产出新步骤 → 任务 `state=done`；失败步骤仍在 `steps` 里（`failed`），重规划出的新步骤被真实执行（`done`）；工具失败**只注入一次**。
- 终止性失败（审批无人应答）→ `state=failed`、**不产出 `replan`**、后续步骤保持 `pending`。
- 审批挂起 → `state=waiting_approval`、后续步骤保持 `pending`（修复前会被一路执行到 `done`）。
- 真模型运行时：`task-bf69e1fd`（读取一个不存在的文件）→ `tool_call 11 / tool_result 7 / replan 2 / done 1`，`state=done`，失败步骤留在列表里；`task-a9b56ed0`（manual 档要写文件）→ 停 `waiting_approval` 且后续步骤 `pending` → `/approve` 后续跑 → `state=done`，四步全 `done`。

**诚实边界**：重规划的上限与"换一条路"的判定都依赖模型的输出质量——模型若坚持同一条路，两次重规划后任务仍会以 `failed` 收尾（这是如实收尾，不是硬凑 `done`）；重规划只改**剩余步骤**，不会回头撤销已执行的副作用（写过的文件不回滚——回滚由 T-092 的 checkpoint 负责（已落地：可把文件退回任意一轮之前））。

### T-088 全文检索 —— ✅ 已完成（2026-10-02）

新增 `evawork/search.py`：SQLite **FTS5 派生索引**，独立库 `~/.evawork/search.db`，可删可重建。

**三个关键决定（各自对应一个真实的坑）**

1. **派生索引，独立库**：索引只是主库（tasks/steps/messages/artifacts/events）的投影。同步水位也存在**索引库**里（不是主库 kv）——于是"删掉索引库"天然等于"下次 sync 全量重建"，不需要额外写自愈逻辑。
2. **trigram 分词**（SQLite ≥ 3.34，本机 3.49.1）：FTS5 默认的 unicode61 不认中文词边界，整段话会被当成一个 token，于是搜「历史任务」永远匹配不到「历史任务可按关键词召回」。trigram 做子串匹配，代价是**查询至少 3 个字符**——更短的查询降级为主库 LIKE，并**如实标注 `source=like`**（不让调用方以为自己拿到了索引结果）。
3. **不索引 token 帧**：流式正文被切成几百帧，逐帧入索引等于把同一段话存几百份（索引膨胀 + 一屏重复命中）。正文统一由 messages 表（T-081 落盘）负责；events 只索引 plan/replan/error/approval/tool_result 这几类"过程里有信息量"的帧。

**同步策略**：主库写入处挂钩（`store.save_task` / `append_event` / `delete_task`）→ 投影同步；索引写入失败**静默 warn 一次**，绝不冒泡——索引是投影，删了能重建，主库写入是真相，不能让一个可选功能把落盘搞挂。tasks/steps/messages/artifacts 全量重建（主库这几张表本来就是 delete+insert，没有增量水位可依），events 按 rev 水位增量。

**给模型的只读工具** `search_history`（action=llm，不触发审批）：query/kind/task_id/limit。两个刻意约束——**先 sync 再查**（否则刚落盘的正文搜不到，模型会得出"没有历史"的假阴性），**片段截断到 400 字符**（片段用于判断要不要细看，不是把整份历史塞回上下文）。另有 `GET /api/search`、`POST /api/search/reindex`、`GET /api/search/stats` 三个端点供界面调用。

**顺带修掉的真缺陷**：`steps.id` / `artifacts.id` 是**全局**主键，历史数据里挂着同 id 的陈旧行时，`save_task` 的整笔 INSERT 会撞 UNIQUE → **步骤 + 产物 + 对话正文一起静默丢掉**，只剩一行 warn（全量冒烟里能稳定复现）。现在插入前先按 id 兜底清一遍，落盘不再因为一条陈旧行整笔作废。

**验证**（全量冒烟 `ALL SMOKE TESTS PASSED`，新增 `test_full_text_search`）

- 中文关键词经 FTS5 召回，命中 message/step/event 三类；查无此词如实返回 0；token 帧确认未入索引；
- 短查询（2 字）降级为 LIKE 并带 `note`；
- 删掉索引库 → 索引空、主库任务数不变 → `rebuild()` 后依然能召回；
- 任务删除后不留幽灵命中；
- 工具 `search_history` 走 llm 动作（不触发审批）、缺参被确定性拦下。
- **真模型运行时**：`task-83d809e8` 自主挑了 `search_history` 并拿到 `ok=True`（10 条命中）→ 任务 `done`；`GET /api/search?q=备忘录` → `source=fts5 total=2`（task + message 命中，片段高亮）；`POST /api/search/reindex` → 重建 27 个任务 266 条文档，重建后仍能召回，主库任务数 27 → 27 不变。

**诚实边界**：trigram 要求 ≥3 字符，2 字以内的中文/英文走 LIKE 全表扫（任务量大时会慢，届时再引入分词或外部索引）；索引是**终一致**的——查询时才 sync，极端情况下刚写入的正文在索引里可能晚一拍（`search_history` 已内部先 sync，`/api/search` 同理）；UI 搜索入口尚未接入，归 T-089。

### T-091 模型降级与多模型路由 —— ✅ 已完成（2026-10-02）

此前一次 `FatalError`（401 / 模型不在白名单 / 额度用尽）就把整个任务置 `failed`——可这些失败**换一条路就能活**：令牌过期换一条有凭据的通道，模型不可用换一个模型。把"这条路由的终态"当成"这个任务的绝境"，是白扔一次本来能成的执行。

**路由链**（`routing.py`，首选在前，最多 `MAX_ROUTES=3` 条）：

    Route(默认通道, 指定模型) → Route(默认通道, 备用模型…) → Route(备用通道, …)

- **只降给真有凭据的通道**：`provider_ready` 不过就不排进去。降到一个同样没登录的通道等于白花一次请求，还把"我们在想办法"演给用户看——那是假动作。
- **备用模型只认显式配置**（`TRAWORK_FALLBACK_MODELS`，逗号分隔）：不同通道的模型名天差地别，不内置"猜一个能用的模型"，猜出来的名字只会多一次必败请求。
- **任务内粘性**：跑通的那条路由按 task.id 记住，后续请求先用它。不粘的话，一个"首选模型已坏"的任务会在**每一次**模型请求上都先撞一次坏模型（每次多一次必败请求 + 一段退避），步骤越多浪费越多。

**什么错值得降级**（`routing.degradeable`）：鉴权 / 限流 / 额度 / 模型不可用 / 服务端异常 → 换一条路；**请求体写错**（`kind=request`）→ 老实失败，换谁都一样，降级只会掩盖真正的 bug。

为此给错误补了判定依据：`agent` 与 `seams` 的 `RetryableError/FatalError` 现在自带 `status` 与 `kind`，且 **非 2xx 时会把响应体读出来再判 kind**——"模型不在白名单""额度用尽"在网关那边常常就是一个 400 加一句话，只看状态码会把它当成"请求写错了"，于是该降级的没降级。

**降级边界（刻意保留）**：
1. **只有还没对外吐过 token 才降级**：已经吐字再换路由重来会拼出重复正文，那种情况如实失败。
2. **降级不是从零开始**：沿用同一份 messages 与已完成的工作，事件里也写明这一点。
3. **全部路由都试完仍失败** → 抛 `FatalError`，错误里写明"已尝试路由：A（原因）→ B"，不让人以为只试了一条。
4. 每次降级都发 `degrade` 事件（`from` / `to` / 原因），前端与 `retry` 一样进提示区——降级不能是个黑箱。

**验证**（全量冒烟 `ALL SMOKE TESTS PASSED`，新增 `test_model_degradation`）

- 路由链：`big-model → small-model → openai` 排序正确、去重、截断到 3 条；没配备用模型也没备用通道时**只有首选一条**（不凭空造必败路由）。
- 降级判定：auth/rate_limit/model/quota/server 为真，`request` 为假；`agent.classify` 的 401→auth、429→rate_limit 带对了 `status/kind`。
- 换通道：默认通道 401 → 备用通道跑完（`tried=[('', 'auto'), ('openai', 'gpt-4o-mini')]`），且粘性路由生效（下次首选就是跑通的那条）。
- 换模型：`broken-model` → `fallback-model` 跑完，事件写明"模型不可用"。
- 不降级：请求写错 → 抛 `FatalError` 且**只试了首选**（没去撞备用通道）；已吐字后失败 → 不换路由。
- 全败：3 条路由都试过，错误里带"已尝试路由：…"。
- **真 HTTP 运行时**（stub 端点：除 `qwen-plus` 外一律 401）：坏模型任务 → `DEGRADE: 默认通道 · no-such-model-xyz → 默认通道 · qwen-plus`，原因"凭据无效或已过期"，任务照常 **done**、正文来自备用模型；对照任务（正常模型）0 次降级，没误伤。

**诚实边界**：备用模型/备用通道都得**显式配置**才有——没有任何配置时路由链就是一条，此时失败仍如实 `failed`（不假装"还有后手"）。上游 eva-ai 目前对未知模型会**静默回退**到 `qwen-plus`，因此"模型名写错"这条路在真实环境里通常走不到客户端降级（实测任务直接 done、无 degrade 事件）；客户端降级真正兜住的是 401/限流/额度/服务端异常这类上游**不会**替你兜的情况。

---

### T-092 checkpoint / 回滚 —— ✅ 已完成（2026-10-02）

新 `evawork/checkpoint.py`：一轮工具调用 = 一个回滚点，写盘**前**留快照，用户可把文件退回那一轮之前。

| 能力 | 实现 | 关键点 |
| --- | --- | --- |
| 快照采集 | `checkpoint.bind/commit` 包住 `tools.execute_batch`，写类工具落盘前 `capture` | 用 **ContextVar** 而非全局变量：T-090 起两个任务会同时跑，全局变量会把 A 的写入记到 B 的回滚点上 |
| 存储 | `checkpoints` + `checkpoint_files` 表，**进主库** | 快照是"能不能退回去"的凭据，删库就找不回来——它不是可重建的投影（对比 T-088 的检索索引放独立库） |
| 撤销 | `POST /api/tasks/{id}/checkpoints/{cid}/rollback`、`POST /api/tasks/{id}/undo` | 新建的文件删掉（回到"不存在"），改过的还原成原文；按 `sha_after` 判冲突 |
| 前端入口 | 任务流里新增「文件改动（N 轮）」区块，每轮一个「撤销这一轮」 | 事件帧 `checkpoint` 实时到达；打开历史任务时另拉一次权威列表（事件帧不带"是否已撤销"） |

**四个关键决定**

1. **同一文件同一轮只记第一次写入前的状态**。一轮里连写两次，撤销必须回到**轮次开始前**，而不是回到第一次写完的中间态——中间态是"谁都没见过的文件内容"，比不回滚更难解释。
2. **撤销前比对 `sha_after`**：文件在那一轮之后又被（人或别的任务）改过 → **拒绝撤销**，如实进 `skipped` 并说明原因。静默覆盖别人后来的改动远比"撤销没生效"糟糕。
3. **快照失败不阻断写入**，但回滚点里如实标 `snapshot_ok=0` + 原因（原文件超大 / 读不出来）；撤销时说"这个文件没留住回滚点"，而不是假装撤销成功。为"以后能撤销"让现在写不进去，是本末倒置。
4. **产物对账**：文件被撤销删掉后，挂在它上面的产物一起清（界面点开一个不存在的文件最尴尬）；被改写的产物保留——文件仍在，它记录的是任务产出正文。

**验证**（全量冒烟 `ALL SMOKE TESTS PASSED`，新增 `test_checkpoint_rollback`）

- 一轮改两个文件（一个已存在、一个新建）→ 落 1 个回滚点；撤销后前者还原原文、后者被删。
- 同一轮连写两次 → 撤销回到**文件不存在**（不是中间态）。
- 撤销最近一轮：只退这一轮，别的轮次文件不受影响；重复撤销被拦且说明"已经撤销过"。
- 冲突：撤销前先被人改过的文件 → 进 `skipped`，内容保持"人后来改的"，没被覆盖。
- 产物一致性：新建文件被撤销 → 任务上的对应产物一并清掉。
- 一轮没动任何文件 → **不落回滚点**（界面不该亮一个没有东西可撤的"撤销"）。
- HTTP 层实测：`GET /checkpoints` 结构正确、`/undo` 在无改动时返回 `ok=false` + 原因、未知回滚点与未知任务都 404。

**诚实边界**：只覆盖**文件类工具**（`write_file` / `str_replace_editor`）。`run_command` / terminal 造成的文件变化不在撤销范围内（要覆盖就得做文件系统级快照，成本与风险都不划算），界面上已明确写出这条限制。手工 `/api/tools/run` 直接调工具不产生回滚点——没有"轮"可退，硬造一个只会让人以为能撤销。

---

### T-090 subagent / 任务分派 + job 控制 + 并发会话 —— ✅ 已完成（2026-10-02）

三项一起落地：并发调度是底，job 与 subagent 是建在上面的两个能力。

| 能力 | 实现 | 关键点 |
| --- | --- | --- |
| **解除 exclusive 全局串行** | `tools.execute_batch(..., scope=task.id)` + `_exclusive_key` | 此前全进程**一把**独占锁：任何 exclusive 工具执行时，所有任务的独占调用都得排队，"两个任务同时跑"名存实亡。现在按**资源**分锁——同一会话内仍严格串行（原语义不变），不同会话互不阻塞；共享资源另行成锁（同一文件 `file:path` / 同一终端会话 `terminal:x` / 全局待办 `todo`） |
| **job 控制** | `jobs.py` + `sandbox.Proc/spawn` + 工具 `job_start/job_list/job_output/job_kill` + `GET /api/jobs`、`GET /api/jobs/{id}/output`、`POST /api/jobs/{id}/kill` | 输出落文件（受限令牌下管道不可靠且会卡死）→ 可**增量**读；杀进程杀**整棵树**（Windows Job Object / POSIX 进程组），不是只置标志位；起进程与 `run_command` 同一个闸门（read-only 拒绝、隔离不可用 fail-closed）；上限 8 个 + 超时 + 空闲回收 |
| **subagent / 任务分派** | `subagent.py` + 工具 `dispatch_subagent` | 独立上下文（不带主任务历史）、轮次上限（默认 3 / 上限 5）、可限定工具集；一次派活在**自己的事件循环**里跑 → 同批派多个是真并发；跑完只把摘要交回主任务 |

**两条刻意保留的限制（不是没做完）**：

1. **子代理不能绕过审批**：它跑在里面没有人能点"同意"。遇到当前档位需要审批的动作一律 **fail-closed 拒绝**并带回原因（让主任务自己来调，那时才有人应答）。否则"派个子代理"就是一条绕过人工审批的暗道。
2. **子代理不能再派子代理**：套娃会把轮次与 token 都乘一遍，且不可控——工具清单里直接不给它 `dispatch_subagent`。

**顺带修掉的真缺陷**

1. **中文命令输出全是乱码**：Windows 命令行程序（`ping`/`ipconfig`…）按**控制台代码页**（中文环境 GBK）输出，此前一律按 UTF-8 解码 → 拿到一串 U+FFFD，中文全成问号，模型读到的也是一堆乱码。新增 `sandbox.decode_output`：先 UTF-8，出现替换字符就退回系统 ANSI 代码页（谁解得出的替换字符少用谁）。`run_command`、`execute_argv`、后台任务输出全部受益。
2. **被 kill 的任务状态说谎**：`Proc.kill` 置 `killed` 后，等待线程醒来按退出码又把状态改成 `failed`/`error`（`Job` 上根本没有 `killed` 字段，直接 AttributeError → `error`）。加 `Job.killed` 标记，等待线程据此不再覆盖——"被人终止"和"自己失败"必须分得清。
3. **`job_kill` 对已结束任务报 `ok=False`**：目标状态（不再运行）其实已经达成，报失败会让模型反复重试，最后把整步判断成失败（实测任务因此 `failed`）。改为幂等成功 + 说清"状态 X、返回码 Y，无需终止"。
4. **子代理轨迹前端看不见**：事件帧只带 `output`，`subagent` 字段被丢掉。补进 `tool_result` 事件（与 diff 同理：只给人看，不进模型消息），前端工具面板展开时显示"N 轮 + 每次调用的成败与结果摘要"。

**验证**（全量冒烟 `ALL SMOKE TESTS PASSED`，新增 `test_jobs_and_subagent`）

- 并发：同一会话两次独占调用 0.50s（串行），两个会话同时发起 0.27s（并发）；`file:` / `terminal:` 资源锁键正确。
- job：起任务 → 增量读到标记输出 → `kill` 后状态 `killed`（等 1 秒再验，确认没被等待线程改回去）→ 重复 kill 幂等 → 超过 8 个如实拒绝 → read-only 档 `sandbox_blocked` 拒绝。
- subagent：两轮循环（要工具 → 拿结果 → 给结论），工具调用记录正确；`manual` 档下写操作被 fail-closed 拒绝并注明"子代理无权审批"；派活工具本身走 llm 动作可用。
- **真模型运行时**：两个任务同时跑 → 10.9s 双双 `done`（不是排队）；真任务自主 `job_start → job_output → job_kill`（中文输出正常、"已终止"、HTTP 端点列表/输出/终止已结束任务都如实）；真任务自主调用 `dispatch_subagent` 三次，子代理读文件并回摘要，轨迹透传到事件，`state=done`。

**诚实边界**：`job_start` 的动作仍是 `run_command`，所以 auto 档下**起后台任务仍需人工确认**（`ALWAYS_CONFIRM`）；`job_kill` 保持同一动作——能起就能停，不给"起不了就直接杀"的宽松路径。后台任务的输出文件落在工作区 `.evawork-sandbox/`（受限进程写不了系统临时目录），任务回收时才删。POSIX 上没有可用隔离后端 → `job_start` 被 fail-closed 拒绝（不降级裸跑）。子代理的摘要截断到 4000 字符（主任务的上下文才是稀缺资源）。

---

### T-089 前端产品化 —— ✅ 已完成（2026-10-02）

四项全部落地，各自解决一个"看得见"的缺口。

| 能力 | 实现 | 关键点 |
| --- | --- | --- |
| 真 PTY 终端 | `evawork/pty.py` + `WS /api/pty/{sid}` + `TerminalPanel.vue`（xterm.js + FitAddon） | Windows 走 ConPTY（pywinpty），POSIX 走 `pty.fork`；**档位不允许执行命令就拒绝建立会话**（终端不能是沙箱旁路）；cwd 锁在工作区；断开即终止进程、空闲 30 分钟回收 |
| 文件树 | `files.list_dir` + `GET /api/files/tree`（按层懒加载）+ `GET /api/files/roots` + `FileTree.vue` / `WorkspacePanel.vue` | 只列一层，展开才取；越界（`..`/链接）与"不是目录"在后端拦掉；可切「工作区 / 我的文件」两个根 |
| diff 审阅 | 写类工具结果带 `diff`（before/after）+ 事件帧透传 + `DiffView.vue` | **只进前端事件，不进模型消息**（模型已经知道它写了什么，再喂一遍原文只是烧上下文）；行级 unified diff，改动过大截断并说明 |
| Markdown / Mermaid / 代码高亮 | `MarkdownView.vue`（markdown-it + highlight.js + mermaid 懒加载） | `html:false`（模型输出可能夹带 HTML/脚本，渲染在 Electron 里等同本机权限，不开这个口子）；流式期间 120ms 节流重排；mermaid 只在正文真出现时才动态引入，语法错误保留源码 + 原因 |

**顺带修掉的真缺陷**

1. `TaskEvent` 类型缺 `replan` / `approval_unattended` 两项（T-086/T-087 加了事件处理却没补类型），`vue-tsc` 一直报错——类型不实等于"改代码靠猜"。
2. `tools._rel_of` 只按字面比工作目录：工作目录是 8.3 短名（`ADMINI~1`）而路径是解析后的长名时，`relative_to` 抛 ValueError → 展示与 diff 里的路径退化成绝对路径。现在两个候选根都试。
3. 前端「当前项目的文件」/「选择文件夹」两个占位按钮换成真入口（工作区面板）。

**验证**（全量冒烟 `ALL SMOKE TESTS PASSED`，新增 `test_frontend_payloads`）

- 文件树：按层返回 dir/file 分类；`../../etc` 越界被 `PermissionError` 拒绝。
- diff：`write_file` 给出 `new_file=True` + 空 before；`str_replace_editor` 给出 before/after 原文；**模型看到的 `output` 里不含原文**（确认没把上下文撑大）。
- PTY：起会话 → 写 `echo evawork-pty-ok` → 收回显（含 ANSI 色）→ `resize` 生效 → `stop` 后会话消失；只读档（`TRAWORK_SANDBOX_MODE=read-only`）启动终端被拒。
- 运行时：WebSocket 端到端跑通（ready(conpty) → echo 命中 → 断开后 `sessions=0`，进程已回收）；`GET /api/files/tree` 能列出真任务刚写的 `note.md`；真任务 `task-a7d3c5b7` 的 `tool_result` 带 `diff{path=note.md,new_file=true,after=第一行\n第二行}`。
- 前端 `vue-tsc` 零错误、`vite build` 通过；工作区面板改为按需加载（`defineAsyncComponent`），避免打开任务页就拖下 xterm。

**诚实边界**：终端**只读审阅**属性不适用——它是真的能执行命令的（受沙箱档位约束）；文件树与预览**只读**（改文件请让 agent 改或去「我的文件」）；diff 是**行级**的（够看改了哪几行，不做字符级高亮）；mermaid 图表在流式输出到一半时语法不合法，会显示"暂无法渲染 + 原因"，流结束后自动补渲；预览文件超过 512KB 后端截断。

---

## 5. 里程碑（建议排期）

| 里程碑 | 范围 | 出口标准 |
|---|---|---|
| **M0** 原型完成（已达成） | 无后端、纯 Mock、壳只开窗（原型阶段） | 18/18 路由渲染干净 |
| **M1** 工程基线（✅ 完成） | E0 + T-010 + T-050 | 后端链路已跑通；electron 二进制已下载、前端可构建；窗口/尺寸待实机验证 |
| **M2** 数据接入 | E1（T-011~T-015）+ T-040 持久化 | 插件/模板/自动化/文件/管理账户从展示变真实，重启不丢 |
| **M3** 智能体内核 | E2（T-020~T-024） | 输入真能跑、真出产物、受审批约束 |
| **M4** 工具与能力 | E3（T-030~T-035） | 插件/MCP/模板/绑定/文件可读写可调 |
| **M5** 体验与合规 + 验证 | E5 + E6 | 三态/暗色/i18n/a11y/更新 + e2e 守住 |
| **M6** Harness 能力复刻 | E7（T-070~T-080） | 模型驱动 tool-use 闭环真能跑；工具/Skills 可被 agent 真实调度；事件可回放 |
| **M7** 架构升级（对标 0.2.0） | E8 P0（T-081~T-083） | 重启不丢历史 ✅、非 danger 档有系统级隔离 ✅、长任务不撑爆上下文 ✅（三项均已达成） |
| **M9** 分析可信度 | E9（T-096~T-099） | 产物门禁拦得住未填模板 ✅；没凭据不再冒充成功 ✅；分析类任务自动上高档模型 ✅；计划会先读高密度入口、规模用 `count_files` 实测 ✅ |
| **M8** 架构升级收尾 | E8 P1~P3（T-088~T-094） | 工具 15 个且共用管线 ✅；sandbox/approval/llm/fs 可替换 ✅；审批 preset ✅；计划动态修订 ✅；全文检索 ✅；前端产品化 ✅（终端/文件树/diff/Markdown）；subagent + job 控制 + 并发会话 ✅；模型降级与多模型路由 ✅；**checkpoint / 回滚 ✅**（写盘前留快照，按轮撤销）；**传输与调度 ✅**（MCP 三传输 + cron 精确调度 + 并发去重）；可观测（T-094） |

## 6. 下一步建议（按"最容易被当成已实现"排序）

1. ✅ 标 ◻ 的控件诚实化（已实施）：全局 `[data-coming]` 禁用态（变灰 + `not-allowed` + `title` + `aria-disabled`）统一让"看起来可点但无动作"的控件显式禁用；少数有真实目标的接上动作（消息弹层"去设置/去体验"跳转、~~升级弹层套餐可选~~ 已于 2026-10-02 下线、首页建议卡点击填入输入框）。经核对，原标 ◻ 中多数为过时标注——自动化"手动新建"/MCP"手动添加"/用量"时间范围切换"实际已接真实表单或 `disabled` 禁用态；订阅·用量"升级·开票"已于 2026-10-02 随计费口径下线；Office 助理已用 T-034 的"去绑定/即将上线"诚实模式。视觉级确认需有显示环境复核。
2. ~~我的文件的搜索与类型筛选~~：**T-014 已落地**（搜索/类型筛选/网格列表双视图均接 `/api/files`，见任务表）。
3. ~~设计系统"创建副本"/自定义~~：**T-033 已完成**（副本/删除/新建均接后端写 css.json）。
4. 规则/命令/授权开关：要演示就落盘，或明确提示"刷新后失效"（T-040 解决）。
5. ~~主壳暗色与 i18n~~：**已完成**（T-051 令牌+三档切换、T-052 中/英切换均落地，见任务表）。
6. ~~T-000/T-003 工程基线、T-020/T-024 智能体内核与工具注册表、T-030/T-031 插件与 MCP、T-041 用量口径~~：**均已落地**（见任务表复核，文档此前严重低估，曾标 ✗/◻/⛔/🔄）。
7. **复刻 `deepseek-harness` 真实能力（E7）**：~~T-070 tool-use 循环~~、~~T-071 turn/step + 单请求重试~~、~~T-072 事件落盘与增量回放~~、~~T-074 统一工具管线（并行/独占）~~、~~T-073 协作式取消~~、~~T-076 Skills~~ **均已完成**（2026-09-26，见上方归档：模型真正决定工具调用、失败重试而非假恢复、事件即真相可回放、工具按模式并发调度、任务可停可续、技能可用 `/name` 唤起）。剩余按此顺序推进：**T-078 交付物记录**（P2）→ 其余 P3。**当前最大缺口：只有产物列表，没有每轮改动集，产物无法追溯到来源轮次**（T-078）。
8. **架构升级（E8，2026-10-02 新增，优先级高于其余 P3）**：对标已升级到 **0.2.0-rc.2** 的 `deepseek-harness` 后确认的三个硬伤——① **消息正文不落盘**（重启丢历史）② **沙箱只是路径前缀校验**，full 档 `shell=True` 裸跑 ③ **无 spill/压缩**，长任务必炸。三项对应 **T-081 / T-082 / T-083（P0）**。**T-081、T-082、T-083 三项 P0 均已于 2026-10-02 完成**（T-081 三重验证：离线冒烟 + 真模型端到端 + 杀进程重启后 messages 完整；T-082 全量冒烟通过，"写工作区外被系统拒绝 / 写工作区内放行"双向验证；T-083 全量冒烟通过，50 轮历史 80634 → 17335 tokens、100KB 输出溢出后原文可取回）。**三个硬伤已全部闭合**，M7 达成；**T-084 工具集扩容亦已于 2026-10-02 完成**（本地 15 个工具，全部走统一管线，真实任务端到端验证模型调用 glob/grep 并回填）；**T-085 能力 seam 抽象亦已于 2026-10-02 完成**（`seams.py`：sandbox / approval / llm / fs 四个边界做成"定义 + provider"两层，换沙箱后端/审批源/模型通道/文件系统均**不改** runner/tools，且有静态检查锁住）；**T-086 审批 preset 亦已于 2026-10-02 完成**（`presets.py`：档位 = 沙箱档 + 审批规则打包，一处判定；`auto_approved` 永久记忆取消 → 步级一次性授权；无人应答 fail-closed 并给出明确提示）；**T-087 计划动态修订亦已于 2026-10-02 完成**（单步失败 → 带失败原因重规划剩余步骤并继续到 done；顺带修掉"审批挂起被后续步骤绕过"的真实缺陷）；**T-088 全文检索亦已于 2026-10-02 完成**（`search.py`：FTS5 trigram 派生索引存独立库 `~/.evawork/search.db`，删掉可重建、主库不受影响；给模型的只读工具 `search_history` + `GET /api/search` 端点）；**T-089 前端产品化亦已于 2026-10-02 完成**（真 PTY 终端 `pty.py` + `TerminalPanel.vue`、工作区文件树 `FileTree.vue`、改动审阅 `DiffView.vue`、正文 Markdown/Mermaid/代码高亮 `MarkdownView.vue`）；**T-090 subagent / 任务分派 + job 控制亦已于 2026-10-02 完成**（`jobs.py` + `subagent.py`，工具从 16 增至 21；独占锁从"全局一把"降级为"按会话/资源分锁"，两个任务实测可同时跑）；**T-091 模型降级与多模型路由亦已于 2026-10-02 完成**（`routing.py`：一次请求失败按"同通道换模型 → 换通道"换路由继续，而非把任务判 failed；真 HTTP stub 实测 401 → 备用模型 → 任务照常 done）；**T-092 checkpoint / 回滚亦已于 2026-10-02 完成**（写类工具落盘前留快照进主库，可按轮撤销；撤销前比对 `sha_after`，被后来的改动覆盖过的文件如实报 conflict 不撤销；新建文件撤销后对应产物一并清掉）。**T-093 传输与调度升级亦已于 2026-10-02 完成**：① **MCP 三传输**——`mcp.py` 拆成 Session 基类 + `_StdioClient` / `_StreamableHttpClient` / `_SseClient`，**不引第三方 SDK**（`http.client` 自实现、SSE 手工解析），协议版本 2025-06-18 优先、不兼容回退 2024-11-05，注册时真握手列工具，连不上/缺字段一律拒收；② **cron 调度**——新增 `cron.py`（5 段解析、下一次触发、中文描述，**日与周同时限定取并集**，语法正确但永不触发的表达式当场拒绝），自动化 `cron` 优先于间隔分钟，循环"睡到下一个触发点"（不再是 30s 粗轮询）；③ **并发去重**——跑前先占格写盘（执行慢于周期不会层层叠加）+ 进程内执行锁（调度 tick 与手动触发并发只跑一次）。验证：Node 跨语言真 fixture（`scripts/fixtures/mcp-http.mjs`）覆盖 streamable 两种响应形态（SSE 流 / 单条 JSON）+ 旧版 HTTP+SSE 双通道 + 连不上/缺字段等负向路径，全量冒烟通过，API 层 TestClient 实跑相关路由。剩最后一项 **T-094（遥测与结构化日志）**。**不要做**：照搬 dsh 的 Cordis 全插件化改造——Python 生态无等价物，成本极高，只需在 T-085 的四个边界做 seam 抽象。
9. **分析可信度（E9，2026-10-02 新增并当日完成）**：起因是同题分析 `deepseek-harness` 时 EvaWork 交出**幻觉文档**（中文版把项目写成 `@electron/asar`）与**未填模板**（`DEPENDENCY_MAP.md`）。四项改造已全部落地：T-096 产物门禁（`qa.py`，落盘前拦占位/证据矛盾/空壳）、T-097 占位硬失败（没凭据就 failed，不再冒充成功）、T-098 模型分档（分析写作类上 `qwen-max`）、T-099 证据优先编排 + `count_files` 规模统计。**剩下没做的**：文档类任务仍可能因"读得太少"而写得浅——这属于模型能力与时间预算问题，不再堆规则。

---

## 附录 A：诚实控件清单（原"功能清单"逐项，保留溯源）

状态：**✅ 已实现(Mock)** · **◻ 静态** · **✗ 未实现**

> **2026-09-25 更新（◻ 诚实化）**：◻ 静态控件现统一以全局 `[data-coming]` 显式禁用态呈现——变灰 + `not-allowed` + 悬浮提示，不再与可点控件混淆；少数已接真实动作（消息跳转 / ~~升级套餐可选~~ / 首页建议卡填输入框）。原清单中"手动新建/MCP 手动添加/时间范围切换"等为过时标注（实为真实表单或 `disabled` 禁用态）；"升级·开票"已于 2026-10-02 下线，详见上方「◻ 静态控件诚实化」小节。

### 主壳
| 模块 | 项 | 状态 | 说明 |
|---|---|---|---|
| 侧栏 | 品牌区（原 Work/Code/Design 模式切换，T-142 已移除） | ✅ | 纯品牌展示，无交互 |
| 侧栏 | 7 导航与高亮 | ✅ | |
| 侧栏 | 任务列表 | ✅ | 初始 2 条；新建置顶；点击回首页（T-020 补详情） |
| 侧栏 | 我的菜单展开/收起 | ✅ | |
| 首页 | 输入框回车/发送 | ✅ | 空输入禁用 |
| 首页 | 审批模式三档 | ✅ | 手动/自动/完全访问（T-023 变真） |
| 首页 | 模型选择（6 内置） | ✅ | "添加模型" ◻ |
| 首页 | `+` 菜单 8 项 | ◻ | 只展开，无二级面板/动作 |
| 首页 | 语音按钮 | ◻ | |
| 首页 | 快捷 chips、推荐卡 | ◻ | 展示态 |
| 插件市场 | 分类（插件11/技能6） | ✅ | |
| 插件市场 | 关键词搜索 | ✅ | 仅插件 Tab |
| 插件市场 | 能力专题卡 3 张 | ◻ | |
| 插件市场 | "管理"、技能"上传技能" | ◻ | |
| 模板库 | 精选/收藏 Tab | ✅ | |
| 模板库 | 分类10+搜索+收藏 | ✅ | 空结果有空态 |
| 模板库 | 卡片进详情 + 应用生成 | ✅ | 详情弹层 + "应用模板"建真实任务流式执行（T-032） |
| 设计系统 | 列表 8 套+自定义空态 | ✅ | 后端真实色板（T-010） |
| 设计系统 | 详情四 Tab | ✅ | 图形 Tab 支持搜索 |
| 设计系统 | "创建副本" | ✅ | 接 `duplicateDesignSystem`（T-033） |
| 设计系统 | 添加自定义 | ✅ | 接 `createDesignSystem`（T-033） |
| 自动化 | 已配置列表+开关 | ✅ | 仅内存（T-013 落盘） |
| 自动化 | 执行历史空态、任务模板 8 张 | ✅ | 展示 |
| 自动化 | 手动新建/对话中创建 | ◻ | |
| 自动化 | 顶部提示条 | ◻ | |
| 办公助理 | Hero+4 通讯工具 | ✅ | 企业微信/钉钉"即将上线" |
| 办公助理 | "去绑定" | ✅ | 接 `bindIntegration`，未接入时 501 诚实提示（T-034） |
| 我的文件 | 本地/云端/飞书 Tab、类型胶囊、视图图标 | ✅ | 仅切换界面状态 |
| 我的文件 | 搜索框 | ✅ | 防抖后拼 `q` 调 `/api/files`（T-014） |
| 我的文件 | "去创建" | ◻ | |

### 浮层
| 项 | 状态 | 说明 |
|---|---|---|
| 消息弹层（3 条） | ✅ 开/关 | 每条"去设置/体验/详情" ◻ |
| ~~升级权益浮层（4 档套餐/连续包月/二维码/协议）~~ | ⛔ **已下线** | 2026-10-02：面向企业内部员工，不计费、无权益档位；组件 `UpgradeModal.vue`、mock `plans`、`ui.upgradeOpen` 全部删除 |
| 设置：17 节左栏切换 | ✅ | |
| 设置：各节内容 | ◻ | 按稿铺满，不持久化（T-040） |
| 我的菜单：语言(3)/主题(3) | ✅ | 真切 i18n / `data-theme`（T-052/T-051） |
| 我的菜单：管理账户跳转 | ✅ | 跳 `#/admin/account`、`#/admin/usage` 等 |
| ~~我的菜单：每日签到 / 升级权益按钮~~ | ⛔ **已下线** | 2026-10-02：积分与权益不存在，不再摆禁用按钮 |
| 我的菜单：报告问题、退出登录 | 🟡 | 退出登录✅（清本地会话）；报告问题◻ 无动作 |

### 管理账户（深色控制台）
| 页面 | 状态 | 可交互项 |
|---|---|---|
| 用量管理 | ✅ 展示 | 时间范围切换 ✅（1/7/30 天分段）、趋势与明细来自 `/api/usage` 真实统计；~~升级 ◻、兑换 ◻~~ ⛔ 已下线 |
| 账号设置 | ✅ 展示 | 5 项操作 ◻、隐私模式开关 ◻ |
| ~~订阅管理~~ | ⛔ **已下线** | 2026-10-02：内部使用不计费，`SubscriptionPage.vue` / 路由 / 导航项 / `/api/subscription` 一并删除 |
| 仪表盘 | ✅ 展示 | 全部展示（热力图确定性种子） |
| 收藏盒 | ✅ 空态 | — |
| 规则 | ✅ 编辑 | 输入/取消可用，保存 ◻（T-040） |
| 命令 | ✅ 增删改 | 仅内存（T-040 落盘） |
| 外部应用授权 | ✅ 开关 | 6 应用可切换，仅内存（T-040） |
| 云端运行环境 | ✅ 展示 | 新建环境 ◻ |
| MCP | ✅ 搜索 | 6 Server 可搜；手动添加 ◻ |
| 顶栏"下载 TraeCode" | ◻ | |

### 工程能力（已随栈迁移更新）
| 项 | 状态 | 说明 |
|---|---|---|
| Electron 窗口壳 | 🟡 | 1280×820，最小 960×640（`src/main.js`） |
| 打包 NSIS + 免安装版 | ✅ | `pnpm dist` 出安装包/免安装 exe，壳+UI+后端随 resources 分发（T-004） |
| 类型检查 / 构建 | ✅ | `pnpm typecheck`、`pnpm build` |
| 路由渲染冒烟 / 浏览器 e2e（Playwright） | ✅ | 18/18 路由渲染无未捕获异常（`scripts/e2e-ui.mjs`，T-060） |
| 性能基线（Playwright） | ✅ | 冷加载 Load 203/FCP 224/LCP 272ms，18 路由挂载中位 4–33ms（`scripts/perf-baseline.mjs`，T-061） |
| Python 后端 | 🟡 | FastAPI 脚手架就位，离线可跑 |
| 全局快捷键 | ✅ | Cmd/Ctrl+Shift+N 新建任务；Cmd/Ctrl+1·2·3 切换模式（T-055） |
| 持久化 | ✗→可行 | Electron+Python 阶段可借 SQLite 落盘（T-040） |
| 自动更新 / 崩溃上报 / 日志 | 🟡 | electron-updater 接入+菜单检查更新；崩溃落盘/上报(实测 202+落盘)+主进程日志；真更新需发布 release（T-054） |
| 无障碍与对比度走查 | ✅ | 焦点环/sr-only/button 菜单已做；`@axe-core/playwright` 自动走查 18 路由=**0 违规**（T-053） |
| 国际化 | ✅ | 中/英切换落地（T-052） |
| 暗色主题（主壳） | ✅ | 亮/暗/随系统三档（T-051） |
