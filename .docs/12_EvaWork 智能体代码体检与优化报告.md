# EvaWork TS 智能体代码体检与优化报告

- **体检对象**：`apps/agent-ts/src/`（TS 内核源码，唯一内核）
- **体检方式**：逐文件通读 `src/*.ts`（29 文件 / 约 6500 行），并与
  `apps/desktop-node/release/win-unpacked/resources/agent-ts/src/`（39 文件，最近一次打包产物）、
  `.docs/09`、`.docs/11`、`apps/agent-ts/README.md` 三方对照
- **体检日期**：2026-10-10
- **证据口径**：以函数名 / 模块名为准（行号会随改动漂移，仅作定位辅助）
- **编号约定**：本报告独立编号 **`RC-xx`（Review-Check）**，不与 `.docs/09` 的 `TS-xx`、
  `.docs/11` 的 `IMP-xx` 混用

---

## 0. 结论先行

**一句话：源码正处于一次未提交的「精简重构」中，删掉了安全网（沙箱 + 审批）、恢复网
（checkpoint/isolate 文件回滚）、结构化文件工具（list/read/write/patch/grep）与整套自检；
而文档（README、.docs/09、.docs/11）与最近一次打包产物都还停留在精简前的更完整版本——
三者已经严重脱节，且被删掉的正是防误删、防瞎编、防失控最关键的几道硬防线。**

三条最重要的结论：

1. **安全从「代码强制的硬防线」退化成了「提示词的软请求」。**
   `tools.ts` 头部明确写下「审批与沙箱路径约束已移除：所有工具一律放行，不再二次确认」。
   `preExecute` 现在是空壳（对任何已注册工具一律返回 `allowed: true, reason: "已放行"`）。
   最高的风险通道 `run_command`/`terminal` 因此以**完整用户权限、无确认、无路径边界**运行。

2. **「子代理 fail-closed」的承诺已经名不副实。** `subagent.ts` 给模型的系统提示词和
   `delegate` 工具描述仍然写着「写文件 / 跑命令 / 联网一律不执行、会被直接拒绝」，
   但真正执行的是同一个 `preExecute`（已放行一切）——子代理实际拥有与主任务同等的全部权限。
   这不是 stale，是**描述与实现的相反**。

3. **三方漂移（源码 / 打包产物 / 文档）已经大到会让人做错判断。** 任何人读 README 或
   `.docs/11` 会以为「有沙箱、有审批、有 198 条自检」；运行打包版也确实如此；但改的是
   **源码**，而源码里这些全没了。下列清单与结论，若按文档去套源码，会全部落空。

---

## 1. 三方漂移对照表（本报告的事实底座）

| 能力 / 模块 | 源码 `apps/agent-ts/src` | 打包产物 `release/.../agent-ts/src` | 文档 `.docs/09` / `.docs/11` / README |
|---|---|---|---|
| 审批闸门 `approval.ts` | ❌ 已删（`preExecute` 一律放行） | ✅ 存在 | ✅「已有 / 已具备」 |
| 沙箱 `sandbox.ts` / `sandbox-win.ts` | ❌ 已删（`types.ts` 注释：命令/文件可在任意路径操作） | ✅ 存在 | ✅「软沙箱 + 加固档」 |
| 文件工具 `list_dir/read_file/write_file/patch/grep` | ❌ 已删（只剩 shell） | ✅ 存在 | ✅「patch 精确替换 + 唯一性校验」 |
| 计划/待办 `plan.ts` | ❌ 已删 | ✅ 存在 | ✅「todo_write/todo_read」 |
| 技能 `skill.ts` | ❌ 已删 | ✅ 存在 | ✅ 详见 `.docs/10` |
| 回滚点 `checkpoint.ts` + 隔离副本 `isolate.ts` | ❌ 已删（office.ts 注释仍称「走 writeText 回滚点」） | ✅ 存在 | ✅「影子 git 仓库 / 隔离副本」 |
| 模型探测 `modelprobe.ts` | ❌ 已删 | ✅ 存在 | — |
| 自检 `selftest.ts`(198) + `selftest-sdk.ts`(22) | ❌ 已删，无替代 | ✅ 存在 | README「198 项 / 22 项」 |
| 办公文档四件套 `office.ts` | ✅ 存在 | ✅ 存在 | ✅ 存在 |

> 上述差异是**事实**，不是推测：源码 `src/` 29 个 `.ts` 文件，打包产物 `src/` 39 个 `.ts`
> 文件，多出的 10 个正是 `approval / sandbox / sandbox-win / checkpoint / isolate / plan /
> skill / modelprobe / selftest / selftest-sdk`。且 `git status` 显示 `apps/agent-ts/` 整体
> **未跟踪**——这是一次尚未提交的重构中间态。

