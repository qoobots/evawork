# EvaWork 插件市场 · 产品需求文档（PRD 任务清单）

> 本仓库是 **EvaWork Desktop**：桌面 AI 工作台的客户端（Electron + Vue 3 + Python 智能体后端）。
> 本文档与 `01_PRD`、`04_技术架构文档`、`05_PRD任务清单`、`智能体升级方案`（无序号，内核反幻觉基座）配套；
> 功能实现任务以本文第 5 节的优先级清单为准。

| 项 | 值 |
|---|---|
| 文档名 | 08_EvaWork 插件市场 PRD 任务清单 |
| 版本 | 0.3.0（前沿架构视角重写） |
| 日期 | 2026-10-05 |
| 视角 | 智能体架构专家：以 2026 最前沿 agent 架构为参照，把插件市场定位为"桌面智能体的能力进化引擎" |
| 相关文档 | `01_EvaWork Desktop 产品需求文档PRD` · `04_EvaWork Desktop 技术架构文档` · `智能体升级方案`（无序号） |

## 修订历史

| 版本 | 日期 | 说明 |
|---|---|---|
| 0.1.0 | 2026-10-05 | 首版：现状代码核实 + 优先级任务清单 |
| 0.2.0 | 2026-10-05 | 加状态标记（✅ 基座 / ❌ 未做 / ♋ 进行中）；简化已完成、细化 M1 |
| 0.3.0 | 2026-10-05 | 前沿架构视角重写：插件市场定位为"能力进化引擎"；新增 context provider / 能力推荐 / sub-agent 编排 / 评测引爆室 / capability security / 多模态工具 / tracing / 灰度兼容等任务 |
| 0.3.1 | 2026-10-05 | **T3 能力声明与安装时展示落地（✅）**：`plugins.py:install` 写 `row.capabilities`、前端安装弹层人话展示 + 未声明/本地命令警示；其余任务 ❌ |
| 0.3.2 | 2026-10-05 | **T7 管理面板落地（✅）**：占位按钮改真实面板，已装列表/启停/卸载/权限与工具查看；其余任务 ❌ |
| 0.3.3 | 2026-10-05 | **T4 MCP 子进程纳入沙箱（✅）**：`sandbox.spawn_stdio` 以受限令牌启动 MCP 子进程 + fail-closed；其余任务 ❌ |
| 0.3.4 | 2026-10-05 | **T1 目录服务端化 + T2 版本管理（✅）**：可配置远端源+缓存+离线回退；version 字段 + update-check/update + 前端可更新徽标；M1「可信的最小市场」完成 |
| 0.3.5 | 2026-10-05 | **T5 发布者信任分级（✅）**：目录 `publisher`/`verified` + 三档徽章 + 社区风险警示；M2 推进中 |
| 0.3.6 | 2026-10-05 | **T8 上传技能（✅）**：`.skill.zip` 导入 + 防路径遍历 + 脚本走沙箱；占位按钮已真接入；M2 推进中 |
| 0.3.7 | 2026-10-05 | **T6 自动安全扫描（✅）**：`security.py` 静态特征扫描（danger 拦截）+ npm audit（离线降级）+ 前端风险等级展示 |
| 0.3.8 | 2026-10-05 | **T19 Capability Security（✅）**：能力票据 + 出口 allowlist（Python 子进程 socket 级拦截）+ Job Object CPU/内存配额；**M2「安全边界闭环」完整达成** |
| 0.3.9 | 2026-10-05 | **T16 能力智能推荐引擎（✅）**：`recommend.py` 确定性任务画像匹配 + `/api/market/recommend` + 前端「能力推荐」tab；**M3「能力进化引擎」开工** |
| 0.4.0 | 2026-10-05 | **M3 推进**：T16 ✅；剩 T15（Context Provider）/ T17（Sub-agent）/ T18（评测引爆室）/ T20（插件即升级单元）待排期 |
| 0.4.1 | 2026-10-05 | **T15 Context Provider（✅）**：`context_providers.py`（gather/assemble）+ 技能 `provides_context` front-matter + 目录声明 + 后端两端点 + 前端「可注入上下文」区块；与内核账本 `context.py` 严格区分 |
| 0.4.2 | 2026-10-05 | **T20 插件即升级单元（✅）**：升级前留档 + 一键回滚（插件/技能）+ 安装期 `agent_protocol` 版本兼容校验（不兼容拒绝）；发现并修复回滚备份目录被误扫为技能的 bug |
| 0.4.3 | 2026-10-05 | **T18 评测引爆室（✅）**：`security.evaluate`（静态扫描 + 出口策略行为验证，确定性/离线）+ 导入即评测 + 两端点 + 管理面板「行为评测」；修复技能导入发现的缓存竞态 |
| 0.4.4 | 2026-10-05 | **T9 评分/下载量/排序（✅）**：`market_stats.py` 本机安装量 + 评分/评论 + 信任级>评分>安装量排序 + 前端排序下拉与星级打分 |
| 0.4.5 | 2026-10-05 | **T10 遥测最小集（✅）**：`telemetry.py`（默认关/匿名/隐私白名单/环形上限）+ install/uninstall/toggle 埋点 + 两端点 + 管理面板开关；**P1「信任与体验」完整达成** |
| 0.4.6 | 2026-10-05 | **T22 端到端 Tracing（✅）**：`tracing.py` + `tools.execute_tool` 统一打点（插件归属/成功率/延迟/崩溃归因）+ 两端点 + 管理面板「调用追踪」；进入 P3 |
| 0.4.7 | 2026-10-05 | **T23 灰度发布与版本兼容矩阵（✅）**：`compat_status`/`compat_matrix` 三态（可更新/待灰度/需升级 agent）+ 稳定哈希分桶灰度（0/25/50/100）+ 两端点 + 管理面板徽章与灰度下拉 |
| 0.4.8 | 2026-10-05 | **T11 插件开发 SDK 与脚手架（✅）**：`scaffold.py` 离线生成零依赖可跑插件工程（清单 + MCP 骨架 + README + sub-agent 模板）+ `/api/dev/scaffold` + 插件页脚手架区块；生成物真机 initialize/tools-call 通过 |
| 0.4.9 | 2026-10-05 | **T12 技能市场上架（✅）**：`publish.py` 上架必过扫描+评测（danger 拒上架）、zip slip 阻断、版本化、一键装入用户级技能目录、下架/再上架、导出清单；并入 `/api/skills`；修复 front-matter 内联列表解析缺陷 |
| 0.4.10 | 2026-10-05 | **T13 远程 MCP 接入（✅）**：传输层已具备，本期补市场侧远程接入（`install_remote` + url/transport + 数据出境审批与票据）；以本地 HTTP MCP 夹具离线验证握手/列工具/真调工具 |
| 0.4.11 | 2026-10-05 | **T14 安全评测回归流水线（✅）**：`evals.py` 12 条确定性离线边界用例 + 目录声明合规审计 + 历史/回归对比 + 两端点 + 管理面板「重跑评测」；12/12 通过；审计暴露目录声明缺口并已补齐官方项 |
| 0.4.12 | 2026-10-05 | **T21 多模态能力接入（✅）**：`multimodal.py` ability 发现/就绪门禁/审批 + 目录项 `abilities` 标注 + 4 端点 + 卡片与安装弹层就绪度；如实报"无生成类模型"，不伪造出图 |
| 0.4.13 | 2026-10-05 | **P3 收官 + 技术债 D2/D3（✅）**：P3（T22/T23/T11/T12/T13/T14/T21）全部完成；D2 前端过滤/排序/离线回退抽单一 `utils/market.ts` + Node 内置测试 11/11；D3 安装记录 KV 加 `schema` 版本与就地迁移 |
| 0.4.14 | 2026-10-05 | **D1 目录单一数据源（✅）**：反转数据流为 `catalog.json` → 前端 mock（`gen-catalog.mjs --check` 漂移守卫），消除"重跑生成器抹掉安全元数据"的隐患；顺带修 `PluginMarketView` 括号/重复函数/漏 import 等 vue-tsc 暴露的存量问题 |
| 0.4.15 | 2026-10-05 | **T17 Sub-agent 编排（✅，任务清单全量收官）**：`orchestrator.py` 发现/委派/schema 校验/工具名解析 + 脚手架产出 `subagent.json` + 两端点 + Sub-agent tab；14 条安全评测全通过；PRD 25 个任务全部达成 |

