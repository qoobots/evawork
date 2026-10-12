# EvaWork Desktop · 技能 PRD 任务清单

> 生成日期：2026-10-07。
> 范围：**技能（Skill）** 这一个能力对象的端到端闭环——目录展示 → 安装/分发 → 发现加载 → 运行时消费 → 更新/回滚/下架。
> 触发：用户反馈「【插件市场 > 技能】只是摆设，并无实际实现」。**核实结论：反馈成立**，且顺带查出两处更深的断链（其中一处比用户报的更致命）。
> 与其它文档的边界：`08_EvaWork 插件市场PRD任务清单` 管市场框架与**插件**；`09_TS智能体任务清单` 管 TS 内核；本文件只管技能，并额外承担一条硬约束——**内核收敛到 TS 之后，技能必须两侧都能读到**，否则市场里装的东西等于没装。
> 证据均来自代码实测（文件:行号）与真机操作，非主观判断。

---

## 0. 判定口径：技能"真的能用"要走通五层

一个技能条目算「可用」必须五层全通，任何一层断掉，用户看到的都是"摆设"：

| 层 | 判据 | 现状（2026-10-07） |
|---|---|---|
| ① 目录可见 | 市场里有卡片，分类/搜索/排序可用 | ✅ 20 条 |
| ② **可安装** | 点「安装」能真正落到技能目录 | ❌ **断**（用户报的） |
| ③ **可被发现** | 装完之后**两套内核**都能发现它 | ♋ Python 能 / **TS 读不到** |
| ④ 运行时被消费 | 提示词注入 / `/name` 唤起 / 脚本工具注册 | ✅ Python 侧完整 |
| ⑤ 可更新回滚 | 版本、更新、回到上一版 | ♋ 仅「本机上架 / zip 导入」有回滚 |

> 与 08 文档的判定口径一致（那套是"三层通道"：UI 绑定 / 持久化 / 运行时消费）。
> 技能多了一层：**跨内核一致性**——这是本项目特有的，收敛期内必须单列。

---

## 1. 结论先行

**技能不是"没实现"，而是"运行时通了、市场那一段断了，而且断的位置正好在内核收敛的缝里"。**

三处断链，按严重度：

| # | 断链 | 症状 | 谁会踩 |
|---|---|---|---|
| **A** | **市场 → 安装：完全断** | 20 张卡片点「安装」毫无反应 | 所有用户 |
| **B** | **Python 技能目录 → TS 内核：读不到** | 技能装上了，TS 智能体完全不知道有它 | 收敛后的默认内核（**即将全员踩**） |
| **C** | 双内核项目级目录名不一致 | 同一份技能在两套内核里路径不同 | 开发者 |

B 是本次盘点里最严重的一条：**内核收敛的方向是 TS（09 文档 §内核收敛），而技能目录这件事上 TS 侧是残的**。也就是说市场里"装好的技能"在默认内核下全部失效，且**没有任何报错**。

---

## 2. 真机实测（2026-10-07）

**现象**：进入【插件市场 > 技能】，20 张卡片全部正常渲染；点任意一张的「安装」→ **界面无任何变化**（无弹层、无报错、无状态变化）。

**代码路径**（`PluginMarketView.vue`）：

```
卡片按钮 @click="openInstall(s)"                       // :1027-1031
  → openInstall:  spec.value = item.spec || ''         // :318-322
  → canInstall = spec.trim().length > 0 && confirmed   // :293-296
  → doInstall: if (!canInstall.value) return;          // :350-351  ← 静默返回
```

技能目录条目**没有 `spec` 字段**（见 §3 证据 ①），于是 `spec` 恒为空 → `canInstall` 恒为 false → 点「确认安装」后**静默 return，什么都不发生**。

**对照**：插件 tab 有这道守卫——

```
:939-942  :disabled="!online || !p.spec"
          :title="!p.spec ? '该条目暂未声明安装来源' : ..."
          >{{ p.spec ? '安装' : '暂无安装源' }}<button
```

**技能 tab 没有**（`:1027-1031` 只有 `:disabled="!online"`），所以按钮长得像能点，点了没结果——**这比直接禁用更伤**。

---

## 3. 现状盘点（逐层，带证据）

### ① 目录（`apps/desktop-py/evawork/data/catalog.json`）

`skills: 20` 条，字段只有：`name` / `desc` / `icon` / `color` / `cats` / `agent_protocol` / `abilities`。

**证据 ①**：`skills` 数组里**没有任何一条带 `source` / `spec` / `skill_id` / `url`**，与 `plugins` 数组里已修好的"可安装来源"字段不对等（08 文档 T-142 修的就是插件侧的这个问题）。
`skillCats`: `全部 / 开发工具 / 界面设计 / 内容创作 / 效率提升 / 数据分析`。