---

## 2. 核心发现（按严重度）

### 2.1 P0 · 安全硬防线被移除，只剩软约束

**现象（源码证据）**

- `tools.ts:1-5`：文件头注释明确「审批与沙箱路径约束已移除：所有工具一律放行，不再二次确认（TS 精简）」。
- `tools.ts:500-514`：`preExecute` 对任何已注册工具都返回 `{ allowed: true, reason: "已放行" }`，
  唯一会拒绝的是「工具名不存在」（顺带回可用名单）。
- `types.ts:68-69`：`ToolContext` 注释「审批与路径约束已移除，命令/文件可在任意路径操作」。
- `terminal.ts:110-111`：`cd`「路径约束已移除：cd 到任意位置都跟随」。

**影响**

- `run_command`（`spawn` 一个 PowerShell/sh 子进程）与持久 `terminal` 完全不受限：任意命令、
  任意 cwd、任意写路径，无人工确认、无路径边界。`rm -rf` 级误操作只有提示词拦。
- 现存唯一的**代码级**硬控制只剩两个：网络出口白名单（`egress.ts`，只拦本进程 http/https），
  以及 `--hardened`（Node permission model，**默认不开**，且开了就禁命令工具）。
- 办公工具 `create_document` 等用 `path.resolve(workspace, args.path)` 落盘
  （见 `tools.ts:571-591`），路径没有「真实路径必须落在 workspace 内」的校验——
  `../../outside/x.docx` 可直接写穿工作区。

**结论**：`.docs/11` 缺口三（完善沙箱防误删）里的「三层防护都在」在当前源码中**已不成立**，
只剩「提示词请求模型别乱删」这一层最弱的。

**建议**

- 若「精简」是有意为之：把决策写进文档，并把 `.docs/11` 的 ⚠️/✅ 口径改回来——不能一边说
  「三层防护都在」一边源码里没有。
- 至少恢复**命令通道的硬边界**：`classifyCommand()`（破坏性命令强制拦/强制确认）+ 命令/文件
  writes 恢复路径约束（`fs.realpathSync` 校验，堵 junction/`../`）。这不必恢复整套沙箱，
  十行级的 realpath 校验 + 一份破坏性命令词表即可显著降低风险。

---

### 2.2 P0 · 「子代理 fail-closed」描述与实现相反

**现象（源码证据）**

- `subagent.ts:126-128`：`delegate` 工具描述仍写「子代理那边写文件/跑命令/联网**一律不执行**，
  会把需要批准的事带回结论里」。
- `subagent.ts:74-77`：子代理的系统提示词仍写「写文件、跑命令、联网这类动作会被**直接拒绝**」。
- 但子代理执行路径就是同一个 `runTurn` → 同一个 `preExecute`，而 `preExecute` 已「一律放行」
  （`tools.ts:500-514`）。子代理实际拿到的是**全量工具 + 全量放行**，仅受两处真正存在的限制：
  - 主编进 `loop.ts:512-521` 的工具子集白名单（仅当 `delegate` 传了 `tools` 参数才生效，不传=全部）；
  - `hardStepLimit`（轮次硬顶）。

**影响**

- 用户看到「子代理不会动你的文件/命令/网络」，实际它完全会，且**没有独立沙箱、没有审批回显**——
  这正是 `.docs/09` 里反复强调要堵的那个「把审批口子开在看不见的地方」的暗道。
- `delegate` 工具的 `action` 标注是 `llm`（非高危），这个设计的前提（子代理 fail-closed）
  在当前源码里**已经不存在**，于是「非高危」判断也随之失去依据。

**建议**

- 立即二选一：恢复子代理的 fail-closed（对 `write`/`command`/`network` 动作在子代理内拒绝并带回），
  或把 `delegate` 的描述与系统提示词改成如实（子代理与主任务同权限）。

---

### 2.3 P0 · 文档与代码严重脱节（README / .docs / 代码注释三方都在说谎）

**现象**

- `apps/agent-ts/README.md:61-64`：列出的 `--policy ask|never`、`--sandbox-status`、自检
  `198 项 / 22 项` 在当前 `cli.ts` **全部不存在**。
- `apps/agent-ts/README.md:68-80`：目录表列的 `sandbox.ts / approval.ts / sandbox-win.ts /
  selftest.ts / loop.ts（旧职责）` 在源码中已删或已改名。