## 状态图例

| 标记 | 含义 |
|---|---|
| ✅ | 已完成（代码已落地，经核实） |
| ❌ | 未完成（代码未落地，仅规划） |
| ♋ | 进行中（已开工 / 本迭代正在实现） |

> **诚实说明（2026-10-05 重大修正）**：此前 25 个任务虽全部标记 ✅，但**市场目录里的 35 个条目全是"名片"——没有任何可安装来源**，点安装只能弹空框让人自己猜包名。实测发现并修复了**三个此前从未被触发的真 bug**，现市场已换成 9 个**经 npm registry 核验（存在且未废弃）**的真实 MCP 包，且**已真机跑通"安装 → 出工具 → 真调用"**。详见下方「真实插件修复」。

### 真实插件修复（T-142，发现于 2026-10-05）

自检发现"这些插件是不是只是摆设"的答案为**是**，根因是三个独立缺陷（都与安全边界无关）：

1. **`looks_local()` 把 scoped npm 包误判为本地命令**：旧逻辑只判 `"/" in s`，而 `@scope/name` 天然含 `/` → 所有官方 scoped MCP 包（`@modelcontextprotocol/server-*` 等）**从未触发过 `npm install`**，而是把包名当命令丢给 `cmd` 执行。修复：新增 `_SCOPED_NPM_RE` 优先识别。
2. **Windows 上 `npm` 不可执行**：`npm` 是 `npm.cmd` 垫片，`subprocess.run(shell=False)` 无法执行 → `FileNotFoundError`。修复：`_npm_exec()` 用 `shutil.which` 解析真实文件名。**这条路径此前从未被真正跑通过。**
3. **stderr 混入 stdout 污染 JSON-RPC**：真实 MCP server 启动时必往 stderr 打日志（如 `Starting default (STDIO) server...`），与 stdout 合流后协议帧被破坏 → `initialize` 永远等不到合法响应。修复：stderr 独立成管并单独抽干（顺带修掉"失败只说'服务未响应'不给原因"的问题）。**自写的最小 server 不写 stderr，所以此前一直没暴露。**