### ② 安装通道（`apps/desktop-py/evawork/api.py`）

存在的端点：

| 端点 | 用途 | 状态 |
|---|---|---|
| `GET /api/skills` | 市场列表 + 本地已加载 | ✅ |
| `GET /api/skills/installed` | 已加载清单（供 `/name` 补全） | ✅ |
| `GET /api/skills/{name}` | 详情 | ✅ |
| `POST /api/skills/import` | 从 `.skill.zip` 导入（T8） | ✅ |
| `POST /api/skills/{name}/rollback` | 回到导入前版本（T20） | ✅ |
| `POST /api/skills/{name}/evaluate` | 行为评测/引爆室（T18） | ✅ |
| 上架 / 一键装（`publish.py`） | T12 | ✅ |
| **`POST /api/skills/{name}/install`（从目录安装）** | — | ❌ **不存在** |

**证据 ②**：`api.py:706/784/793/804/810/1280/1288` 有上述端点，全库无"按目录条目安装技能"的端点。

### ③ 发现路径（两侧不一致）

| 内核 | 用户级 | 项目级 | 证据 |
|---|---|---|---|
| Python `skills.py` | `~/.evawork/skills/`（可被 `EVAWORK_SKILL_DIR` 覆盖） | `<工作目录>/.evawork/skills/` | `skills.py:48-49, 100-109` |
| **TS `skill.ts`** | **无**（完全不读用户级） | `<ws>/.eva-skills/`、`<ws>/skills/` | `skill.ts:20-27` |

**证据 ③**：市场安装/导入的技能落在 `~/.evawork/skills/`（`skills.py:425-427`），
而 TS 侧 `skillDirs()` 只返回两个**项目内**目录 → **TS 智能体永远发现不了已安装的技能**。

### ④ 运行时消费（Python 侧完整）

- 发现/缓存：`skills.discover()`（按 mtime+size 签名失效，不做文件监听——理由已写在 `skills.py:22-23`）
- 提示词注入、`/name` 唤起、`allowed_tools` 收窄、脚本工具 `skill.<技能>.<脚本>`（`skills.py:52-53`）、脚本沙箱与 30s 超时（`SCRIPT_TIMEOUT`）
- TS 侧也有最小实现：`skillIndex()` 只给名字+摘要，全文按需 `load_skill()`（`skill.ts:70-87`）——**设计上是对的**（不撑爆上下文），但它连"有哪些技能"都数不出来。

### ⑤ 版本与更新

- 技能**没有** `version` 字段与更新通道（插件侧有 T2 版本管理）
- 仅有：导入前留档 + 回滚（T20）、上架版本号（T12）

---

## 4. 任务清单

> 优先级：**P0** = 不修则"技能"对外是摆设或装完无效；**P1** = 闭环；**P2** = 质量。

### P0 · 先止血，再谈功能

#### S-01 目录技能无安装源时**诚实禁用**（对齐插件）
- **现状**：❌ 按钮可点、点了没反应
- **做什么**：技能卡复用插件的守卫——`v-else` 分支加 `:disabled="!online || !s.source"`；无 `source` 时文案改「暂无安装源」，`title` 说明"该条目暂未声明安装来源"
- **验收**：技能 tab 全部 20 条呈禁用态且文案为「暂无安装源」；点不动；hover 有原因
- **文件**：`PluginMarketView.vue:1027-1031`

#### S-02 **两套内核的技能目录必须同源**（本次最致命的一条）
- **现状**：TS 侧读不到 `~/.evawork/skills/`，而市场装的就是那里
- **做什么**：
  1. TS 新增 `userSkillsDir()`：`process.env.EVAWORK_SKILL_DIR || path.join(os.homedir(), '.evawork', 'skills')`——**复用与 Python 同一个环境变量名**，便携部署/测试的覆盖语义才一致
  2. `skillDirs(workspace)` 改为：`[用户级, <ws>/.evawork/skills, <ws>/.eva-skills, <ws>/skills]`（前两个与 Python 对齐，后两个保留兼容）
  3. 用户级优先（与 `skills.py:104` 同序）
- **验收**：在 `~/.evawork/skills/` 放一个技能 → TS 侧 `skillIndex()` 能列出它；自检加一条"TS 与 Python 解析出的用户级目录相同"
- **文件**：`agent-ts/src/skill.ts`、`selftest.ts`
- **注**：不要用 `session.ts` 的 `homeDir()`——它是 `~/.evawork/ts-agent`（数据目录），与技能的 `~/.evawork` **不同层级**，混用会让两套内核各说各话

