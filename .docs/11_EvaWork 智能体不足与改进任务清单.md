# EvaWork 智能体不足与改进任务清单（差距分析 · 改进方案 · 任务分解）

- **文档性质**：差距清单。**只记"现在做不到什么"和"怎么补"**，不重复描述已完工的能力
  （完工部分见 `09_EvaWork TS智能体任务清单.md`）。每项给「现状证据 → 缺口 → 改进方案 → 验收判据」
- **评估对象**：`eva-desktop/apps/agent-ts/`（TS 内核，定位日常工作）为主，
  `eva-desktop/apps/desktop-py/evawork/`（Python 内核，定位数据分析）为对照
- **参照基准**：Claude Code（流式看门狗 / 结构化退出条件）、Vercel AI SDK（`stopWhen` 谓词组合）、
  Cline（影子仓库回滚 / 连续失败计数）、Cursor（多文件重构与并行子代理）
- **标记约定**：✅ 已具备 ｜ ⚠️ 部分具备 ｜ ❌ 缺失 ｜ 🔧 进行中 ｜ ⏸ 暂缓
- **编号约定**：改进项用 **`IMP-xx`** 独立序列，与 09 文档的 `TS-xxx` 序列**分开编号**，
  避免两套清单互相挤占号码（09 是"在建能力"，本文是"待补差距"）
- **证据口径**：行号为 **2026-10-10** 核查时点，会随后续改动漂移；
  **以标识符 / 函数名检索为准**，行号仅作定位辅助
- 日期：2026-10-10

---

## 0. 结论先行

### 0.1 五条能力判定总表

| # | 能力诉求 | 判定 | 一句话结论 |
|---|---|---|---|
| 1 | 多文件大型项目重构，不大量瞎编 | ⚠️ | 中小规模（数个文件、单文件 < 200KB）靠谱；跨几十个文件明显退化 |
| 2 | 跑失败后自动复盘、重试修正 | ❌ | 只有"把错误回灌给模型让它自己改"，**无系统级自动闭环** |
| 3 | 完善沙箱，防止工具误删本地文件 | ⚠️ | 三层防护都在，但**最危险的 shell 通道恰好是三层里最弱的一层** |
| 4 | 兼容 MCP、可加载外部 skill 插件 | ⚠️ | **兼容，但是"最小可用子集"**；协议面与工具治理都不完整 |
| 5 | 批量处理 Excel/Word/PPT，输出可交付 | ⚠️ | **能出稿，不能交货**——排版停在骨架级，且无批量通道 |

**没有一条可以完整打勾。**

### 0.2 前提：两套内核的能力是**互补**的，不是叠加的

这一条必须写在最前面，否则后面所有判定都会被误读。

| 能力位 | TS 内核（`agent-ts`） | Python 内核（`evawork`） |
|---|---|---|
| MCP 传输 | 仅 stdio | stdio + streamable-http + sse |
| MCP 协议版本协商 | 写死 `2024-11-05`，无回退 | `2025-06-18 → 2024-11-05` 回退 |
| MCP 断线重连 / 进程树清理 | 无 / 无（只 kill 顶层） | 有 / 有 `_kill_tree` |
| MCP 工具数量治理 | **无**（全量下发） | `select_tools` Top-24 + 每插件代表席位 |
| 办公文档生成（docx/xlsx/pptx/pdf） | **有**（4 个工具 + 15 条自检） | **无**（requirements 里没有 office 库） |
| Skill 元数据（`allowed-tools`、脚本工具） | 无 | 有 |
| Skill zip 导入 + 安全扫描 | 无 | 有 |

界面上 `agentChoice` 是**二选一**（`.docs/09` §1.1）。因此：

> **选了 TS 内核就拿不到 Python 的 MCP 能力，选了 Python 内核就拿不到文档生成能力。**
> 这不是"两套都差一点"，而是"两套各差另一半"。判定为 ⚠️ 的四条里，有相当部分是这个结构性问题的后果。

### 0.3 一句话概括现状

**能跑、能回滚、有边界；但缺自动闭环（复盘重试）、缺排版（交付级文档）、缺强制边界（默认配置下 shell 不受限）。**

---

## 1. 缺口一：多文件大型项目重构，不大量瞎编（⚠️）

### 1.1 已经具备的（✅）

| 能力 | 证据 |
|---|---|
| `patch` 精确替换 + **唯一性校验** | `tools.ts` `old` 出现 0 次报 `old 未找到`；N 次报 `old 出现 N 次，必须唯一；请把 old 写得更长以定位到唯一位置`——**不猜**（现 `tools.ts:436-437`） |
| 提示词强制优先 patch | `prompt.ts` —— `改文件优先用 patch（精确替换，old 必须唯一，比整文件覆写安全得多）` |
| 路径越界一律拒绝 | `resolveInWorkspace` / `SandboxError` |
| 写前快照 → 可按步撤销 | `checkpoint.ts` 影子 git 仓库，落盘 `index.json`，会话结束后仍可撤销 |
| 隔离副本，先改后合 | `isolate.ts`，副本落在 `<ws>/.evawork/isolates/`，合回前先留回滚点 |
| 大输出溢出到磁盘 | `spill.ts` >8000 字符落 `.eva-spill/`，只回前 1200 字符 + 路径 |
| 循环卫生（防原地打转） | `guard.ts` 同名同参数 warn@3 / stop@5 |