> 注：曾怀疑是 Low 完整性令牌过严，实测**证伪**——真实包在默认 `low` 下即可正常运行。故**未放宽默认安全边界**；`integrity=medium` 仅在用户显式点"信任来源"时启用。

**当前状态（真机验证）**：`Filesystem`（14 工具）、`Sequential Thinking`（1 工具）、`Everything`（13 工具，含 `get-sum(7,5)→12` 实调用）均可经产品安装链路装上并调用。目录中所有条目均带 `spec`，无 `spec` 的条目标「暂无安装源」并禁用安装按钮——**不摆空框骗人**。

---

## 1. 前沿架构分析与 EvaWork 定位

### 1.1 2026 最强桌面智能体的能力底座（参照系）

| 维度 | 前沿实践 | 代表 |
|---|---|---|
| 上下文工程（Context Engineering） | 上下文是**动态装配**而非堆长 prompt；agent 按需拉取相关上下文 | Anthropic "Context Engineering" 取代 prompt engineering；检索/投影/压缩分层 |
| 工具接入标准 | MCP 成为工具/资源/提示词的标准协议 | Anthropic MCP；各家客户端市场 |
| 能力组合单元 | 插件（工具）+ 技能（prompt+工具）+ sub-agent（可委派的专业 agent）三层 | Agent Skills、OpenAI Agents SDK、A2A |
| 多 agent 编排 | 主 agent 委派子任务给专业 sub-agent，结果聚合 | AutoGen / LangGraph / CrewAI / A2A |
| 市场即能力进化引擎 | 智能体通过 marketplace 持续装配新能力，而非内置全部 | 各 agent 客户端市场 |
| 不可信代码执行 | capability-based security + 隔离沙箱 + **引爆室（detonation chamber）**行为评测 | Chrome Web Store 扫描、企业 EDR 沙箱引爆 |
| 质量内建（evals） | 每个能力带 benchmark，用户看"同类任务成功率" | LLM-as-judge、轨迹评测 |
| 可观测 | 每次工具/agent 调用有 trace、token/cost、延迟、成功率 | OpenTelemetry for Agents |
| 自进化 | 技能/插件作为 agent 能力的灰度演进通道，支持 A/B 与回滚 | self-improving agents |

### 1.2 EvaWork 现状 SWOT（基于代码核实）

- **优势（S）**：① 本地执行 + 三档沙箱 + 解耦审批，桌面侧天然比云端 agent 多一道"数据不出本机"；② **内核反幻觉基座已成型**（三层账本 + 对账闸门，全部 ✅），这是多数 agent 市场缺的"质检层"；③ MCP 接入与本地技能体系已可用。
- **劣势（W）**：① 市场是本地静态 JSON，无服务端、无版本、无信任；② MCP 子进程**不受沙箱约束**（最危险缺口）；③ 无 context provider、无能力推荐、无 sub-agent 编排、无 eval、无 tracing。
- **机会（O）**：把"市场"做成**能力进化引擎**，并与既有账本质检联动——别人市场只管"装工具"，EvaWork 可以让"装上的技能/插件仍受对账闸门约束"，形成差异化信任。
- **威胁（T）**：云端 agent 市场（模型厂自带）先发；纯工具市场同质化，必须靠"本地+质检+上下文"三件套突围。

### 1.3 插件市场的战略角色（本 PRD 的论点）

插件市场**不是"装工具的地方"，而是桌面智能体的能力进化引擎**：
- 用户不手动挑工具——**能力推荐引擎**按任务画像自动装配插件/技能（类比模型自动选择 T-140/141，但作用在工具层）；
- 装上来的能力仍要过**对账闸门**（不破坏 `智能体升级方案` 的质检）， marketplace 与内核质量基座必须协同；
- 插件/技能是 agent 的**灰度演进单元**：能力可 A/B、可回滚、可评测，使"最强智能体"是"持续装配出来的"，不是"一次性写死的"。

---

## 2. 背景与目标

### 2.1 能力基线（已就绪 ✅，简化列）

| 能力 | 落点 | 说明 |
|---|---|---|
| 插件安装/卸载/启停 | `plugins.py`（T-030） | npm/本地命令 → MCP stdio → 工具并入注册表；KV `plugins:installed` |
| 本地技能体系 | `skills.py`（T-076） | SKILL.md 发现/缓存、`/name` 唤起、提示词注入、allowed_tools 收窄、scripts 走沙箱 |
| MCP 接入 | `mcp.py` | stdio、能力协商、工具 `mcp:<server>:<tool>` 并入注册表 |
| 三档沙箱 + 审批 | `sandbox.py`（T-082） | read-only / workspace-write / danger-full-access；安装高危需确认 |
| 内核反幻觉基座 | `智能体升级方案`（✅） | 三层账本 + 对账闸门；工具调用均结构化上报 |
| 离线兜底 | `PluginMarketView.vue` | 无后端回退 mock，不白屏 |
| 状态双向合并 | `api.py` | 目录项与本地 `installed/enabled/loaded/local` 合并 |

### 2.2 产品目标

1. **让市场成为市场**：可上架、可安装、可更新、可卸载、可评价；目录可远程更新。
2. **让市场成为能力进化引擎**：能力推荐 + sub-agent 编排 + 灰度演进，使 agent 持续变强。
3. **安全边界可解释 + 可证明**：装前看得懂、装后受得住、上架有行为证据。