#### S-03 装完必须**两套内核都认**（跨内核回归）
- **现状**：无此验证
- **做什么**：加一条端到端冒烟——`.skill.zip` 导入 → Python `discover()` 与 TS `discoverSkills()` **同时**能列出该技能
- **验收**：冒烟通过；任一侧漏报即失败（这是防止下次再漂移的锁）

### P1 · 让技能真能装、能用

#### S-04 内置精选技能包（目录条目的真实来源）
- **现状**：20 条目录技能没有可安装物
- **做什么**：随应用分发 `resources/skills/<name>/SKILL.md`（8–12 个精选：写测试、读代码、查依赖、安全审查、生成发布说明…），目录条目补 `source: { type: 'builtin', id }`；安装 = 复制到用户级技能目录
- **为什么选内置而不是远程 registry**：与 08 的"可配置远端源 + 缓存 + 离线回退"一致——**先本地精选保证离线可用**，远程后置
- **验收**：装完 `skillIndex()` 能看到、`load_skill()` 能取全文、删掉技能目录后界面显示"未安装"

#### S-05 已安装技能在技能 tab 可见可管理
- **现状**：模板有 `installed` 分支，但依赖 `installed` 状态来源，跨内核不一致时会出现"装了却没显示"
- **做什么**：已安装状态以**文件系统**为准（`GET /api/skills/installed`），不另存一份 KV
- **验收**：导入/上架安装后，卡片立刻变成「已启用/卸载」；重启后仍然正确

#### S-06 技能详情（来源、版本、能力、扫描结果）
- **做什么**：点卡片开详情抽屉——全文摘要、来源、版本、`abilities`（如 `image_gen`）、安全扫描等级、更新时间
- **验收**：详情里每一项都有真实来源，不出现"暂无"

#### S-07 安装前的能力与风险告知
- **做什么**：装之前说清三件事——**会注入哪些提示词**、**声明了哪些能力**、**是否含脚本（走沙箱）**
- **验收**：含脚本的技能有明确警示；`abilities` 非空时列出

### P2 · 质量与生态

#### S-08 技能版本与更新（对齐插件 T2）
- 目录条目补 `version`；已安装技能显示"可更新 · x.y.z"；一键更新走"导入前留档 → 覆盖 → 可回滚"
- **验收**：更新失败能回到上一版（复用 T20 的 `.{name}.rollback`）

#### S-09 技能使用埋点（没人用的技能该下架）
- **做什么**：记录技能被 `load_skill` 唤起的次数（沿用 `telemetry.py` 的默认关/匿名/白名单口径）
- **验收**：管理面板能看"近 7 天被用过 / 从没被用过"，并给出下架建议

#### S-10 评分与安装量（复用 `market_stats.py`）
- 技能卡展示评分与安装量；排序把"信任级 > 评分 > 安装量"对齐插件侧
- **验收**：排序下拉对技能生效

### 明确不做（本期）

- 技能内**远程代码执行**：`scripts` 仍走沙箱与 30s 超时，不给"技能自带长期进程"这种口子
- 技能市场付费/结算（对齐 08 的非目标）
- 技能自更新（把自己换成新版）——太早，且与 S-08 的"更新"重复

---

## 5. 里程碑

| 里程碑 | 内容 | 判定 |
|---|---|---|
| **M0 止血**（半天） | S-01 + S-02 | 按钮不再骗人；两套内核目录同源 |
| **M1 闭环**（1–2 天） | S-03 + S-04 + S-05 | 装一个技能 → **TS 智能体真的用上它** |
| **M2 可信**（1 天） | S-06 + S-07 | 装前知道它是什么、会不会写文件 |
| **M3 生态**（后续） | S-08 + S-09 + S-10 | 版本、留存、排序 |

**建议先只做 M0 + M1**：M0 半小时把"骗人的按钮"变诚实，M1 让"装一个技能、TS 智能体真能用"这条主链第一次跑通。剩下的都可以等主链跑通再说。

---

## 6. 验收总则（沿用 07/08 的纪律）

1. **不认"改了代码"**：每项任务要有**可复现的验证动作**（真机点一次 / 跑一次冒烟），并把结果写回本文档。
2. **诚实优先于好看**：做不到的先禁用 + 写明原因，不要留一个"点了没反应"的按钮（S-01 就是这条纪律的直接产物）。
3. **跨内核一致性必须由测试锁住**：S-03 这类冒烟不许省——本项目正在收敛到单一内核，两侧漂移一次就是"用户装了但没生效"。
4. **证据写进文档**：状态标记沿用 07 的 ✅（改了就生效）/ ♋（部分实现）/ ❌（摆设或明确未实现）。

---