- `apps/agent-ts/README.md:36-43`：整节「零依赖」已作废——`package.json` 已引入 `docx/xlsx/
  pptxgenjs/pdf-lib/jszip/isomorphic-git` 等依赖（`package.json:19` 注释「2026-10-06 起允许引入 npm 依赖」）。
- `apps/agent-ts/README.md:91-97`：整节「当前边界」描述受限令牌那层只限写等，已不适用。
- `.docs/11` 全文把 `sandbox.ts/approval.ts/checkpoint.ts/isolate.ts/plan.ts/skill.ts` 和
  `patch/read_file/write_file` 当作「✅ 已具备」来写差距——这些在当前源码里都不存在，
  导致它列出的「IMP-01~34」里相当一部分是「在已删除的代码上打补丁」。
- 代码注释同样指向已删模块：`guard.ts:4`「见 approval.ts」、`office.ts:26-27`「写盘统一走
  writeText（回滚点快照，TS-060）」、`office.ts:87`「生成文档也能走回滚点」、`spill.ts:48`
  「用 read_file 按行区间读」、`loop.ts:563`「两次 list_dir」、`desktop-node/src/mcp.js:4`
  「Python 后端已删除」的残留说明。

**影响**

- 任何一个新接手者都会照着 README/.docs 去源码里找 `approval.ts` / `selftest.ts`，扑空后
  会怀疑「是不是自己 checkout 错了」；更危险的是**按照文档去判断安全边界**（认为有沙箱），
  而实际没有。
- `spill.ts:48` 建议模型「用 read_file 按行区间读」回收溢出文件，而 `read_file` 已不存在——
  这是一条**自相矛盾**的提示：溢出到磁盘的长输出，模型实际读不回来（只能再跑一条 shell）。

**建议**

- 一次「文档归真」提交：把 README 与代码注释里指向已删模块的词条全部修正；在 `.docs/11`
  顶部加一行「本清单基于精简前架构，`approval/sandbox/checkpoint/isolate/plan/skill/文件工具/
  自检` 已从源码移除，相应 ✅/⚠️ 判定需重审」。

---

### 2.4 P1 · 结构化文件工具缺失，一切文件操作退回 shell

**现象**

- 源码工具清单（`src/` 内全部 `defineTool`）：`set_max_steps / run_command / terminal /
  web_fetch / create_document / read_document / create_spreadsheet / create_slides / create_pdf /
  delegate / job_start / job_status / job_wait / job_cancel`（+ 可选 MCP 外部工具）。
  **没有 `list_dir / read_file / write_file / patch / grep / delete`。**
  打包产物里 `grep:1, list_dir:1, patch:1, read_file:1, write_file:1` 全都还在，源码里已删。

**影响**

- 读文件、列目录、改写文件、全文搜索，模型只能自己 `run_command` 拼 PowerShell。由此失去的正是
  结构化工具体内建的那几道可靠性护栏：
  - 无「先读后写」staleness 校验 → 可基于过时内容覆写（`.docs/11` G1.1/G1.2 的瞎编两大来源仍在，且更糟）；
  - `patch` 的唯一性校验（`old` 必须唯一）没了 → 误替换风险回落到裸 shell；
  - `read_file` 的 offset/limit 分页没了 → 大文件只能整读或 `head`/`Get-Content` 手动分段；
  - 无写入后自动校验（tsc/lint），改坏不发现（`.docs/11` G1.3）；
  - 无 `checkpoint`/`isolate` 文件回滚——**一旦 shell 误删/误覆写，没有撤销通道**。
- 阅读/改写的可靠性与效率显著低于打包版的上一代。

**建议**

- 结构化文件工具对「桌面智能体」是刚需，不建议以 shell 完全替代。至少恢复最小集
  `list_dir / read_file(带分页) / write_file(带 staleness 校验) / grep`，并让 `patch`
  的唯一性校验回来；这四项是该智能体与普通「跑命令的壳」的本质差别。

---

### 2.5 P1 · 无自检、无类型检查、错误与死代码潜伏

**现象**