### 2.3 非目标（本期不做）

- 自建 MCP 托管平台（复用 stdio，SSE/HTTP 后置）。
- 插件内付费/结算（面向企业内部，无商业化口径）。
- 跨平台（移动端）市场。

---

## 3. 用户与场景

| 角色 | 诉求 | 界面/流程 |
|---|---|---|
| 通用用户 | 一句话交代任务，能力自动配好 | 新建任务（推荐引擎装配插件/技能） |
| 谨慎型用户 | 装前知道能干嘛、危不危险 | 安装弹层：能力声明 + 信任级 + 行为证据 |
| 开发者 | 写 MCP server / SKILL.md / sub-agent 并发布 | SDK 脚手架 + 上传 + 上架审核 |
| 管理员（企业） | 集中看装了哪些、版本、谁装了危险能力 | 「管理」面板 + 遥测汇总 |
| 已装用户 | 收更新、一键升级、卸干净 | 已装管理 + 卸载清理 |

---

## 4. 核心概念与术语

| 术语 | 含义（本产品内） |
|---|---|
| 插件（Plugin） | 暴露工具的扩展，运行时是 MCP stdio 子进程 |
| 技能（Skill） | `SKILL.md`（front-matter + 正文 + scripts），运行时注入提示词；`/name` 唤起 |
| Sub-agent | 可委派的专业 agent 单元：自带系统提示 + 工具集 + 边界，主 agent 委派子任务 |
| Context Provider | 插件/技能向 agent 提供**按需上下文**（如"当前打开文件""项目依赖图"），是 context engineering 的落地 |
| 能力推荐引擎 | 按任务画像自动推荐/装配插件与技能（类比模型自动选择，作用在工具层） |
| 能力声明（Capabilities） | `network` / `fs-write` / `command` / `context`；未声明按 network 处理 |
| 信任级（Trust Tier） | 官方 > 已验证发布者 > 社区 |
| 引爆室（Detonation Chamber） | 上架前在隔离环境跑行为评测，自动生成"行为证据" |
| 目录（Catalog） / 安装记录（InstalledRecord） | 同前版 |

---

## 5. 功能需求与任务清单

优先级：P0 市场成立；P1 信任与体验；P2 能力进化引擎（前沿核心）；P3 生态放大器。

### 5.1 P0 —— 让市场成为市场

- ✅ **T1. 目录服务端化**（落点：`catalog.load` 支持可配置 `EVAWORK_CATALOG_URL` 远端 + 本地缓存 + 离线回退静态 JSON，**不自建服务端**）。AC：远端（file:///HTTP）拉取成功并写缓存；远端不可达时回退本地缓存/静态且不崩（真机验证）。注：废弃 `gen-catalog.mjs` 双源（D1）留待收口。
- ✅ **T2. 版本管理与一键更新**（落点：目录项 `version` + `install` 写入版本 + 后端 `update-check`/`update` 端点 + 前端卡片「可更新」徽标与更新按钮）。AC：安装写入版本；`update-check` 比对目录与已装版本；`update` 重装升级且保留 enabled（真机验证）。
- ✅ **T3. 插件能力声明与安装时展示**（落点：`plugins.py:install` 写 `row.capabilities`；`catalog.json` 插件项补 `capabilities`；前端 `PluginMarketView.vue` 安装弹层人话展示 + 未声明/本地命令警示）。AC：目录项声明优先（如 `GitHub→["network"]`）；未声明+本地命令回退完整权限 `['command','network','fs_write']`（两条分支均已真机验证）。
- ✅ **T4. MCP 子进程纳入沙箱**（落点：`sandbox.spawn_stdio` 受限令牌启动 + `mcp._StdioClient.start` 接入 + `plugins.install` 给插件目录打 Low 完整性标签）。AC：MCP 子进程**不再以完整用户权限裸跑**，默认以 Low 完整性令牌启动并正常握手（真机验证通过）；令牌不可用 → fail-closed 拒绝裸跑；沙箱关闭时兼容裸跑。细粒度能力限制（网络/文件 egress）留 T19。

### 5.2 P1 —— 信任与体验