### 1.2 缺口（按严重度）

| # | 缺口 | 证据 | 后果 |
|---|---|---|---|
| G1.1 | **`write_file` 整文件覆写，零守卫** | `tools.ts` `write_file`（接受完整 content，无大小校验、无"文件已存在"校验） | 不校验读完是否被改过、不校验长度、不做语法检查——大文件重构的主要瞎编入口 |
| G1.2 | **无"先读后写"硬约束** | 无 staleness / etag 检查 | 可基于过时内容覆写；两个子任务改同一文件时互相覆盖 |
| G1.3 | **无写入后校验环节** | `src/` 内搜 `tsc`/`eslint`/`mvn` 无实现（仅注释与原生模块构建说明） | 验证只能靠模型自己发 `run_command`，是**自愿的**；改坏了不会自动发现 |
| G1.4 | **上下文压缩吞掉刚读过的大文件，且不提醒模型** | `context.ts` 单条工具输出先掐头去尾到 4000 字符，再整轮丢弃直到不超预算（保最近 4 轮）；丢弃后只留一句 `【上下文压缩】早期 N 轮已从上下文中移除`，**该提示只推给 UI，不进模型上下文** | 第 3 步读的文件内容，第 20 步在模型手里只剩省略号 → 后续 `patch` 拿着省略号改文件，**这是瞎编的主要来源** |
| G1.5 | **无跨文件引用检查** | 只有字面 `grep`（上限 300 条、深度 ≤8、跳过 `node_modules` 等）与 `list_dir`（上限 300） | 改了 A 但 B 仍在用旧名，全靠模型自觉核对；无 rename/move 原子操作 |
| G1.6 | **`read_file` 无分页参数** | `read_file` >200,000 字节直接拒绝，且**没有 offset/limit** | 而 `spill.ts` 建议模型"按行区间读"——**这个建议当前做不到**，自相矛盾 |
| G1.7 | **`delegate` 串行，无并行 fan-out** | `loop.ts` `for (const c of calls)` 严格串行；`delegate` 一次只接一个 `goal` | 多文件重构无法分片并行；子代理轮次上限 6、硬顶 12，且共享同一 workspace |
| G1.8 | **方法论层是空的** | 全仓无 `AGENTS.md`；TS 的 `skill.ts` 只从 `~/.evawork/skills`、`<ws>/.evawork/skills`、`<ws>/.eva-skills`、`<ws>/skills` 发现 | Python 侧 `builtin_skills/` 里的 `verification-before-completion`、`retro`、`subagent-driven-development`、`dispatching-parallel-agents`、`writing-plans` 对 TS 内核**默认不可见** |

### 1.3 改进任务

| 编号 | 任务 | 方案要点 | 改动位置 | 验收判据 | 量级 |
|---|---|---|---|---|---|
| IMP-01 | **先读后写硬约束** | `read_file` 时记录 `(path → sha1)`；`write_file`/`patch` 落盘前比对，不一致则拒绝并报"文件在你读取后被改过，请重读"（提供 `--force` 语义但默认拒绝） | `tools.ts` + 新增会话内 read-cache | 自检：读→外部改→写，被拒且错误文本指明原因 | M |
| IMP-02 | **写入后自动校验 + 失败回滚** | 项目类型探测（`package.json`→tsc、`pom.xml`→mvn 等）；写类工具执行后自动跑一次校验命令；失败则**自动撤销本步 checkpoint** 并把编译错误回灌模型 | `tools.ts` / `loop.ts` / `checkpoint.ts` | 自检：故意写坏一个 ts 文件 → 自动回滚且错误进上下文 | L |
| IMP-03 | **`read_file` 支持 offset/limit 分页** | 加 `offset` / `limit`（按行），超限文件时**返回提示"文件共 N 行，请用 offset/limit 分段读"**而不是直接拒绝 | `tools.ts` | 自检：>200KB 文件可按区间读出正确内容 | S |
| IMP-04 | **压缩不再静默吞证据** | 压缩发生时，向**模型**回灌一条 system 消息：说明哪些步的工具输出被截断/丢弃、涉及哪些路径；而不是只推给 UI | `context.ts` / `loop.ts` | 自检：触发压缩后，下一条发给模型的 messages 含该提醒 | M |
| IMP-05 | **引用检查（先做轻量版）** | `rename` / `move` 工具（走 `writeText` 归入回滚点），内部先 `grep` 全量引用并**在结果里列出待改引用**；不自动改，交给模型逐处确认 | `tools.ts` | 自检：rename 后返回引用清单 | M |
| IMP-06 | **`delegate` 并行 fan-out** | `delegate` 接受 `goals: string[]`，并发 `Promise.all` 跑子代理；每个子代理配**独立 isolate 副本**避免互相踩 | `subagent.ts` / `loop.ts` / `isolate.ts` | 自检：3 个 goal 并发，总耗时 < 串行；各自改动不互相覆盖 | L |
| IMP-07 | **补齐方法论层** | ① 仓库根放 `AGENTS.md`（`rules.ts` 已支持分层读取，只是没文件）；② 让 TS 的 `skill.ts` 能发现 Python 侧 `builtin_skills/`（或把那份文档复制进 TS 可发现目录） | 仓库根 + `skill.ts` | 自检：`discoverSkills()` 能列出 verification-before-completion 等 | S |