## 附：本文档与 08 的分工

| 范围 | 归属 |
|---|---|
| 市场框架、目录服务化、信任分级、安全扫描、评测、灰度、遥测、Sub-agent、插件侧安装/更新/回滚 | `08_EvaWork 插件市场PRD任务清单` |
| **技能这一个对象的端到端闭环**（含跨内核目录一致性） | **本文档** |
| TS 内核本身（loop / 工具 / 沙箱 / 回滚点 / 隔离 / plan mode / rewind） | `09_TS智能体任务清单` |
---

## 7. 联网调研：热门技能生态与候选清单（2026-10-07）

> 目的：给 S-04（内置精选技能包）找参照系与候选。**结论先行：能直接用的和最想要的，不是同一批。**

### 7.1 参照系

| 来源 | 规模 | 许可 | 说明 |
|---|---|---|---|
| [`anthropics/skills`](https://github.com/anthropics/skills) | **179,929 stars / 21,276 forks**，2026-10-07 仍在更新 | 混合（见 7.2） | 官方仓库；`skills/` 19 个示例、`spec/` 规范、`template/` 模板。README 指向 [agentskills.io](http://agentskills.io) 作为**开放标准** |
| 社区 awesome 清单（如 `kriptoburak/awesome-skills-vivy`、`kntism/skills`） | 230+ 仓库 | 各自不一 | 质量参差、许可多为"看仓库"，**不建议直接进产品**，只作选题参考 |

**方法说明**：官方仓库已 `git clone --depth 1` 到本地逐个核对 front-matter 与 LICENSE.txt，
下面的许可结论来自文件本身，不是二手转述。

### 7.2 ⚠️ 许可红线（这一节决定谁能进产品）

| 许可 | 技能 | 能否打包进 EvaWork |
|---|---|---|
| **Apache 2.0**（逐个核对 `LICENSE.txt` 确认） | webapp-testing、mcp-builder、frontend-design、skill-creator、doc-coauthoring、internal-comms、brand-guidelines、theme-factory、academy-guide、algorithmic-art、canvas-design、slack-gif-creator、web-artifacts-builder、discernment-nudge、claude-api | ✅ 可用（须保留版权与声明） |
| **Anthropic PBC 专有**（LICENSE.txt 首行 "© 2025 Anthropic, PBC. All rights reserved."，且写明受其服务条款约束 + **ADDITIONAL RESTRICTIONS**） | **docx、pdf、pptx、xlsx** | ❌ **不可**。README 自己写明 "source-available, **not open source**" |
| 无 `license` 字段 | doc-coauthoring、skill-creator（后者有 LICENSE.txt） | ⚠️ 需单独确认后再用 |

**第三方组件风险**：官方仓库的 `THIRD_PARTY_NOTICES.md` 声明捆绑了 **imageio（BSD-2）**、
imageio-ffmpeg（BSD-2）与 **FFmpeg 7.0.2（GPL v3）**。GPL v3 是 copyleft，
随商业产品分发有合规风险——这也是"文档四件套不能直接拿"的第二个理由。

**由此得出一个反直觉的结论**：
**功能上最该做的（文档处理 docx/pdf/pptx/xlsx）许可不允许直接用；
许可最干净的（纯提示词型技能）又大多不是刚需。**

所以路径是分两条腿走：**能用的借鉴/引入，拿不到的自研**（见 7.5）。

### 7.3 官方 19 个技能逐个评估

| 技能 | 许可 | 适配 EvaWork？ | 判断 |
|---|---|---|---|
| `skill-creator` | Apache-2.0 | ✅ | **强烈建议**：让智能体自己创建/改进技能——与技能市场天然契合（自我扩展） |
| `mcp-builder` | Apache-2.0 | ✅ | EvaWork 已有 MCP 能力（TS-032），可直接借鉴 |
| `webapp-testing` | Apache-2.0 | ✅ | 契合 EvaWork 的内置浏览器 + 自动截图；**注意其脚本是 Python**，需改写为 Node |
| `frontend-design` | Apache-2.0 | ✅ | 纯提示词型、零依赖，**最容易借鉴** |
| `doc-coauthoring` | 无字段 | ✅ | 纯提示词型的文档协作流程（提案/技术规格/决策记录），贴合日常 |
| `internal-comms` | Apache-2.0 | ✅ | 周报/公告/内部沟通模板，**办公场景高频** |
| `theme-factory` | Apache-2.0 | ✅ | 10 套预设主题，可套用到产物（幻灯片/报告/HTML） |
| `brand-guidelines` | Apache-2.0 | △ | 是 **Anthropic 自己的品牌**规范，需替换成用户自己的品牌才有意义 |
| `academy-guide` | Apache-2.0 | △ | 教学/内容呈现 |
| `discernment-nudge` | Apache-2.0 | △ | 判断力提示机制，有价值但抽象 |
| `algorithmic-art` | Apache-2.0 | △ | p5.js 生成艺术，趣味向，非办公刚需 |
| `claude-api` | Apache-2.0 | ❌ | **Claude API 专用**；EvaWork 走 OpenAI 兼容通道，用不上 |
| `canvas-design` | Apache-2.0 | ❌ | 83 个文件、绑定 Claude 画布产物形态 |
| `web-artifacts-builder` | Apache-2.0 | ❌ | 绑定 claude.ai 的 HTML artifacts 形态 |
| `slack-gif-creator` | Apache-2.0 | ❌ | Slack 特定 |
| **docx / pdf / pptx / xlsx** | **专有** | ❌→✅ 自研 | **不可直接用**；但这正是 EvaWork 最需要的能力，见 7.5 |

### 7.3.1 GitHub 热门技能仓库扫描（2026-10-07 第二轮）

| 仓库 | Stars | 许可 | 判断 |
|---|---|---|---|
| [`microsoft/SkillOpt`](https://github.com/microsoft/SkillOpt) | 18,085 | **MIT** | 微软的**技能文本空间优化器**（评测/优化已有技能）。不是技能本身，但它的评测维度值得借鉴——正好对应 S-09「没人用的技能该下架」 |
| [`bergside/awesome-design-skills`](https://github.com/bergside/awesome-design-skills) | 3,068 | **MIT** | **67 个视觉风格技能**（clean / bento / bold / brutalism / editorial…），每个含 `SKILL.md` + `DESIGN.md` |
| [`EverMind-AI/SkillCorpus`](https://github.com/EverMind-AI/SkillCorpus) | 683 | Apache-2.0 | 把散落的 `SKILL.md` 做成**精选语料库**的基础设施。适合以后做"技能质量基线" |
| [`mxyhi/ok-skills`](https://github.com/mxyhi/ok-skills) | 493 | Apache-2.0 | 精选 coding agent 技能 + `AGENTS.md` 剧本，可作选题参考 |

**许可层面全部可用**（MIT / Apache-2.0，逐个用 GitHub API 核实过 `license.spdx_id`），
不像官方那 4 个文档技能那样有红线。

**但 67 个设计技能我并没有全搬**，理由值得写下来：

1. **它们的内容定位是"生成设计系统文档"**（front-matter 的 Mission 是 "You are an expert
   design-system guideline author"），而不是"帮我把界面做漂亮"——直接用会跑偏。
2. **67 个条目会变成噪音**：技能列表里绝大多数用户一辈子不会用到，反而挤占了真正会用的条目。
3. 正确做法是**抽取其思路、收敛成一份速查**：把常用风格（极简 / 专业 / 活力 / 编辑 / 几何 / 暗色）
   各自的适用场景、色板、字体刻度、间距与**反例**汇总成一个 `visual-styles` 技能，
   并强调"先看项目已有设计系统，再来这里选"。

→ 已落地为内置技能 `visual-styles`（自撰，内容与许可均干净）。

**结论：GitHub 上"可直接拿来用"的技能，许可与定位两个筛子缺一不可。**
许可可用 ≠ 定位可用；定位不对时，正确动作是抽取思路重写，而不是照搬。

### 7.3.2 候选评估：obra/superpowers（296k stars）

| 项 | 值 |
|---|---|
| 仓库 | [`obra/superpowers`](https://github.com/obra/superpowers) |
| Stars / Forks | **296,063 / 26,434**（比 anthropics/skills 的 179k 还高） |
| 许可 | **MIT** |
| 活跃度 | 创建 2025-10-09，2026-10-06 仍有推送 |
| 定位 | **不是单个工具，而是一套软件开发方法论** = 15 个可组合技能 + 初始指令 |

**15 个技能**：brainstorming、writing-plans、executing-plans、test-driven-development、
systematic-debugging、requesting-code-review、receiving-code-review、
verification-before-completion、using-git-worktrees、subagent-driven-development、
dispatching-parallel-agents、writing-skills、using-superpowers（入口）、
diagnosing-superpowers、finishing-a-development-branch。

它主张的流程是：**先问清要什么 → 写实现计划 → TDD 写码 → 子代理分工执行 → 评审 →
完成前验证**，并强调「技能自动触发，用户不用做任何事」。为 9 个 agent 平台各做了适配
（`.claude-plugin` / `.codex-plugin` / `.cursor-plugin` / `.devin-plugin` 等）。

#### 关键发现：平台耦合几乎为零

逐词统计 15 个技能正文里 Claude 专有工具的出现次数：
`Task tool` **0**、`TodoWrite` **0**、`EnterPlanMode` **0**、`AskUserQuestion` **0**。
内容是**纯方法论文本 + Mermaid 流程图**，动作描述是通用的（"派一个新的实现子代理"）。

**所以它们可以被本项目的技能系统直接加载**——格式同为 `SKILL.md`，许可 MIT。

#### 但有三处不能照搬

| 问题 | 说明 | 我方对策 |
|---|---|---|
| **入口技能的极端强制语气** | `using-superpowers` 写的是「只要有 1% 可能相关就**必须**调用，This is not negotiable」 | **不引这个入口技能**。我们的模型走 OpenAI 兼容通道，过度强制的指令未必被遵守，还可能挤占上下文；改为提示词里的技能清单（已有）+ 描述里的触发词 |
| **全英文** | 用户与工作区都是中文 | **中文化改写**，保留其方法论骨架（红/绿、重构、验证清单），用词换成我们的实际工具名 |
| **依赖 SessionStart hook 注入** | 它靠 `hooks.json` 在会话启动时注入"你有这些技能" | 我们没有 hooks 机制，但提示词已有 `skills` 一节（名字+摘要+触发词），作用等价，不引入 hook |

#### 与现有能力的重叠

| Superpowers | 本项目现状 | 判断 |
|---|---|---|
| `test-driven-development` | 无 | **最值得引**（红/绿/重构是团队规范里最缺的一环） |
| `verification-before-completion` | 无（"改完就算完"是当前弱项） | **最值得引** |
| `writing-plans` / `executing-plans` | `plan.ts`（只有清单，无"写计划"的写法） | 值得引 |
| `systematic-debugging` | 自写 `debugging` | 取长补短（它的"先复现→提假设→验证根因"更系统） |
| `brainstorming` | `doc-coauthoring`（偏写文档） | 互补（一个想清楚、一个写出来） |
| `requesting/receiving-code-review` | 无 | 值得引（对应我们缺的一环：让子代理互审） |
| `writing-skills` | 无 | 值得引——**让智能体自己写技能**，是技能生态的自我扩展入口 |
| `using-git-worktrees` | TS-061 隔离（复制副本，不依赖本机 git） | **保留我们的**（不要求本机装 git、更安全）；只借鉴它 `finishing-a-development-branch` 的分支收尾流程 |
| `subagent-driven-development` | 有 `delegate` 能力，**缺编排方法** | 值得引（我们有"能力"没有"按计划分工 + 交叉评审"的打法） |

#### 结论

**能集成，而且性价比高**——但方式是**精选 + 中文化改写**，不是整体引入：

1. **首批 5 个**：`test-driven-development`、`verification-before-completion`、
   `writing-plans`、`systematic-debugging`（替换自写版）、`requesting-code-review`
2. **不引**：`using-superpowers`（极端强制语气）、hooks 机制
3. **保留我方**：`using-git-worktrees`（我们的副本隔离不依赖本机 git）
4. 每引入一个都要：① 中文化 ② 工具名对齐本项目（`patch`/`grep`/`run_command`/`delegate`）
   ③ 去掉 Claude 语境（如 "Your human partner"）

> 一句话：**这个项目的价值不是代码，是那套流程**。而我们的技能系统刚好能承载它——
> 这也说明 S-04（内置技能包）走对了路：技能是"方法论的可移植载体"，
> 比插件（能力）轻、比 prompt 工程（一次性）耐久。

### 7.3.3 Superpowers 实际引入（2026-10-07，最终按「整体搬」执行）

上一节给的建议是"精选 5 个"。**实际执行时决定整体搬入 15 个**——理由：
296k stars 不是运气，是被无数人验证过的流程；砍到 5 个等于用我们的判断
替代了已经存在的验证。而且**搬全部的成本并不比搬 5 个高多少**（附属文件原样带，
主文件逐个中文化），差别只在工作量而不是风险。

#### 三类处理（"整体搬"不等于"逐字翻译 166KB"）

| 类别 | 处理 | 涉及 |
|---|---|---|
| **核心方法论** | **中文化改写**：保留方法论骨架、全部表格与好/坏示例；工具名对齐本项目（`run_command`/`patch`/`delegate`/`load_skill`）；路径改为本项目实际 | 全部 15 个 |
| **入口技能的语气** | `using-superpowers` 上游原文是"哪怕 1% 可能相关就必须调用，这不是可以商量"。**刻意不采用那种语气**，并在技能里写明理由：① 本项目走 OpenAI 兼容通道，MUST 式指令不一定被遵守；② 技能的价值在于**被用对**而不是被强制触发，硬套会让模型选错技能、写不必要的计划 | using-superpowers |
| **附属参考文件** | **原样保留英文**（45 个 .md + 脚本）。它们是模型按需读取的参考资料，翻译不增加能力、只增加维护成本；用户也看不到它们 | 全部附属文件 |

#### 与本项目能力对齐时改掉的东西

- 计划保存路径：`docs/superpowers/plans/` → `docs/plans/`（我们不是它）
- 隔离方式：`using-git-worktrees` 改为**优先用本项目的内置隔离副本**（TS-061，
  不依赖本机装 git），并说明 git worktree 只在"本机有 git 且工作区是仓库"时可选
- `subagent-driven-development` 里补了一条**本项目特有的硬约束**：`delegate` 的
  子代理是 **never 档**（写文件/跑命令一律拒绝），所以"派它直接改代码"这条路走不通，
  可行分工是"子代理出方案与补丁、主任务落盘与验证"
- 各技能补上"与本项目的关系"小节（隔离副本、回滚点、plan mode、todo_write）

#### 出处与许可

- 来源：https://github.com/obra/superpowers （MIT，Copyright obra）
- `SUPERPOWERS-LICENSE`（MIT 全文）与 `SUPERPOWERS-NOTICE.md`（出处 + 引入方式 +
  上游同步方式）随技能一起分发

#### 结果

内置技能 **13 → 28 个**（15 个自撰 + 13 个 Superpowers），Python 与 TS 两侧都发现。

> 顺带一个观察：这 15 个技能与自撰的 13 个**几乎零重叠**，但正好互补——
> Superpowers 管**流程**（怎么想、怎么排、怎么验证），自撰的那些管**具体场景**
> （文档怎么写、周报怎么写、界面怎么设计、Git 命令怎么用）。

### 7.3.4 又引入两个仓库（2026-10-07）：mattpocock 278k★ / emilkowalski 44k★

| 来源 | Stars | 许可 | 引入 |
|---|---|---|---|
| [mattpocock/skills](https://github.com/mattpocock/skills) | **278,325** | MIT | 15（**去重后**精选） |
| [emilkowalski/skills](https://github.com/emilkowalski/skills) | 43,960 | MIT | 11（排除 Swift / React Native） |

**这次没有整体搬**——与 Superpowers 不同，这两个库与已有能力**大量重叠且部分绑定作者生态**：

| 处置 | 内容 |
|---|---|
| 不引（重复） | `tdd` / `code-review` / `diagnosing-bugs` / `implement-spec` / `prototype`——与已有 TDD、code-review、systematic-debugging、executing-plans 重叠 |
| 不引（生态绑定） | `setup-matt-pocock-skills` / `triage` / `wizard` / `ask-matt`（绑定他的 issue tracker 与命令体系）；`misc/*`（shoehorn 迁移、pre-commit、Claude Code hooks、scaffold） |
| 不引（作者自标） | `in-progress/*`（**他自己标为进行中**） |
| 不引（平台不符） | `write-swift`（Swift）、`animate-expo`（React Native/Expo） |
| **引入** | 深模块设计、领域建模、拷问式访谈、规格/任务拆分、PR、调研、回顾、交接、问卷、为智能体写文档、UX 校验（mattpocock）；动画/界面打磨 11 个（emilkowalski） |

**做法与 Superpowers 一致但更省**：主文件**保留英文正文**，只把 front-matter 的
`description` 换成中文（界面显示中文、模型读原文），并加 `category` / `source`。
权限与出处声明随技能分发（`SKILLS-NOTICE.md`）。

#### 分类体系（六类）

技能数从 13 → **54** 之后，"全部"这个筛选器等于没有分类，于是加了 front-matter 的
`category`，并让界面**按类分组**（比筛选器直观：一眼看全）。
顺序按"最可能先被用到"排，而不是按字母或数量。

| 分类 | 数量 | 覆盖 |
|---|---|---|
| 流程与编排 | 16 | 头脑风暴、写计划、执行计划、多代理、子代理驱动 |
| 工程实践 | 13 | TDD、评审（请求/接收）、调试、重构、Git、领域建模、深模块 |
| 界面与设计 | 13 | 版式、视觉风格、动画、界面打磨、组件库选型 |
| 办公与协作 | 8 | 内部沟通、会议纪要、邮件、总结、交接、问卷、复述 |
| 文档与写作 | 3 | 文档协作、更新说明、为智能体写文档 |
| 数据与分析 | 1 | 数据分析 |

落地：后端 `skills.py` 解析 `category`/`source` 并输出 → `api.py` 合并进市场项 →
前端按 `category` 分组。**无分类的技能落在「其他」里，不会丢**。

#### 这一轮修掉的两个 bug（都不是新功能带来的）

| bug | 表现 | 修法 |
|---|---|---|
| **Vue 3 模板不支持数组解构** | `v-for="[cat, list] in groups"` → 运行时编译报 `Element is missing end tag`，**整个插件市场页挂掉** | 改成 `v-for="g in groups"`。⚠️ **`vue-tsc` 抓不到**（typecheck 全绿），只有真跑才炸 |
| **front-matter 把自由文本按空白拆成列表** | `description: 实现功能或修 bug 前先写测试` 变成 `["实现功能或修", "bug", "前先写测试"]`，界面上直接显示这个数组 | `_split_list` 只对**列表类字段**（`allowed_tools`/`provides_context`/`capabilities`…）生效，其余原样保留。⚠️ 这是**既有 bug**（英文描述同样中招），只是这批技能把描述写长了才显出来 |

> 第一条值得记住的教训：**`vue-tsc` 通过 ≠ 模板能编译**。它不检查 `v-for` 表达式的运行时合法性，
> 那一类只有浏览器里才会炸。

### 7.4 三条可复用的设计模式（不抄代码也值得抄设计）

1. **触发词写在 description 里**：官方技能普遍用 "Use this skill **whenever** the user wants to…"
   把触发条件写进 front-matter，模型据此决定要不要唤起——这比在正文里写"建议使用"有效得多。
   EvaWork 的 `discoverSkills()` 摘要把 description 作为摘要给模型，**天生就是这个模式** ✓
2. **脚本当黑盒，不读源码**：官方 `webapp-testing` 明确写 "Always run scripts with `--help` first…
   DO NOT read the source until…"，理由是脚本很大、读了会污染上下文窗口。
   EvaWork 已有工具输出截断，但**"先 --help 再用"这条指令本身**值得写进技能模板。
3. **正文短、引用多**：SKILL.md 普遍 2–12KB（最大的是 claude-api 102KB，但那是个"全套参考手册"型特例），
   细节拆到同目录的引用文件里按需读取 —— 与 TS 侧 `load_skill()` 按需取全文的设计一致 ✓

### 7.5 落地建议：首批内置技能 + 自研清单

**首批内置（借鉴 Apache-2.0 技能，改写为 EvaWork 语境）**：

| 拟内置技能 | 来源 | 改写要点 |
|---|---|---|
| `doc-coauthoring`（文档协作） | doc-coauthoring | 去掉 Claude 措辞；产物落到 EvaWork 工作区并接 T-092 回滚点 |
| `internal-comms`（内部沟通） | internal-comms | 模板换成中文办公语境（周报/公告/评审纪要） |
| `frontend-design`（前端设计） | frontend-design | 强调配合 EvaWork 的设计系统（.docs/02 设计系统规范） |
| `theme-factory`（主题套用） | theme-factory | 产物类型改成 EvaWork 实际产物（幻灯片/报告/HTML） |
| `mcp-builder`（MCP 构建） | mcp-builder | 对齐 EvaWork 现有的 MCP 接入与沙箱约束 |
| `skill-creator`（技能自造） | skill-creator | 让智能体帮用户造新技能——**自我扩展的入口** |

**必须自研（许可不允许抄）——文档四件套**：

| 能力 | 建议技术栈（Node 生态，与内核一致） | 备注 |
|---|---|---|
| Word（.docx） | `docx` | 读写、样式、批注 |
| 幻灯片（.pptx） | `pptxgenjs` | 生成与模板套用 |
| 表格（.xlsx） | `exceljs` | 读写公式与图表 |
| PDF | `pdf-lib`（生成/合并）+ `pdfjs-dist`（读取） | 注意 PDF 文本抽取质量要实测 |

自研时**可以借鉴官方那四个技能的"工作流与触发词设计"，但不得复制其实现或文本**。

### 7.6 内置技能怎么送到用户面前（不依赖市场安装）

内置技能**不走市场安装**（那正是断链 A），走应用侧分发：

1. 随包分发 `resources/skills/<name>/SKILL.md`（Apache-2.0 的需附 `LICENSE.txt` 与版权声明）
2. **首次启动时复制到用户级技能目录** `~/.evawork/skills/`（用户可查看、可修改、可删除）
3. Python 侧**已经**能发现用户级目录（`skills.py:48`）；**TS 侧目前不能**（见 S-02），所以 **S-02 是内置技能能被默认内核看见的前提**

> 结论：**S-02 不修，内置技能装进去也是白装**（TS 侧看不见）。
> 这也是本文档把 S-02 排进 M0 止血的原因——它不只是"目录不一致"，它是"技能生态在内核侧的天花板"。