- ✅ **T5. 发布者与信任分级**（落点：目录项 `publisher`/`verified` + `install` 写入 `publisher` + 卡片/安装弹层/管理面板三级徽章与社区风险警示）。AC：官方/已验证/社区三档徽章；社区插件安装弹层显式风险警示；管理面板回显来源（真机验证）。
- ✅ **T6. 自动安全扫描流水线**（落点：新建 `security.py` + 导入/安装时自动触发）。AC：技能 `.skill.zip` 导入做静态特征扫描（`eval/exec/os.system/subprocess/pickle/ctypes/rmtree` 等 → danger 级拦截并清理；`requests/urllib/socket/os.environ/密钥字面量/敏感路径` → warn）；npm 插件安装跑 `npm audit`（离线/无 npm 降级为 unknown，不阻断离线安装）；扫描结果写入记录并前端展示风险等级（技能上传提示 + 插件安装弹层 + 卡片/管理面板徽章）。真机验证通过。
- ✅ **T7. 「管理」落地**（落点：`PluginMarketView.vue` 管理 modal + `api/plugins.ts` 补 `capabilities` 字段；复用 `/api/plugins/installed`、`toggle`、`DELETE`、`tools`）。AC：已装列表 / 启停 / 卸载 / 权限与工具查看全部可用，无需命令行（更新入口待 T2）。
- ✅ **T8. 「上传技能」落地**（落点：`skills.import_skill_zip` 防路径遍历解压到用户级目录 + 后端 `/api/skills/import` + 前端「上传技能」按钮真接入）。AC：`.skill.zip`（`<name>/SKILL.md` + scripts）导入后可用 `/name` 唤起；zip 路径遍历被拦截；脚本继承既有沙箱（T-082）；真机验证通过。
- ✅ **T9. 评分、下载量与排序**（落点：新建 `market_stats.py`（安装量/评分 KV + `sort_items`）+ `_with_install_state` 合并 `downloads/rating/my_rating` + `/api/plugins`、`/api/skills` 支持 `sort=trust|rating|downloads` + `POST /api/market/rate` + 前端排序下拉 + 卡片星级打分/安装量）。AC：安装成功自动 +1 安装量（本机真实计数）；可打 1-5 星 + 评论（本机 KV 持久化）；默认排序=信任级>评分>安装量，可切纯评分/纯安装量（真机验证）。诚实边界：桌面端无中心服务端，安装量为**本机**统计、评分为**本机用户**评分（非全网聚合）。
- ✅ **T10. 遥测最小集（可关）**（落点：新建 `telemetry.py`（默认关 + 匿名 id + 环形日志上限 + 隐私白名单）+ 埋点 `plugins.install/uninstall/set_enabled` + `/api/telemetry`、`/api/telemetry/toggle` + 管理面板「匿名遥测」开关与本机计数）。AC：**默认关闭**；开启后仅记录 install/uninstall/toggle/crash 的次数（事件字段仅 event/plugin/ts，无内容/凭据/路径）；非法事件与空名被拒；关闭即清空（真机验证）。诚实边界：桌面端不上传服务器，"上报"= 本机聚合并可一键关/清。

### 5.3 P2 —— 能力进化引擎（前沿核心）

- ✅ **T15. 上下文提供者（Context Provider）**（落点：新建 `context_providers.py` + 技能 front-matter `provides_context` 解析 + 目录项声明 + 后端 `/api/context/providers`、`/api/context/assemble` + 前端推荐 tab「可注入上下文」区块）。声明式 `provides_context`（current_file / project_deps / git_log …）+ 按任务相关性发现 + `assemble()` 产出可注入规划的上下文说明。AC：装/github 等 provider 后，相关任务（"提交代码并查看 git 改动"）规划可取到 Git 提交历史/改动 diff 等上下文（真机验证）；agent 规划层调用 `assemble()` 即装配（集成点已就位）；provider 越界读文件仍受沙箱约束（既有 T-082）。注：与内核账本 `context.py`（spill/compaction）严格区分，避免循环依赖。
- ✅ **T16. 能力智能推荐引擎**（落点：新建 `recommend.py` + 后端 `/api/market/recommend` + 前端「能力推荐」tab）。确定性、可解释的任务画像 → 插件/技能/上下文提供者匹配（中文 2-gram + 英文词 + 能力/意图映射）。AC：输入"分析这个 repo"→ GitHub 插件/技能排名靠前且理由可追溯（真机验证）；空任务回退官方/已验证精选；用户可一键安装或前往技能页；LLM 重排列为后续增强。
- ✅ **T17. Sub-agent / 编排插件**（落点：新建 `orchestrator.py`（`discover` 发现 / `delegate` 委派 / 极简 schema 校验 / 工具名解析）+ 脚手架产出机器可读 `subagent.json`（`SUBAGENT.md` 保留为人读文档）+ `/api/subagents`、`/api/subagents/{name}/delegate` + 市场页「Sub-agent」tab）。插件用 `subagent.json` 声明 `system_prompt` / `tools` 白名单 / `input_schema` / `output_schema` / 可选 `entry_tool`，装上即注册。AC：委派"代码审查"子任务拿回**经 output_schema 校验**的结构化结论（真机：`已审查 src/`）；工具白名单是硬的（`entry_tool` 不在白名单直接拒）；输入缺必填字段**如实报错不猜不补**；子 agent 的工具调用**仍走沙箱/审批**（本地工具走统一管线，MCP 工具走已沙箱化的桥）并进 T-22 trace；llm 模式未登录时**如实报错**（"请先登录 EVA 账号"），不编造结论。
- ✅ **T18. 评测引爆室（Detonation Chamber）**（落点：`security.evaluate` + `_egress_self_test` + `skills.import_skill_zip` 导入即评测 + 后端 `/api/skills/{name}/evaluate`、`/api/plugins/{name}/evaluate` + 管理面板「行为评测」按钮 + 导入成功提示含结论）。组合静态特征扫描（T-6）+ **出口策略行为验证**（在 T-19 的 egress guard 子进程里实测拦截非 allowlist 主机，确定性、离线可跑）：声明了 `egress_policy` 的插件能验证"策略真拦得住"。AC：危险技能（脚本含 eval/os.system）静态高危→拒上架（T-6 已拦）；导入即出评测结论（通过/需留意/拒上架）；管理面板可一键行为评测并展示 verdict。注：对技能脚本"在沙箱里实际跑并抓行为"的更深一层，需编排层具备时再接（本期以确定性出口行为验证替代，不伪造）。
- ✅ **T19. Capability Security 升级（egress 策略 + 资源配额）**（落点：新建 `security.mint_ticket` + 出口拦截 sitecustomize + `sandbox` 给子进程挂 Job Object 资源配额）。AC：声明 `egress_policy`（如 `api.github.com`）的插件，其子进程访问其他域名被 socket 级拦截（真机验证：非允许域名 BLOCKED、允许域名放行）；MCP/命令子进程挂 Job Object 施加 CPU 速率 + 内存上限（env 配置，默认关，失败不阻断）；安装写入能力票据（capabilities + egress + quotas）。Node 等非 Python 子进程由 Low 令牌 + 声明式策略契约覆盖（无 socket 级拦截，已诚实标注）。
- ✅ **T20. 插件即智能体升级单元**（落点：`plugins.backup_for_rollback`/`rollback`/`has_rollback` + `skills.rollback` + `plugins._protocol_incompatible`（安装期版本兼容校验）+ 后端 `/api/plugins/{name}/rollback`、`/api/skills/{name}/rollback`、管理面板/技能卡「回滚上一版」按钮 + 安装阻断不兼容项）。AC：升级前自动留档，一键回滚到上一版（插件重注册 MCP、技能目录还原，已真机验证）；目录项声明 `agent_protocol` 高于当前则拒绝安装并如实告知；技能工具调用本就经 Evidence Ledger（T-升级方案，已满足，未破坏）。注：灰度 A/B 推送（按用户分组）留待编排层，本期先行回滚+兼容闭环。