---

## 2. 缺口二：跑失败后自动复盘、重试修正（❌）

**这是五条里唯一一条"基本没有"的。**

### 2.1 已经具备的（✅）

| 能力 | 证据 |
|---|---|
| 失败文本**原样回灌**模型 | 工具失败 `执行失败：${res.error}`、命令非零退出 `退出码 N`、被审批/沙箱拒 `未执行：${reason}`，均作为 `role:"tool"` 消息进上下文 |
| 循环卫生会提示"换个做法" | `guard.ts` 判重后追加 `[循环卫生] …请换个做法` |
| 计划/待办真实存在并挂会话 | `plan.ts` `todo_write` / `todo_read`，最多 20 条，状态存事件日志，跨 turn 保留 |
| 模型级降级链（唯一自动"再来一次"） | `llm.ts` 一个 token 都还没吐出时换下一个候选模型 |

### 2.2 缺口

| # | 缺口 | 证据 | 后果 |
|---|---|---|---|
| G2.1 | **工具 / 子代理 / 整轮三级，零自动重试** | 每个 tool call 只执行一次；`subagent.ts` 只跑一次 `runTurn`；turn 停止后只上报 `stopReason` | 偶发失败（网络抖动、文件锁）直接终止任务 |
| G2.2 | **无错误分类** | 无"可重试 / 不可重试"判定，无 backoff | 要么全重试（浪费），要么全不重试（现状） |
| G2.3 | **模型通道 error 直接终止 turn** | `loop.ts` 收到 `error` chunk 即 `break`，`stopReason="error"`，**错误不进上下文** | 模型看不到自己刚犯的错 |
| G2.4 | **无复盘 / 自评 / 达成度判定** | 全 `src/` 搜 `reflect`/`critique`/`自评`/`复盘` **无实现** | 任务结束即结束，不判断是否真达成目标 |
| G2.5 | **待办不核对完成度** | `plan.ts` 的 `render()` 只负责展示，无代码在收尾前检查 items 是否全 done | 全部标 done 但实际没改，系统不拦 |
| G2.6 | **无长期记忆** | 无 `memory.ts`；`storage.ts` 仅被 `settings.ts` 与 `modelprobe.ts` 使用 | 失败经验不跨会话沉淀，**同一个坑下次重踩** |
| G2.7 | 失败信息缺统一"原因 + 建议"包装 | 只有几个孤例（patch 唯一性、受限令牌 0xC0000142、工具名不存在时列清单） | 模型拿到的常是裸错误串，自己猜怎么改 |

> 注意：提示词里反而**禁止**模型盲重试（`prompt.ts` —— `被拒绝时…不要原样重试`）。
> 这条是对的，但也说明现状的设计意图就是"把判断权交给模型"，不是"系统兜底"。
> IMP-08 要加的自动重试必须与这条**不冲突**：只在**判定为可重试的错误**上重试，不是无脑重跑。

### 2.3 改进任务

| 编号 | 任务 | 方案要点 | 改动位置 | 验收判据 | 量级 |
|---|---|---|---|---|---|
| IMP-08 | **工具级自动重试 + 错误分类** | 新增 `isRetryable(err)`：网络类/超时/文件锁 → 可重试；语法错误/权限拒绝/参数非法 → 不可重试。可重试的最多重试 2 次，指数退避（500ms/2s）。**被审批/沙箱拒的动作不重试**（那是安全问题，重试=骚扰用户） | `loop.ts` + 新增分类函数 | 自检：① 注入一次失败后成功的假工具 → 自动重试并成功；② 被拒动作只调一次 | M |
| IMP-09 | **模型 error 回灌上下文** | `loop.ts` 收到 error chunk 时，把它作为一条消息 push 进 messages 再决定要不要继续（而不是直接 break） | `loop.ts` | 自检：error 后下一轮 messages 含该错误 | S |
| IMP-10 | **失败原因结构化包装** | 统一格式：`原因：<what>` / `依据：<evidence>` / `可选下一步：<suggestions>`，由工具层产出；把现有的几个"写得好"的孤例收敛成同一套 | `tools.ts` + 各工具错误分支 | 自检：若干工具失败均含三段结构 | M |
| IMP-11 | **收尾前核对待办完成度** | turn 结束前检查 `plan.items`：存在非 done/cancelled 项时，note 追加"待办还有 N 项未完成"，且 `stopReason` 不报 `completed`（报 `max_steps` 或新增语义更准的原因） | `loop.ts` / `plan.ts` | 自检：未完成的待办 → turn/end 的 stop 不是 completed | S |
| IMP-12 | **长期记忆（失败经验库）** | 落盘 `~/.evawork/ts-agent/memory.json`：键 = `工具名 + 错误特征`，值 = 上次怎么解决的；`prompt.ts` 注入相关条目（按当前工具集过滤，不全量注入） | 新增 `memory.ts` | 自检：记住一条经验，下次同类错误命中且被注入 | M |
| IMP-13 | **复盘环节（可选，后置）** | turn 结束后追加一个自评 step：让模型回答"目标是否达成 / 哪些没做 / 是否要继续"，结果进 `turn/end.note` | `loop.ts` | 自检：开启后 turn/end 含自评结论 | M |