- `README.md:58-61` 声称的自检 `node src/selftest.ts`（198 项）与 `selftest-sdk.ts`（22 项）
  **源码中已删除**，且全仓（除打包产物）无任何 `.test/`.spec/` 文件或 `test` npm 脚本。
- `package.json` 的 `scripts` 只有 `start / smoke / build:native`——**没有 `typecheck`，也没有
  `test`**。`tsconfig.json` 开着 `strict:true`，但没有任何东西运行 `tsc`。
- 正在潜伏的类型错误：`jobs.ts:267` 用了 `action: "memory_write"`，而 `types.ts:66`
  `ToolAction = "read" | "write" | "command" | "network" | "llm"`——`memory_write` 不在其中，
  `tsc --noEmit` 必然报错，只因没人跑 tsc 而漏过。
- 死代码：
  - `agent.ts`（`DefaultAgent`/`createAgent`，带 inbox/stop/活事件的 driver 抽象）**无人 import**，
    全仓 grep `createAgent/DefaultAgent` 零引用——`cli.ts`/`sdk.ts` 都直接调 `runTurn`，这一层白写。
  - `contract.ts` 的 `isRisky` / `normalizeAction` 无人调用，仅 `loadContract` 被 `sdk.ts:13,229`
    用作「契约来源」展示；风险分类的实际拦截已随审批一起失效。
  - `settings.ts` 的 `Settings.model/workspace/maxSteps` 与 `storage.ts` 基本无人读写（模型/工作区
    一律走环境变量与清单）。

**影响**

- 上一版最值钱的资产——「改一行就有一条自检钉住」的纪律——在精简中一并消失。当前没有任何
  自动化能把回归挡在提交前；`memory_write` 这类错误证明「没人看类型」。
- 死代码增加理解成本：新接手者会以为 `agent.ts`（带 stop/inbox 的事件驱动 driver）是当前形态，
  实际入口根本不经它。

**建议**

- 补一个最小质保：`tsc --noEmit` 接入 CI/脚本（`pnpm --filter @eva/agent-ts typecheck`），
  先把 `memory_write` 这类硬错误清零。
- 把 `agent.ts` 与 `contract.ts` 的 `isRisky/normalizeAction` 要么接回来、要么删掉，不留
  「看着是防线其实是装饰」的代码。

---

### 2.6 P1 · MCP 仍是「最小可用子集」，且工具无治理

（此条 `.docs/11` §4 已列，源码核对后**依旧成立**，这里只记源码证据，不重复其方案。）

- `mcp.ts:41` 协议版本写死 `2024-11-05`，无 `2025-06-18` 回退；仅 stdio 传输，无 http/sse。
- `mcp.ts:120-123` 故意忽略 stderr、`stop()` 只 kill 顶层进程 → 进程树残留、无断线重连。
- `tools.ts` `installMcpTools` 对每个服务每个工具**全量注册**，`openaiSchemas` **全量下发**——无
  Top-N / 每服务代表席位的裁剪（`.docs/11` G4.5），挂几个大服务会实打实挤爆上下文。
- MCP 工具的 `action` 分级（`tools.ts:429` 按 `readOnlyHint`）如今**没有消费方**（审批已删），
  等于标注了也不产生任何拦截。

---

### 2.7 P2 · 其余待办（按影响从高到低）

| 编号 | 发现 | 证据 | 建议 |
|---|---|---|---|
| RC-01 | 模型通道 `error` 直接终止 turn，错误不进上下文 | `loop.ts:483-488` 收 `error` chunk 即 `break`，不 push 回 messages | 把 error 作为一条消息回灌，再决定要不要继续（对齐 `.docs/11` IMP-09） |
| RC-02 | 无工具级自动重试 / 错误分类 | 每个 tool call 只执行一次，`loop.ts:507` 起无重试 | 仅对「可重试」错误重试，被拒/参数错不重试（对齐 IMP-08） |
| RC-03 | 无长期记忆 | 全源码无记忆模块；失败经验不跨会话沉淀 | 可选，`~/.evawork/ts-agent/memory.json`（对齐 IMP-12） |
| RC-04 | 办公 PDF 读取缺失 | `tools.ts:613` 明说「PDF 的读取是另一条链路，本轮没做」；`read_document` 只读 docx/xlsx | 补 PDF 读取或明确「只读不可读 PDF」 |
| RC-05 | web 能力仅 `web_fetch`（去标签粗糙、无搜索、无 Markdown） | `tools.ts:293-324` | 补 `web_search` 或至少把 fetch 输出转结构更可读 |
| RC-06 | `DEFAULT_MAX_STEPS` 注释在 `budget.ts`/`boot.ts` 重复 | `budget.ts:13-19` 与 `boot.ts:46-52` 两份几乎相同的注释块 | 合并为一处，避免改注释漏一处 |
| RC-07 | 模型档位 `LOCAL_TIERS` 硬编码，需人工随平台更新 | `modelcatalog.ts:72-94` 13 个模型的人工档位表 | 文档已自认是「产品判断」，但建议加一个「陌生模型无档位」的显式告警，而非静默回退 |
| RC-08 | 后台任务 `jobs` 纯内存态，进程重启即丢 | `jobs.ts:36-40` `JobRegistry` 仅内存 | 桌面单用户可接受；若需跨重启保留需落盘 |
| RC-09 | `renameSession`/`deleteSession` 直接 append/unlink，绕过 `withLock` | `query.ts:111-131` | 与 `session.ts` 的锁语义统一，避免并发写坏 |
| RC-10 | `context.ts` 压缩提示只推 UI、不进模型上下文，仍可能静默吞证据 | `loop.ts:405-414` + `context.ts:COMPACT_NOTE` | 压缩时向模型回灌一条「哪些路径/哪步被丢弃」（对齐 IMP-04） |

---

## 3. 优化路线图（建议优先级）

> 工作量粗估：S≈半天内，M≈1–2 天，L≈3 天以上。排序依据是「堵住现实风险 / 纠正错误认知」而非模块完整度。

### P0 —— 先纠错、再堵洞（本周做）

| 优先级 | 事项 | 量级 | 理由 |
|---|---|---|---|
| 1 | **子代理 fail-closed 二选一**（恢复拒绝 或 改描述如实） | S | 描述与实现相反，属于「用户在看不见的地方被误导」 |
| 2 | **命令通道硬边界**（realpath 校验 + 破坏性命令词表） | M | 源码当前 shell 无任何强制边界，堵最高危通道 |
| 3 | **文档归真**（README 结构表/自检/零依赖/当前边界 + 代码注释指向已删模块） | S | 消除「读文档判断安全边界」的歧义 |
| 4 | **补 `tsc --noEmit` 接入脚本/CI，清零 `memory_write`** | S | 把类型错误这个最低成本的回归先拦住 |

### P1 —— 恢复能力与质保（随后 1–2 周）

| 优先级 | 事项 | 量级 |
|---|---|---|
| 5 | 恢复最小文件工具集 `list_dir / read_file(分页) / write_file(staleness) / grep / patch` | M |
| 6 | 模型 error 回灌（RC-01）+ 可重试错误自动重试（RC-02） | M |
| 7 | 压缩回灌模型（IMP-04）+ spill 文件可读回 | M |
| 8 | MCP 工具数量治理（Top-N + 每服务代表） | M |
| 9 | 死代码清仓：`agent.ts` 接回或删除、`contract.ts` 未用的 `isRisky/normalizeAction` 删除或接线 | S |

### P2 —— 结构补强（后置）

| 优先级 | 事项 | 量级 |
|---|---|---|
| 10 | 长期记忆、复盘环节 | M |
| 11 | MCP http/sse 传输 + 版本协商 + 进程树清理/重连 | L |
| 12 | 办公室文档排版补齐（Excel 多 sheet/格式、PPT 版式、PDF 结构化） | L |
| 13 | 后台任务跨重启、`rename/delete` 与锁统一 | M |

---

## 4. 一句话给决策者

源码这次「精简」把上一代已经跑通并写在文档里的**沙箱、审批、文件工具、回滚点、自检**一并删除了，
但既没有更新文档、也没有提交、更没有在打包产物里体现。**当务之急不是继续加功能，而是先回答一个
问题：这些防线是「有意去掉」还是「重构中途丢了」？** 有意去掉就更新文档并补等价替代；丢了就尽快
恢复——否则智能体正以「全权限、无确认、无路径边界、无回滚」的状态跑 shell，而所有文档都还在说它很安全。

---

## 附：本次体检的核对方法（复现用）

```bash
# 1. 源码 vs 打包产物 的文件差异
comm -13 <(ls apps/agent-ts/src/*.ts | xargs -n1 basename | sort) \
         <(ls apps/desktop-node/release/win-unpacked/resources/agent-ts/src/*.ts | xargs -n1 basename | sort)
# 期望输出（源码已删、打包仍有）：approval sandbox sandbox-win checkpoint isolate plan skill modelprobe selftest selftest-sdk

# 2. 源码里的工具清单（确认无 list_dir/read_file/write_file/patch/grep）
grep -rhoE 'name: "[a-z_]+"' apps/agent-ts/src/tools.ts apps/agent-ts/src/jobs.ts apps/agent-ts/src/subagent.ts | sort -u

# 3. 类型错误（当前无 tsc，类型错不会被拦下）
grep -n 'memory_write' apps/agent-ts/src/jobs.ts   # 不在 ToolAction 联合类型内

# 4. 死代码探针
grep -rn 'createAgent\|DefaultAgent' apps/agent-ts/src/          # agent.ts 零引用
grep -rn 'isRisky\|normalizeAction' apps/agent-ts/src/ | grep -v contract.ts  # 零调用
```