### 5.4 P3 —— 生态放大器

- ✅ **T21. 多模态工具接入**（落点：新建 `multimodal.py`（`models_with`/`readiness`/`require`/`call`/`item_readiness`/`summary`，ability 标签直接复用 `model_catalog.ABILITIES`，不另造一套）+ 目录项 `abilities` 标注（5 项按真实描述标注，未臆造）+ `_with_install_state` 输出 `abilities`/`multimodal` + 4 端点 + 卡片「多模态就绪/缺多模态通道」徽章 + 安装弹层逐能力列出可用性与缺因）。AC：插件声明的 ability 被正确发现并**逐项如实报就绪度**（缺模型/缺通道分别说明缺哪一项）；门禁 `require` 不可用即拦；`call` **绝不返回占位产物**（真机验证返回 400 + 具体原因）；未声明多模态的项 `ready=None` 而非误报不可用。**诚实结论**：EVA 当前模型目录**没有任何生成类模型**（image_gen/video_gen/audio_out 均无），因此所有生图类插件一律被如实判为"不可用：模型目录里没有声明该能力的模型"——这是真实状态，不伪造出图。真实出图需接入外部多模态服务，属外部依赖，如实标注未做。
- ✅ **T22. 端到端 Tracing 与成本归因**（落点：新建 `tracing.py`（span 环形存储 + 按插件聚合）+ 在**统一入口** `tools.execute_tool` 打点（本地工具与 MCP 插件同一管线，`mcp:<sid>:<tool>`→插件名归属）+ `/api/tracing`、`/api/tracing/clear` + 管理面板「调用追踪」区块）。AC：每次工具调用记录成败/延迟并归属插件；管理面板可看每插件调用量·成功率·平均延迟·最近错误（**崩溃可定位到具体插件**，真机验证）；成本字段在网关上报 usage 时透传、无则不臆造。注：sub-agent 调用复用同一 `execute_tool` 入口，故天然被覆盖。
- ✅ **T23. 灰度发布与版本兼容矩阵**（落点：`plugins.compat_status`/`compat_matrix`（ok/update/update_staged/needs_agent）+ `set_rollout`/`in_rollout`/`cohort_bucket`（按本机 anon_id **稳定哈希分桶**，跨重启不变）+ 安装记录 `agent_protocol` + `/api/plugins/compat`、`/api/plugins/{name}/rollout` + 管理面板兼容徽章与灰度下拉）。AC：目录最新版要求更高 agent 协议 → 标"**需升级 agent**"（先升 agent，不硬装、装上不崩）；有新版但本机未命中灰度分组 → 标"**待灰度**"，命中 → "**可更新**"（真机验证三态）；分桶稳定、灰度比例 0/25/50/100 可调。
- ✅ **T11. 插件开发 SDK 与脚手架**（落点：新建 `scaffold.py`（`render`/`create`）+ `/api/dev/scaffold` + 插件页「开发你的插件」区块）。**不走 `npm create`**（需外网，与"离线可用"硬约束冲突），改为后端一键生成**零依赖、可直接本地安装调试**的最小工程：`eva-plugin.json`（capabilities / egress_policy / agent_protocol，与运行时同一套字段）+ `server.mjs`（手写 JSON-RPC，无 SDK 依赖）+ `README.md`（本地调试指引）+ 可选 `SUBAGENT.md`（sub-agent 模板，为编排层预留）。AC：生成物**真能跑**——`node server.mjs` 完成 initialize / tools-list / tools-call（真机验证）；静态扫描判为 safe 不误触闸门；同名目录默认拒绝覆盖（需显式 force）；危险名（路径分隔符等）被拒。
- ✅ **T12. 技能市场上架**（落点：新建 `publish.py`（`publish`/`unpublish`/`republish`/`install_published`/`merge_into_skills`/`export_listing`）+ `/api/publish/skill`（multipart 上架）、`/api/publish/skill/{name}/install|unpublish`、`/api/publish/listed`、`/api/publish/export` + 在架项并入 `/api/skills` + 技能页「上架我的技能」区块与本机上架卡「一键安装」）。AC：上架**必过 T-6 扫描 + T-18 评测**，danger 直接拒上架并说明原因（真机验证）；zip slip（`../`）被阻断；同名同版本默认拒绝覆盖（需 force）；版本化（`versions` 累积，可回退）；一键安装进用户级技能目录后 `/name` 可唤起；下架/再上架闭环；`export_listing` 作为跨机分发载体。顺带修复 front-matter 内联列表解析缺陷（`provides_context: [x]` 曾被当成带方括号的字符串）。
- ✅ **T13. 远程 MCP 传输（SSE/HTTP）**（落点：`mcp.py` 传输层**已存在**（`_StreamableHttpClient`/`_SseClient`/`_http_call`/`_read_sse`）；本期补齐**市场侧接入**：`plugins.install_remote`（url + 传输推断 `infer_remote_transport` + 高危审批 + 版本兼容校验 + 能力票据把该主机写入 egress + 握手失败不入库）+ `InstallPluginRequest.url/transport` + 前端安装弹层「远程托管 MCP（HTTP/SSE）」分支与数据出境风险提示）。AC：以**本地** HTTP MCP 服务夹具离线验证——远程接入握手成功、工具列表出现、真调通（`remote_add(2,3)→sum=5`）、票据 egress 含该主机、未审批被拦、握手失败不留幽灵服务（真机验证）。诚实边界：远程无子进程，故令牌/Job/出口 guard 不适用；真实风险是**数据出境**，由审批 + 声明式 egress 票据约束（本机 HTTP 调用无法像子进程那样被 socket 级拦截）。
- ✅ **T14. 插件沙盒评测集**（落点：新建 `evals.py`（12 条边界用例 + 目录合规审计 + 历史/回归对比）+ `/api/evals/security`、`/api/evals/history` + 管理面板「安全评测（回归集）」区块）。把 T-4/T-6/T-8/T-19/T-20/T-22/T-23 的关键防线固化为**确定性、离线、可进 CI** 的回归用例：恶意样本必拦（danger/warn/clean 三档）、**误报不复现**（SKILL.md 正文提及代码词不判 danger）、zip-slip 阻断、危险包拒上架、出口 allowlist 实测拦截、**未声明策略时如实报告未启用**、路径穿越被拒、协议不兼容拒装、遥测默认关、打点归属。AC：**12/12 全通过**（真机），历史留痕可对比"这次改动有没有搞坏边界"。目录合规审计顺带暴露真实缺口（35 项仅 3 项声明完整）→ 已为全部条目补 `agent_protocol`、为官方网络插件补真实 `egress_policy`，其余社区项**如实标红不假装合规**。