---

## 3. 缺口三：完善沙箱，防工具误删本地文件（⚠️）

### 3.1 已经具备的（✅）—— 三层防护都在

| 层 | 能力 | 证据 |
|---|---|---|
| 边界 | 沙箱三档，语义来自**契约文件**而非硬编码 | `shared/agent-contract.json` 的 `sandbox` 段；`sandbox.ts` `constructor(mode = "workspace-write")`，默认档有自检钉住 |
| 边界 | 路径越界拒绝（`../`、其它盘符、Unix 绝对路径、UNC） | `sandbox.ts` `resolveInWorkspace`，三类越界均有自检断言 |
| 审批 | **fail-closed**：无人应答 / 应答抛错 / 未知档位 → 一律 deny | `approval.ts` |
| 审批 | 审批超时 120s，超时按拒绝并发通知 | `sdk.ts` `APPROVAL_TIMEOUT_MS`（可用 `EVA_TS_APPROVAL_TIMEOUT_MS` 覆盖） |
| 审批 | 沙箱检查**排在**审批之前 | `tools.ts` `preExecute`：沙箱不许写 → 先问"仅这次放行？"，无人应答 → 拒绝 |
| 回滚 | 影子 git 仓库，**绝不碰用户自己的 `.git`**（防 Cline issue #5598） | `checkpoint.ts` 头部注释 |
| 回滚 | 落盘 `index.json`（tmp+rename 防半截），**会话结束后仍可撤销** | `checkpoint.ts` |
| 回滚 | 隔离副本先改后合，合回前先留回滚点 | `isolate.ts` |
| 兜底 | **没有 `delete_file` 工具** | `tools.ts` 无 delete/remove/rm 类工具，无 `rmSync`/`unlinkSync` 调用 |

### 3.2 缺口

| # | 缺口 | 证据 | 后果 |
|---|---|---|---|
| G3.1 | **默认配置下 shell = 完整用户权限的 `cmd.exe /c`** | Windows 受限令牌+ACL（`sandbox-win.ts` + 原生 `sandbox_win.cc`）确实实现了，但 `restrictedEnabled()` **要求 `EVA_TS_WIN_SANDBOX === "1"`**（现 `sandbox-win.ts:63-65`）；不开就走 `runPlain` | **最危险的通道默认没有强制边界**，`rm -rf` / `del /s` 只有审批拦 |
| G3.2 | **无命令黑名单/风险分级** | `run_command` / `terminal` 除"命令为空"外无任何内容检查 | 破坏性命令与 `ls` 同一档 |
| G3.3 | **回滚不覆盖 `run_command` / `terminal`** | `checkpoint.ts` 头部第 6 条自述：`只覆盖写文件类工具：run_command / terminal 造成的变化不在范围内` | **最危险的那条通道，恰好是回滚罩不住的那条** |
| G3.4 | **无符号链接 / realpath 校验** | 全 `src/` 无 `realpath` / `lstat` / `isSymbolicLink` 调用 | 工作区内放一个 junction 指向界外，"界内路径"就写到界外 |
| G3.5 | **撤销粒度是整步，不是单文件** | `checkpoint.ts` `undo(id)` 一次恢复该步全部文件；冲突检测是**整体拒绝**（任一文件 `sha_after` 不符就一个都不撤） | 保守但会"撤不动" |
| G3.6 | **`ApprovalGate` 自身无超时** | 超时只实现在 `sdk.ts` 的 serve 路径 | 未来新增宿主若不自行封装 timeout 会永久挂起 |
| G3.7 | **`restrictToWorkspace()` 未在生产路径调用** | `preExecute` 只用 `canWrite()`/`canNetwork()`；文件工具无条件调 `resolveInWorkspace` | `danger-full-access` 档下文件工具仍被工作区约束，**档位语义与实现不一致** |
| G3.8 | 进程树残留 | `run_command` 超时只 kill 直接子进程 | 超时后子进程的子进程仍在跑 |
| G3.9 | 隔离副本落在工作区内部 | `<ws>/.evawork/isolates/`，且 `SKIP_DIRS` 跳过 `.git`/`node_modules`、单文件 20MB、总量 2GB | shell 命令能直接破坏副本；副本未必完整 |

### 3.3 改进任务

| 编号 | 任务 | 方案要点 | 改动位置 | 验收判据 | 量级 |
|---|---|---|---|---|---|
| **IMP-14** | **受限令牌默认开启** | 把 `EVA_TS_WIN_SANDBOX` 默认值从"未设=关"改为"未设=开"（保留显式 `=0` 关闭）；并把原生模块**构建进打包产物**（当前需人工 `npm run build:native`，否则该注释明说"命令子进程不受写限制"） | `sandbox-win.ts` / `tools.ts` / 打包脚本 | 自检：默认环境下 `run_command` 写工作区外被 OS 拒绝 | M |
| **IMP-15** | **符号链接 / realpath 校验** | `resolveInWorkspace` 增加 `fs.realpathSync` 校验：真实路径也要落在工作区内 | `sandbox.ts` | 自检：工作区内 junction 指向界外 → 拒绝 | S |
| **IMP-16** | **命令风险分级** | 新增 `classifyCommand(cmd)`：破坏性（rm -rf / del /s / format / 磁盘写）→ **强制 deny 或强制 ask 且不可被 `auto`/`full` 档豁免**；网络类 → 过出口管控；只读类 → 放行 | 新增模块 + `tools.ts` | 自检：`rm -rf` 在 full 档下仍被拦 | M |
| IMP-17 | **回滚覆盖 shell** | 方案 A（推荐）：破坏性/写类命令**强制走 isolate 副本**，合回前可 diff；方案 B：命令执行前后对受影响目录做一次快照（成本高，作为兜底） | `tools.ts` / `isolate.ts` | 自检：`run_command` 删文件后可撤销 | L |
| IMP-18 | **`ApprovalGate` 自带超时** | 把超时从 `sdk.ts` 下沉到 `ApprovalGate`（默认 120s，可注入），所有宿主自动获得 | `approval.ts` / `sdk.ts` | 自检：不设 responder 也不挂起 | S |
| IMP-19 | **单文件撤销粒度** | `undo` 增加可选 `paths` 参数，只恢复指定文件 | `checkpoint.ts` | 自检：一步改 3 个文件，只撤 1 个成功 | M |
| IMP-20 | **`restrictToWorkspace()` 接线** | 在 `preExecute` 里按档位调用；`danger-full-access` 档下**放行界外写**（对齐契约语义），其余档限制在工作区 | `tools.ts` | 自检：各档行为与契约一致 | S |

> **IMP-14 是本清单里性价比最高的一项**：改一个默认值 + 打包时带上原生模块，
> 就能堵住"默认配置下 shell 无强制边界"这个最大的洞，且不牵动主循环。

---

## 4. 缺口四：兼容 MCP、可加载外部 skill 插件（⚠️）

### 4.1 已经具备的（✅）

| 能力 | 证据 |
|---|---|
| 自研 MCP 客户端（不依赖 SDK） | `mcp.ts`（约 167 行）：`initialize` / `notifications/initialized` / `tools/list` / `tools/call` |
| 握手失败跳过不崩 | `tools.ts` catch 后记 stderr 继续下一个；自检用 `process.exit(1)` 的假服务断言"起不来被跳过且返回 0" |
| 清理入口 | `stopMcp()`，`cli.ts` 与 `sdk.ts` 的 `shutdown` 都调了 |
| 工具名规范 | `mcp__<server>__<tool>`（Python 侧是 `mcp:<server>:<tool>`，两边风格不同） |
| Skill 支持外部目录 | `skill.ts` 四个发现路径，含 `~/.evawork/skills`（可用 `EVAWORK_SKILL_DIR` 覆盖）与项目内目录 |
| Skill 只入索引、按需加载正文 | 系统提示词只放名字+摘要，正文 `MAX_BODY = 20000` 截断 |

### 4.2 缺口

| # | 缺口 | 证据 | 后果 |
|---|---|---|---|
| G4.1 | **MCP 工具绕过沙箱** | MCP 工具默认 `action:"command"`（`tools.ts` 注释说明：协议不携带风险元数据）；而 `preExecute` 的沙箱分支只在 `write`/`network` 时触发 → `command` 档**整段沙箱检查被跳过**；契约里 `full` 档是 `on_risky:"allow"` | 选 full 档时，MCP 工具在**任何沙箱档**下自动放行；子进程还继承完整 `process.env`、不走路经沙箱 |
| G4.2 | **只有 stdio 一种传输** | `McpServerConfig` 只有 `name/command/args/env`，**没有 `transport`/`url` 字段** | 接不了任何远程/托管型 MCP |
| G4.3 | **协议版本写死，无协商** | `mcp.ts` `const PROTOCOL_VERSION = "2024-11-05"` | 服务端要求 `2025-06-18` 时直接握手失败被跳过，且只在 stderr 留一行 |
| G4.4 | **协议面只覆盖 tools** | 无 `resources/list` / `resources/read` / `prompts/*` / `sampling` / `roots` | 只能"给工具"，不能"给资源与提示词模板" |
| G4.5 | **工具数量零治理** | 对每个 server 的每个 tool 全量 `defineTool`；`openaiSchemas` 全量下发；`usage.ts` 只把 mcp token 单列**上报，不裁剪** | 挂几个大 server（filesystem+github+playwright 动辄上百工具）会实打实挤爆上下文，且无自动裁剪 |
| G4.6 | 清理不狠、无重连 | `stop()` 只 kill 顶层进程；无断线重建 | 一个 server 中途崩了，其工具**永久失效** |
| G4.7 | **Skill 能力是 Python 侧的真子集** | 无 front-matter `allowed-tools`（无工具白名单）、无脚本工具注册、无 `/name` 唤起、无 zip 导入与市场、无导入安全扫描、`loadSkill` 每次重跑 `discoverSkills`（无 mtime 缓存） | 外部 skill 只能当"说明书"，不能带工具 |
| G4.8 | 两侧 MCP 配置不是同一份真相源 | TS 用 `~/.evawork/ts-agent/mcp.json`，Python 用 KV `mcp:servers`；靠 `desktop-node/src/mcp.js` **手工投影**兜住 | 是投影，不是同源；有漂移风险 |

### 4.3 改进任务