### 5.5 技术债

- ✅ **D1.** `gen-catalog.mjs` 双源收口（落点：**反转数据流**——`catalog.json`（字段最全、后端真正在读）成为**唯一数据源**；`gen-catalog.mjs` 改为从它生成前端离线 mock `src/data/catalog.generated.ts`；`mock.ts` 不再抄一份，改为 re-export；`--check` 模式做漂移守卫（CI 可用））。**为什么必须收口**：旧生成器只搬 name/desc/icon/color/cats，若谁再跑一次就会**静默抹掉 T-3/T-5/T-19/T-20/T-21 补的 capabilities / egress_policy / agent_protocol / version / publisher / verified / abilities**——那是一次真实的安全回归。现在改目录只有一个地方可改，前端离线与后端**不可能**不一致。
- ✅ **D2.** 前端离线 mock 与真实数据合并逻辑抽单一函数 + 补测试（落点：新建 `src/utils/market.ts` 的 `filterItems`/`sortItems`（**与后端 `market_items` 同规则**，`trust`=信任级>评分>安装量）+ `resolveItems`（在线取真数据 / 离线套用同一套规则 / 在线但请求失败也如实回退，不空白）；`PluginMarketView` 删掉重复的 `localPlugins`/`localSkills`；测试 `src/utils/market.test.ts` 用 **Node 内置 runner**（零新依赖）覆盖分类/关键词/叠加/三种排序/非法字段/纯函数性/在线离线/失败回退 —— **11/11 通过**）
- ✅ **D3.** 安装记录 KV 加 schema 版本号（落点：`plugins.SCHEMA_VERSION = 2`，KV 改为 `{"schema": n, "items": {name: row}}`，`_migrate()` 把旧格式 `{name: row}` **就地升级不丢已装状态**；`smoke_test.py` 断言同步更新）

---

## 6. 数据模型（字段级）

### 6.1 目录项 CatalogItem
`id` `name` `publisher` `verified` `version` `cats[]` `desc` `capabilities[]` `provides_context[]`（T15） `is_subagent`（T17） `eval_report`（T18） `egress_policy`（T19） `tools[]` `rating` `downloads` `signature` `agent_protocol`
### 6.2 安装记录 InstalledRecord（KV `plugins:installed`）
`name` `version` `enabled` `source` `path` `server_id` `capabilities[]` `provides_context[]` `is_subagent` `capability_ticket`（T19） `installed_at`
### 6.3 技能包 SkillPackage
`SKILL.md` front-matter：`name` `description` `capabilities?` `provides_context?` `scripts?`；用户级 > 项目级。