| 编号 | 任务 | 方案要点 | 改动位置 | 验收判据 | 量级 |
|---|---|---|---|---|---|
| **IMP-21** | **MCP 工具纳入沙箱** | MCP 工具不再一律 `command`：按 server 配置声明 `action`（默认仍 command，但**允许用户在 mcp.json 里声明为 write/read**）；且 `command` 档也要过 `canWrite()` 检查（`full` 档豁免需显式确认） | `tools.ts` / `mcp.ts` / `mcp.json` schema | 自检：read-only 档下 MCP 写工具被拒 | M |
| **IMP-22** | **工具数量治理** | 照抄 Python 侧已被实测教训验证过的做法：`DEFAULT_MCP_LIMIT = 24` Top-N + **每个 server 保留 1 个代表席位** + 语义相关度排序；`openaiSchemas` 支持 `only` 收窄 | 新增选择函数 + `loop.ts` / `tools.ts` | 自检：挂 100 个工具时下发的 schema ≤ 24 + server 数 | M |
| IMP-23 | **补 HTTP/SSE 传输 + 版本协商** | 配置结构加 `transport` / `url`；`initialize` 失败时按 `2025-06-18 → 2024-11-05` 回退重试 | `mcp.ts` | 自检：能连一个 http MCP server | L |
| IMP-24 | **进程树清理 + 断线重连** | `stop()` 走进程树 kill；调用失败且进程已死时惰性重建会话 | `mcp.ts` | 自检：kill 掉 server 后下次调用自动重建 | M |
| IMP-25 | **Skill 能力对齐 Python 侧** | 解析 front-matter `name` / `allowed-tools`；支持把技能脚本注册成工具（继承审批+沙箱）；zip 导入 + 导入前安全扫描（防路径遍历）；`loadSkill` 加 mtime 缓存 | `skill.ts` | 自检：`allowed-tools` 收窄生效、zip 导入可用、遍历攻击被拒 | L |
| IMP-26 | **统一 MCP 配置真相源** | 两边读写同一份配置（或以 TS 的 `mcp.json` 为唯一源，Python 侧适配读它），去掉手工投影 | `desktop-node/src/mcp.js` + 两侧 | 自检：一处添加，两个内核都能看到 | M |

---

## 5. 缺口五：批量处理 Excel/Word/PPT，输出可直接交付（⚠️）

### 5.1 已经具备的（✅）

| 能力 | 证据 |
|---|---|
| 四个生成工具 | `tools.ts`：`create_document`(.docx) / `create_spreadsheet`(.xlsx) / `create_slides`(.pptx) / `create_pdf`(.pdf) |
| 进程内生成，无外部依赖 | 动态 import `docx` / `xlsx` / `pptxgenjs` / `pdf-lib` / `@pdf-lib/fontkit`（无需装 LibreOffice） |
| **docx / xlsx 采用"真生成再读回核对"的自检纪律** | `selftest.ts` 办公相关 15 条断言，含读回校验内容与数据 |
| PDF 中文**嵌入字体**，找不到字体时报错而非静默乱码 | `office.ts` `findCjkFont()` + `CJK_FONT_CANDIDATES`，`subset:true` 避免每个 PDF 9MB |
| 文档生成也在回滚点覆盖内 | 落盘统一走 `writeText` |
| 扩展名硬校验 | `.md`/`.txt` 自动改写为 `.docx`，其它后缀报错 |

### 5.2 缺口

| # | 缺口 | 证据 | 后果 |
|---|---|---|---|
| G5.1 | **Excel 能力最致命** | `office.ts` `xlsxFromRows` 只做列宽 + 冻结首行；**无多 sheet、无数字/日期/百分比格式、无公式、无图表、无合并单元格** | 客户要的"报表"直接做不出来 |
| G5.2 | **"表头加粗"注释与实现不符** | `office.ts` `// 表头加粗 + 列宽 + 冻结首行`，但紧随其后的代码只有 `aoa_to_sheet` + `!cols` + `!freeze`，**加粗一行代码都没有** | 说明这块根本没做完；且 `62%` 这类值以字符串写入，Excel 里不是百分比数值 |
| G5.3 | **PPT 无版式/母版/图片/图表/表格** | `pptxFromSlides` 只画标题(28pt)+bullets(16pt)+一条灰色 note，坐标硬编码 | 交付级汇报做不出来 |
| G5.4 | **PPT 坐标疑似画错画布** | x 最大 9.4、note 在 y=6.7，按 4:3（10×7.5in）画的；`pptxgenjs` v4 默认布局若为 16:9（10×5.625in）则 note 与 bullets 下缘会掉出画布（**未实测，依赖未安装，需先验证**） | 可能生成出来就是错位的 |
| G5.5 | **Word 无页眉页脚/目录/页码/图片/字号** | `docxFromMarkdown` 支持六级标题 + 单层列表 + **最多 1 个表格且只能追加在正文末尾** | 写不了带封面/页眉/目录的正式报告 |
| G5.6 | **PDF 是纯文本流** | `pdfFromPages` 固定 A4、11pt、每行 76 字符硬折行、每页 34 行；**不解析 Markdown**（`#` 原样印出）、无标题层级、无表格、无图片 | 只能当"文本打印件" |
| G5.7 | **只有 PDF 处理了中文字体** | docx / xlsx / pptx 均不设置东亚字体，靠 Office 默认主题回退；字体候选路径硬编码 `C:/Windows/Fonts` | 跨机器（对方无中文字体）有字形回退/显示不一致风险 |
| G5.8 | **无批量通道** | 全仓搜 `批量`/`batch` **0 命中**；每工具一次只产出一个文件；`job_start` 只接受 `command` 字符串（跑命令不是跑工具）；`delegate` 子代理明确"不写文件" | 批量 20 份 = 20 次串行调用，卡在 **5 分钟单步超时 / 15 分钟单轮时限**上，且**无续写分片机制** |
| G5.9 | **无 round-trip 改写** | `read_document` 只支持 .docx/.xlsx（**不能读 PPT 和 PDF**），读出来是纯文本；要"改"只能整体覆盖重建 | "改现有 Excel"实际不可行——改完就是一份新骨架文档，原格式全丢 |
| G5.10 | **pptx 无读回校验** | 15 条自检里 pptx 只断言"返回 ok 且输出含标题"，无读回、无字节校验 | 生成错了发现不了 |
| G5.11 | **Python 侧办公能力为零** | `requirements.txt` 无 python-docx / openpyxl / python-pptx / reportlab | 选 Python 内核就完全没有文档能力 |

### 5.3 改进任务

| 编号 | 任务 | 方案要点 | 改动位置 | 验收判据 | 量级 |
|---|---|---|---|---|---|
| **IMP-27** | **Excel 补齐（最高优先）** | 多 sheet（入参改为 sheets 数组）；单元格格式（数字/日期/百分比/货币）；公式；**顺带修掉"表头加粗"**（注释与实现对齐）；条件格式与图表可后置 | `office.ts` / `tools.ts` | 自检：生成多 sheet + 百分比数值，读回校验 `62%` 是数值不是字符串 | M |
| **IMP-28** | **PPT 版式与混排** | 支持 `layout` 选择、母版、图片、表格、图表；**先实测当前 16:9 下的坐标是否越界**（G5.4），按实测结果定画布 | `office.ts` | 自检：pptx 读回校验（一并补 G5.10）+ 打开后元素在画布内 | M |
| IMP-29 | **Word 正式排版** | 页眉页脚、页码、目录（TOC）、图片、字号/字体、多表格（不再只能在末尾） | `office.ts` | 自检：读回校验页眉与目录字段存在 | L |
| IMP-30 | **PDF 排版** | 走"Markdown → 结构化 → 绘制"而不是纯文本流：标题层级、加粗、表格、图片；或先生成 docx 再转 PDF（需评估转换依赖） | `office.ts` | 自检：生成的 PDF 含标题字号差异 | L |
| IMP-31 | **docx/xlsx/pptx 设东亚字体** | 统一设 `eastAsia` 字体名，与 PDF 的 `findCjkFont` 复用同一套候选 | `office.ts` | 自检：docx XML 含东亚字体声明 | S |
| **IMP-32** | **批量生成通道** | ① `create_document` 等支持多文档入参（或新增 `create_documents`）；② 让 `job_start` 能承接**工具调用**而非只有 command，把批量生成放后台跑并回进度 | `tools.ts` / `jobs.ts` | 自检：一次调用产出 10 份文档且不触发单轮超时 | L |
| IMP-33 | **round-trip 改写** | 读取时保留结构（段落样式/表格结构），提供"在原文档上改"的路径而非整体重建 | `office.ts` | 自检：读一个带格式的 xlsx 再写回，格式保留 | L |
| IMP-34 | **pptx / pdf 读回自检** | 补齐与 docx/xlsx 同级的读回校验纪律 | `selftest.ts` | 自检条数 +2 | S |

---

## 6. 改进任务总表（按优先级）

工作量：S ≈ 半天内 ｜ M ≈ 1–2 天 ｜ L ≈ 3 天以上（粗估，用于排序，不作为排期承诺）

### P0 —— 配置/小改就能堵住大洞，优先做

| 编号 | 任务 | 量级 | 为什么是 P0 |
|---|---|---|---|
| IMP-14 | 受限令牌默认开启 + 打包带上原生模块 | M | 改默认值即可堵住"默认 shell 无强制边界"这个最大安全洞 |
| IMP-16 | 命令风险分级（破坏性命令强制拦） | M | 与 IMP-14 配套，否则仍只有审批拦 `rm -rf` |
| IMP-15 | realpath / 符号链接校验 | S | 一行校验堵住"界内路径写到界外" |
| IMP-11 | 收尾前核对待办完成度 | S | 极小改动，直接消除"全标 done 但实际没做" |
| IMP-18 | `ApprovalGate` 自带超时 | S | 消除未来新宿主挂起的隐患 |
| IMP-20 | `restrictToWorkspace()` 接线 | S | 消除档位语义与实现不一致 |

### P1 —— 直接对应"能力打不了勾"的四条