---

## 7. 非功能需求

| 维度 | 要求 |
|---|---|
| 性能 | 市场首屏（缓存）< 1s；安装 < 30s；更新 < 15s；能力推荐 < 200ms |
| 可用性 | 无网络降级快照 + 提示，不白屏 |
| 安全 | fail-closed；安装高危确认；MCP 子进程沙箱（T4）；egress/配额（T19）；引爆室（T18） |
| 质量协同 | 装上来的技能仍过对账闸门（T20，不破坏 `智能体升级方案` 质检） |
| 兼容 | Node 20+；Windows 沙箱（受限令牌 + Low 完整性标签）与类 Unix 一致 |
| 隐私 | 遥测匿名、可关、不采内容/凭据（T10） |
| 可观测 | 安装/卸载/启停/崩溃/调用量/成本有 trace（T22） |

---

## 8. 成功指标（KPI）

| 指标 | 目标（建议） |
|---|---|
| 月活插件安装数 | 上线 3 月内 > 30% 活跃用户装过 ≥1 插件 |
| 能力推荐接受率 | > 40%（衡量推荐引擎价值） |
| 更新渗透率 | 推送后 7 日内 > 50% |
| 插件崩溃率 | < 1% |
| 市场覆盖度 | 上线 6 月内 ≥ 20 个经引爆室评测的扩展 |

---

## 9. 前沿实践对标

| 实践 | 参照 | 本 PRD 落点 |
|---|---|---|
| 上下文工程 | Anthropic Context Engineering | T15 context provider |
| MCP 标准 | Anthropic MCP | 既有 + T4 沙箱 + T13 远程 |
| 能力组合三层 | Skills / Agents SDK / A2A | T17 sub-agent + T12 技能市场 |
| 市场=能力进化引擎 | 各 agent 客户端市场 | T16 推荐 + T20 灰度演进 |
| 不可信代码执行 | 引爆室 / EDR 沙箱 | T18 detonation + T19 capability security |
| 质量内建 evals | LLM-as-judge / 轨迹评测 | T18 eval_report |
| 可观测 | OpenTelemetry for Agents | T22 tracing |
| 本地+质检差异化 | EvaWork 内核账本（✅） | T20 不破坏对账闸门 |

---

## 10. 里程碑与细化拆解

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| M1「可信的最小市场」 | T1+T2+T3+T7 | 无 |
| M2「安全边界闭环」 | T4+T5+T6+T8+T19 | T3 |
| M3「能力进化引擎」 | T15+T16+T17+T18+T20 | T1/T5 |
| M4「生态与多模态」 | T9+T10+T11+T12+T21+T22 | T1/T5 |
| M5「开放接入」 | T13+T14+T23 | T4 |

### 10.1 M1 细化拆解（✅ 已全部落地，保留作实现留痕）

- **T1 目录服务端化**：选 GitHub Release 静态 JSON；`gen-catalog.mjs` 改产出发布产物；后端 `/api/catalog` 拉取+缓存；前端加 `cacheAge` 与离线提示。
- **T2 版本管理与更新**：`CatalogItem.version` + 安装记录 `version` + schema 版本号（D3）；新增 `update-check`/`update`，复用 install 并保留 enabled；前端"可更新"徽标 + 一键更新态。
- **T3 能力声明**：npm 插件读 `package.json` 的 `eva.capabilities`（缺省 network）；本地命令在 `local_command_spec` 加声明；安装弹层升级为"能力逐项解释 + 未声明警示"。
- **T7 管理面板**：`data-coming` 按钮改路由到管理视图；已装列表（来自 `/api/plugins/installed`）+ 启停/更新/卸载 + 权限与工具（`GET /api/plugins/{name}/tools`）。

---

## 11. 关键设计原则（延续 + 前沿）

1. **不假装**：市场每项必须真实可装（对齐"模型目录只收实测可用"）。
2. **失败如实说**：失败把接口原话带回，不"点了没反应"。
3. **安全 fail-closed**：探测失败不裸跑（对齐 T-082）。
4. **状态以本地注册表为唯一事实来源**：目录只做展示合并。
5. **装上来的能力仍过质检**（新增）：技能/插件触发的工具调用必须进 Evidence Ledger 与对账闸门——市场扩张不以牺牲反幻觉基座为代价（T20）。

---

## 12. 开放问题（待决策）

1. 远端市场源：自托管 vs GitHub Release？影响 T1/T6 复杂度。
2. 评分防刷：企业内网是否默认可信。
3. 远程 MCP 安全边界：SSE/HTTP 是否允许访问企业内网（T13 前定）。
4. 技能 vs 插件重叠归类（SKILL.md 既注入提示词又注册脚本工具时）。
5. Sub-agent 的隔离粒度：独立进程 vs 同进程沙箱（T17 前定，影响 T4 沙箱设计）。
6. Context Provider 的上下文如何计入账本投影（T15 与 P1-4 事件日志投影的衔接）。