| 编号 | 任务 | 量级 | 对应缺口 |
|---|---|---|---|
| IMP-27 | Excel 补齐多 sheet / 格式 / 公式（+修表头加粗） | M | 五 · 最容易被用户当场发现的能力缺失 |
| IMP-28 | PPT 版式与混排（含先实测坐标） | M | 五 |
| IMP-08 | 工具级自动重试 + 错误分类 | M | 二 · 唯一"基本没有"的那条 |
| IMP-09 | 模型 error 回灌上下文 | S | 二 |
| IMP-01 | 先读后写硬约束 | M | 一 · 压住瞎编两大来源之一 |
| IMP-04 | 压缩不再静默吞证据 | M | 一 · 压住瞎编另一大来源 |
| IMP-21 | MCP 工具纳入沙箱 | M | 四 · 堵绕过口子 |
| IMP-22 | MCP 工具数量治理 Top-N | M | 四 · 防止上下文被 MCP 挤爆 |
| IMP-03 | `read_file` 分页 | S | 一 |
| IMP-31 | docx/xlsx/pptx 设东亚字体 | S | 五 |
| IMP-34 | pptx / pdf 读回自检 | S | 五 |

### P2 —— 结构性补强，可后置

| 编号 | 任务 | 量级 |
|---|---|---|
| IMP-02 | 写入后自动校验 + 失败回滚 | L |
| IMP-05 | 引用检查（rename/move + 引用清单） | M |
| IMP-06 | `delegate` 并行 fan-out + 独立副本 | L |
| IMP-07 | 补齐 `AGENTS.md` 与内置技能可见性 | S |
| IMP-10 | 失败原因结构化包装 | M |
| IMP-12 | 长期记忆（失败经验库） | M |
| IMP-13 | 复盘环节 | M |
| IMP-17 | 回滚覆盖 shell（强制走 isolate） | L |
| IMP-19 | 单文件撤销粒度 | M |
| IMP-23 | MCP 补 HTTP/SSE + 版本协商 | L |
| IMP-24 | MCP 进程树清理 + 重连 | M |
| IMP-25 | Skill 能力对齐 Python 侧 | L |
| IMP-26 | 统一 MCP 配置真相源 | M |
| IMP-29 | Word 正式排版 | L |
| IMP-30 | PDF 排版 | L |
| IMP-32 | 批量生成通道 | L |
| IMP-33 | round-trip 改写 | L |

---

## 7. 非目标（明确不做）

| 项 | 理由 |
|---|---|
| 统一编排层 / 任务在两个内核间互转 | `.docs/09` §1.2 已定为非目标，本文不从后门引入 |
| 自研 MCP SDK（替换自研客户端） | 现客户端 167 行、零依赖、跑得通；换 SDK 的收益（完整协议面）应优先用 IMP-23 按需补齐，而不是整体重写 |
| 自研文档渲染引擎 | 复用成熟库（`docx`/`xlsx`/`pptxgenjs`/`pdf-lib`），只在库能力不足处补排版 |
| 幻觉检测 / 内容 grounding 校验 | 成本极高且无成熟方案；用 IMP-01/02/04 从"证据不丢、写完校验"上降低发生率，不做检测 |
| 给 MCP 工具做自动风险推断 | 协议不携带风险元数据，自动推断不可靠；IMP-21 走"默认 command + 允许显式声明" |

---

## 8. 验收口径（什么叫"补齐了"）

每条缺口都给出一个**可跑出来的判据**，不用主观评价：

| 缺口 | 验收实验 |
|---|---|
| 一 · 多文件重构 | 在一个 ≥ 20 个文件、互相有引用的真实工程上，下达"把 `FooService` 重命名为 `BarService` 并更新所有引用"；**全量编译通过且无残留旧名引用**，全程无 `write_file` 造成的整文件损坏 |
| 二 · 复盘重试 | 注入一个"第一次失败、第二次成功"的假工具：`turn/end` 为 `completed`，且事件流里能看到一次重试；注入"权限被拒"，只调用一次（不重试骚扰用户） |
| 三 · 沙箱防误删 | 默认配置（不设任何 env）下，让模型执行 `rm -rf` 等价操作：被拦或落在副本上；执行 `run_command` 删掉一个工作区文件后，能撤销恢复 |
| 四 · MCP / skill | 挂一个 100 工具的 MCP server：下发给模型的 schema ≤ 24 + server 数，任务正常跑完不挤爆上下文；在 read-only 档下 MCP 写工具被拒；导入一个带 `allowed-tools` 的 skill 包，工具集被收窄 |
| 五 · 办公交付 | 生成一份"含多 sheet、百分比数值、公式"的 xlsx 与一份"含母版、图片、图表"的 pptx；在 Office 里打开，**不需要人工排版即可直接发给客户**；批量 20 份不触发单轮超时 |

---

## 9. 与既有文档的关系

| 文档 | 分工 |
|---|---|
| `09_EvaWork TS智能体任务清单.md` | **在建能力**的规格与任务分解（TS-xxx 序列） |
| 本文（11） | **待补差距**的清单（IMP-xx 序列），不重复描述 09 已完工部分 |
| `08_EvaWork 插件市场PRD任务清单.md` | 插件市场形态；本文 IMP-25（skill zip 导入 + 安全扫描）与它相接 |
| `10_EvaWork 技能PRD任务清单.md` | 技能机制规格；本文只记 TS 侧相对 Python 侧**缺**的那一半 |

> 本文结论来自 2026-10-10 对当前代码的逐条核对。随着 IMP 项落地，**已完成项应从本文移除并并入 09**，
> 本文只保留"仍然做不到"的部分——清单一旦开始记录已完成的事，就会失去作为差距清单的作用。
