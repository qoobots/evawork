# TS 智能体任务清单（需求 · 架构 · 数据 · 任务分解）

- **参照基准**：`D:\05workspaces\deepseek-harness`（DeepSeek Harness，下称 **DSH**，`0.2.1-alpha.1`，MIT）
- **我方现状**：`eva-desktop/apps/agent-ts/` 骨架已跑通，P0–P5 **全部 ✅**（自检 **202/202**、SDK 自检
  **22/22**）；`--model-probe` 可问"这档还能不能干活"（TS-059）；`electron-builder --dir` **真跑过一次**，产物里 agent-ts 36 文件、含 `.node`、
  0 个中间产物，且能在产物里直接启动（TS-057）。唯一引入的原生模块是 TS-022b（Windows 受限令牌+ACL），**可选**：默认关，
  `npm run build:native` 构建（编不出来不阻断打包，见 TS-055）；依赖策略见 §1.3
  （2026-10-06 起**允许引入 npm 依赖**——原「零 npm 依赖」约束已作废）
- **文档性质**：规格文档。每项给「模块 → 内容 → 验收判据 → 依赖」
- **标记约定**：✅ 已完成 ｜ 🔧 进行中 ｜ ❌ 未开始 ｜ ⏸ 暂缓
- 日期：2026-10-06

---

## 0. 结论先行

**架构与 DSH 同构，模块可直接对照复制；但只借结构，不搬代码。**

DSH 根 `package.json` 是 `private: true`——**未发布到 npm**，取不到 `@deepseek-ai/dsh-*`；且锁 `node ^22.19.0 || >=24.0.0`，自身仍是 alpha，单仓 6000+ ts 文件。故：

| | 做法 |
|---|---|
| ✅ 照搬 | 模块划分、分层方式、事件模型、扩展点设计、术语（turn/step、`pre-execute`、fail-closed） |
| ❌ 不搬 | 源码。vendor 进来仓库不可维护 |

本文所有「复制 DSH 模块」均指**按它的模块边界与设计自建**。

### 与 Python 侧的三条硬边界（决定了所有设计）

| | 处置 | 理由 |
|---|---|---|
| 模型通道 | **共用**（同一个 eva-ai `/api/ai/v1`） | 不共用就会出现「Python 侧 16 个模型、TS 侧 5 个」的漂移 |
| 审批档位与工具规格 | **共用同一份契约文件** | 各写一份必然漂移——`presets.py` 开头已记过一次这个教训 |
| 存储与历史 | **完全分开**（TS 侧 `~/.evawork/ts-agent/`，不碰 evawork.db） | Python 主库是「单连接 + 一把 RLock」，`check_same_thread=False` 不保证并发安全且实测咬过人；双进程写撑不住 |

---

## 1. 需求

### 1.1 目标

在 Node 侧用 TypeScript 实现**一套独立智能体**，与 Python 版 `evawork` 两套并存：

| | TS 智能体（本文） | Python 智能体（现有） |
|---|---|---|
| 定位 | **日常工作** | **数据分析** |
| 编排 | 独立 | 独立 |
| 存储 / 历史 | 独立 | 独立 |
| 界面 | 用户**二选一**，两套互不感知 | 同 |

> 为什么不走「Python 调 TS 的 MCP 插件」：MCP 只能复用**能力**，不能复用**编排**。
> 两套并存要的是各自独立演进与故障隔离。

### 1.2 非目标

- 不做统一编排层、不做任务互转
- 不共享 `evawork.db`、不读 Python 侧的 SQLite 登录态（凭据由启动方注入）
- 不复制 DSH 的 Cordis 插件框架本体（它的一切皆插件是**运行时形态**，我们用更简单的方式达到同样目的，见 2.4）

### 1.3 约束

| 约束 | 值 | 理由 |
|---|---|---|
| 依赖 | **允许引入 npm 依赖**（2026-10-06 解除原「零 npm 依赖」约束） | 目标是功能完善，不为了"自己能写"而重复造轮子；成熟库优先。选包偏好：**纯 JS / 无原生编译**（避免打包与分发复杂化）；引入后必须同步改打包 filter（见 §5 与 TS-054） |
| 运行时 | Node ≥ 22.18（实测 v24.18） | 原生 TS type stripping |
| 平台 | Windows 优先 | 目标桌面端 |
| 语言限制 | 不用 `enum` / `namespace` / 参数属性 | strip-only 模式不支持（已踩：`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`） |

### 1.4 验收口径（什么叫「可用」）

1. ✅ 界面能启动/停止它，并看见流式输出与工具调用（P1：TS-010/011；P5：TS-052 任务页通道）
2. ✅ 高危动作在无人应答时**一律拒绝**，不挂起（P2：TS-020/021/022；fail-closed 有自检钉住）
3. ✅ 日常工作类任务（检索、改文件、跑命令、联网）能自己跑完（P3：TS-030/031/034；
   联网走 TS-023 出口管控）
4. ✅ 长任务不炸上下文（P4：TS-042 压缩 + TS-024 循环卫生 + TS-031 spill）
5. ✅ 随桌面端打包可分发（P5：TS-054；需本机 Node 22.18+，缺失时说清原因）

---

## 2. 产品架构

### 2.1 分层（对照 DSH）

```
┌─ 接口层   sdk(stdio/HTTP) · host(桌面端挂载) ─────────────┐
├─ 编排层   agent · agent-loop · subagent · plan/goal · jobs │
├─ 治理层   approval · sandbox · preset(档位) · guard(循环卫生)│
├─ 能力层   tools · llm · fs · shell/terminal · web · mcp · skill│
├─ 持久层   session(事件日志) · storage(KV) · spill · query   │
└─ 运行时   boot(组装) · settings · credentials · telemetry ──┘
```

DSH 同构点：**事件是唯一真相源**（durable session events）、`agent/*` 是活事件、
能力事件（`tools/*`、`fs/*`）承担策略挂载——**策略不进循环**。

### 2.2 模块对照表（DSH → 我方）

| DSH 包 | DSH 职责 | 我方模块 | 处置 |
|---|---|---|---|
| `core/session` | append-only 事件日志 + 内存 store | `src/session.ts` | ✅ 已有（简化版） |
| `core/system-prompt` | 提示词分节 + 工具 schema 组装 | `src/prompt.ts` | ✅ TS-040 |
| `core/tools` | 工具注册表 + 受保护执行管线 | `src/tools.ts` | ✅ 已有 |
| `core/agent` | `Agent` 接口 + 活注册表 + `agent/*` 事件 | `src/agent.ts` | ✅ TS-041 |
| `core/agent-loop` | 默认 driver（turn/step） | `src/loop.ts` | ✅ 已有 |
| `core/scope` | 每 agent 作用域注册原语 | — | ⏸ 单 agent 时用不到 |
| `llm/llm` | 消息/流词汇 + adapter seam | `src/llm.ts` | ✅ 已有 |
| `llm/llm-pi-ai` | OpenAI 兼容 provider | 合入 `llm.ts` | ✅ 已有 |
| `shell` / `subprocess` | 命令执行 | `tools.ts:run_command` | ✅ 已有（基础） |
| `terminal` / `ptc-runtime` | 持久终端 | `src/terminal.ts` | ✅ TS-034 |
| `ssh` | 远程执行 | — | ⏸ |
| `sandbox` / `sandbox-local` | 进程隔离契约与后端 | `src/sandbox.ts` | ✅ 软沙箱 + 加固档（TS-022） |
| `sandbox-windows-acl` | Windows 写限制（受限令牌+ACL） | `src/sandbox-win.ts` + `native/win-sandbox` | ✅ TS-022b（可选，需先构建原生模块） |
| `sandbox-policy` | 档位与策略解析器 | `src/contract.ts` | ✅ TS-021 |
| `fs` | 文件系统能力 | `tools.ts`（read/list/write） | ✅ 已有 |
| `lsp` | 语言服务 | — | ⏸ |
| `skill` | 技能加载 | `src/skill.ts` | ✅ TS-033 |
| `web` | search / fetch | `src/tools.ts` | ✅ TS-030（出口管控 TS-023 先行） |
| `computer-use` / `browser-use` / `e2b` | 浏览器与桌面控制 | — | ⏸ |
| `compaction` | 上下文压缩 | `src/context.ts` | ✅ TS-042 |
| `context` | 请求上下文 | `src/context.ts` | ✅ TS-042 |
| `subagent` | 委派子代理 | `src/subagent.ts` | ✅ TS-043 |
| `jobs` | 后台任务 | `src/jobs.ts` | ✅ TS-044 |
| `deliverables` | 轮次产物 | — | ⏸ |
| `plan` / `goal` / `todo` | 计划 · 目标 · 待办 | `src/plan.ts` | ✅ TS-045 |
| `schedule` | 定时跟进 | — | ⏸ |
| `preset` | agent 组合（≈权限档） | `src/contract.ts` | ✅ TS-020 |
| `guard` | **循环卫生**（重复调用提醒、超时策略） | `src/guard.ts` | ✅ TS-024 |
| `interaction/user-approval` | 审批服务 | `src/approval.ts` | ✅ 已有 |
| `interaction/permission-presets` | approval + sandbox 打包成命名档 | `src/contract.ts` | ✅ TS-020 |
| `extensions` / `hooks` | 运行时自改 / Claude Code 桥 | — | ⏸ 不做 |
| `session-persistence-jsonl` | 事件日志持久化 | `src/session.ts` | ✅ 已有 |
| `session-query` | 浏览 / 搜索 / 导出 | `src/query.ts` | ✅ TS-051 |
| `attachment` / `spill` | 二进制附件 / 输出溢出 | `src/spill.ts` | ✅ TS-031 |
| `storage` | 非会话存储（SQLite WAL / JSON） | `src/storage.ts` | ✅ TS-025（JSON，接口可换 SQLite） |
| `workspace` | 工作区实体 | `src/sandbox.ts` | ✅ 已有（简化） |
| `settings` / `credentials` | 设置 / 凭据 | `src/settings.ts` | ✅ TS-026 |
| `feedback` / `identity` | 人工反馈 / 匿名身份 | — | ⏸ |
| `acp` / `api` | automation-only ACP / 远程 BFF | — | ⏸ 本地优先 |
| `sdk/{protocol,server,client}` | JSON-RPC 2.0 over stdio | `src/sdk.ts` | ✅ TS-010 |
| `boot/app-boot` | 启动与 profile 组装 | `src/boot.ts` | ✅ TS-050 |
| `host` / `client` | GUI host / client | 复用 `desktop-node` + `desktop-ui` | ✅ TS-052 |
| `mcp` | 外部工具 | `src/mcp.ts` | ✅ TS-032 |
| `telemetry` | 遥测 | `src/telemetry.ts` | ✅ TS-053 |
| `typert` / `util` | 类型图 / 零依赖工具 | `src/util.ts` | 按需 |

### 2.3 关键机制（从 DSH 借的四条，都经过验证）

**① turn / step 语义**

一次 **step** = 一次模型请求 + 它调用的工具；一次 **turn** = 若干 step，直到模型不再要工具。

```
turn/start → step/start → agent/request → llm/stream
  → tool/call → tools/pre-execute → tools/execute → tool/result
  → step/end → （还有事 → 下一 step）→ agent/turn-stopping → turn/end
```

两条刻意的边界（与 DSH 不同或 DSH 缺失处）：

- **有轮次上限**（默认 12）。DSH **没有内置上限**，要求调用方用 `agent/turn-stopping` 自行封顶；
  而 Python 侧实测撞过工具轮次上限——所以这里默认封顶，到了如实停下，绝不假装完成。
- **取消是协作式** `AbortSignal`：在当前 step 边界停，已拿到的正文保留，未派发的调用补 `ABORTED_BEFORE_DISPATCH`。

**② `pre-execute` 是唯一前置钩子**

审批、沙箱、越界检查都挂这一处，不在每个工具里各写一遍。管线固定：

```
找到工具 → 审批判定 → 沙箱校验 → 执行 → 后置
```

工具不存在也要**明确拒绝并带回可用工具名**——静默放行或只回「工具不存在」，模型会继续猜。

**③ 审批：两档 + fail-closed**

```
ApprovalPolicy = "ask" | "never"
RISKY = { write, command, network }     # read / llm 直接放行
```

- `never`：高危动作**直接拒绝**
- `ask` **无人应答 → `unavailable` → deny**，**不挂起、无超时**

> 这一条与 Python 侧 T-086 是同一个结论，两套独立实现撞到同一个答案。
> 不做 `full`（全部放行）那一档：Python 侧 `presets.py` 的 `full` 同时把沙箱降到
> `danger-full-access`，一开就没有任何东西在看「这一步写到哪去了」。

**④ LLM 适配只要一个方法**

DSH 的 `LlmAdapter` **唯一必须实现的是 `stream(options): AsyncIterable<StreamChunk>`**，
`providerInfo` / `listModels` / `resolveModel` 全可选。所以我方接 OpenAI 兼容端点只需：

```ts
providers.eva = { api: "openai-completions", baseURL, apiKeyEnv, models }
```

流式字段：分片 `text-delta` + 一个终结 `finish`（`stop` / `aborted` / `error`）。

> **已踩的坑（写进实现，不是文档）**：从流里解析的 `tool_calls` 是扁平的
> `{id, name, arguments}`，回灌给 API 必须是 `{id, type:'function', function:{name, arguments}}`。
> 原样塞回去 → 网关收到畸形结构 → 模型「看不出自己调用过工具」→ 下一轮既不说话也不调工具，
> **HTTP 200、无报错、任务"正常完成"，答案是空的**。已用 `toWireMessages()` 统一转换。

### 2.4 组装与启动

DSH 用 Cordis 插件树 + profile（`web`/`headless`/`sdk`/`sdk-minimal`/`acp`）组装，启动只有 `dsh --profile <name>`。

我们不引入 Cordis，但**保留同样的分层与可替换性**：用一份**显式装配清单**（`boot.ts` + 配置）代替插件树——
同样是「运行时由一张清单决定」，只是没有依赖注入框架。

DSH 的 `sdk-minimal` 最小清单可直接对照：

```
sdk-app + sdk-jsonrpc-server + llm + session + system-prompt + tools
+ agent + agent-loop + session-persistence-jsonl
+ sandbox/terminal/tool-pwsh（Windows 用 pwsh）   # 加审批再挂 user-approval
```

### 2.5 在桌面端的位置

```
Electron 主进程（desktop-node）
  ├─ 拉起 Python 后端 :18765（现有）
  └─ 拉起 TS agent（新，stdio 或独立端口）   ← TS-011/TS-052
Vue 渲染层（desktop-ui）：新增"智能体"选择（TS / Python）
```

凭据由主进程注入（`EVA_AI_BASE_URL` / `EVA_AI_TOKEN`）——TS agent **不读 Python 侧的登录态**。

---

## 3. 数据

### 3.1 事件模型（唯一真相源）

持久化在 JSONL，**只追加**。字段：`seq`（单调递增，发出即不回收）、`ts`、`type`、载荷。

| type | 载荷 | 说明 |
|---|---|---|
| `turn/start` | prompt, model, workspace, maxSteps | |
| `step/start` | step | |
| `assistant/message` | step, text, calls[] | 文本与工具调用 |
| `tool/call` | step, tool, args, allowed, reason | **执行前**记录（含审批结论） |
| `tool/result` | step, tool, ok, chars | 不存全文（见 spill） |
| `step/end` / `step/error` | step | |
| `turn/end` | steps, stop, note, text | `stop ∈ {completed, max_steps, cancelled, error}` |
| `approval/asked` / `approval/decided` | tool, action, reason, granted | 审批有痕 |

原则：**「模型可见 ⟺ 已记录」**（与 Python 侧 P1-4 同一原则）。

### 3.2 存储布局

```
~/.evawork/ts-agent/            # 可用 EVA_TS_HOME 覆盖
├── sessions/<id>.jsonl         # 事件日志（会话）
├── storage.json                # 非会话 KV（设置/凭据引用）— 后续换 SQLite WAL
├── spill/                      # 长输出溢出
└── logs/                       # 运行日志
```

与 `evawork.db` **零接触**。

### 3.3 并发与锁

- 事件日志：**独占目录锁**（`mkdir`，Windows/POSIX 都独占）+ 陈旧锁兜底清除（>15s 判定为遗留，否则一次崩溃会永久写不进去）
- 重开会话：`seq` 从已有日志接续（否则新旧事件撞号）
- 坏行（写到一半崩了）跳过而非整份报废

DSH 的做法可对照：JSONL 用 flock 租约（`lease.ts`，`win32.ts` 有 Windows 实现）+ `link()`/`'wx'` 独占发布；
SQLite **默认 WAL**；且其 README 明确「跨进程互斥是 provider 特定的」。

### 3.4 版本与迁移（照搬 DSH 的两条）

1. **SQLite 用单调 `SCHEMA_VERSION`**：不匹配**直接拒绝，不做自动迁移**
2. **会话日志用 generation 命名**（`session.vN.jsonl`）+ **相邻迁移包**（`v0-to-v1` … `v3-to-v4`）：
   只增一个版本命名的后继，**绝不移动/覆盖/删除已提交的 generation**；前任不隐含回退或降级支持

### 3.5 与 Python 侧的数据边界

| 数据 | 归属 |
|---|---|
| 任务 / 步骤 / 事件 | 各存各的，**不互通** |
| 模型通道与白名单 | 共用（同一 eva-ai） |
| 工作区根 | 共用（同一目录，同一路径约束语义） |
| 登录态 | Python 侧持有，注入给 TS（env），**TS 不自持** |
| 审批档位定义 / 工具规格 | **共用一份契约文件**（TS-020），不是各写一份 |

---

## 4. 任务清单

### 进度概览

| 阶段 | 编号 | 模块 | 状态 | 一句话 |
|---|---|---|---|---|
| P0 | TS-001 | 骨架 | ✅ | loop+tools+approval+session+llm，21/21 自检，端到端跑通 |
| P1 | TS-010 | JSON-RPC stdio | ✅ | 让外部能驱动它（含 approve/deny/cancel） |
| P1 | TS-011 | 桌面端挂载 | ✅ | 主进程拉起/停止/健康 |
| P2 | TS-020 | 档位契约共用 | ✅ | 审批档与工具规格一份定义两边读 |
| P2 | TS-021 | sandbox 三档 | ✅ | read-only / workspace-write / danger-full-access |
| P2 | TS-022 | 加固档（写范围锁定） | ✅ | `permission model` 锁本进程写入；命令工具禁用 |
| P2 | TS-022b | Windows 受限令牌+ACL | ✅ | 原生模块：子进程只能写工作区与私有 temp（**可选**，需先构建） |
| P2 | TS-023 | Node 侧出口管控 | ✅ | 本进程出站受 allowlist 约束（与 Python 同规则） |
| P2 | TS-024 | guard 循环卫生 | ✅ | 重复调用提醒/停止 + 单步超时 + 步数上限 |
| P2 | TS-025 | storage KV | ✅ | 非会话存储（JSON，先写临时文件再 rename） |
| P2 | TS-026 | settings/credentials | ✅ | 设置存 storage；凭据只从 env 读、不落盘 |
| P3 | TS-030 | 工具集扩充 | ✅ | grep / patch / web_fetch（共 7 个工具） |
| P3 | TS-031 | spill | ✅ | 长输出溢出到工作区内 `.eva-spill/`，只回引用+摘要 |
| P3 | TS-032 | MCP 客户端 | ✅ | 零依赖 stdio JSON-RPC，工具默认按高危走审批 |
| P3 | TS-033 | skill 加载 | ✅ | 与 Python 侧同格式，只上摘要、全文按需取 |
| P3 | TS-034 | terminal | ✅ | 持久终端（跨命令保持 cwd） |
| P4 | TS-040 | system-prompt 分节 | ✅ | `src/prompt.ts`：按节渲染，档位/边界随运行时变 |
| P4 | TS-041 | agent 接口抽出 | ✅ | `src/agent.ts`：`agent/*` 活事件 + inbox/协作式 stop |
| P4 | TS-042 | compaction/context | ✅ | 事件日志为真相源；压缩是确定性投影 |
| P4 | TS-043 | subagent | ✅ | 委派：独立上下文+轮次上限，内部一律 never（fail-closed） |
| P4 | TS-044 | jobs 后台任务 | ✅ | `src/jobs.ts`：句柄式后台命令，可查/可等/可取消 |
| P4 | TS-045 | plan/goal/todo | ✅ | `src/plan.ts`：待办存事件日志，每 step 边界回灌 |
| P5 | TS-050 | boot 装配清单 | ✅ | `src/boot.ts`：清单决定模块/工具/提示词，cli 与 sdk 同源 |
| P5 | TS-051 | session-query | ✅ | `src/query.ts`：浏览/搜索/导出，SDK 四个方法 |
| P5 | TS-052 | 界面接入 | ✅ | 开关 + 主进程生命周期 + 任务页通道（`api/tsChannel.ts`） |
| P5 | TS-053 | telemetry | ✅ | `src/telemetry.ts`：只记数字与名字，可关、失败不影响任务 |
| P5 | TS-054 | 打包分发 | ✅ | 随包分发源码；**真 Node 22.18+** 先探测再说清原因 |
| P5 | TS-055 | 原生模块随包分发 | ✅ | TS-022b 的 `.node` 进包 + 主进程递 resources 路径；编不出来**不阻断打包** |
| P5 | TS-056 | 沙箱状态可问 | ✅ | `--sandbox-status` / `sandbox/status`：**开关与能力分开**说，一眼看出生效没有 |
| P5 | TS-057 | 打包真机验证 | ✅ | 真跑 electron-builder：抓出 agent-ts **整包没进产物**与 URL 编码两个静默错 |
| P5 | TS-058 | 模型裁决唯一 | ✅ | 模型不再各判各的：后端裁决 → TS 消费；TS 侧**没有兜底模型名** |
| P5 | TS-059 | 模型能力自检 + 命令输出编码 | ✅ | `--model-probe` 探这档还能不能干活；顺带查出**中文命令输出全是乱码**的真 bug |
| P0 | TS-060 | 文件回滚点 | ✅ | 内置 git 影子仓库：写类工具落盘**前**留快照，可按「步」撤销 |
| P0 | TS-061 | 工作区隔离 | ✅ | 在独立副本上跑（不用 git worktree）；`isolate/*` 五个 RPC + `prompt` 带 isolate 闭环 |

---

### P0 · TS-001 骨架 ✅

`apps/agent-ts/`：`types` / `session` / `llm` / `sandbox` / `approval` / `tools` / `loop` / `cli` / `selftest`

> **目录叫 `apps/agent-ts`，协议名与 `bin` 仍是 `eva-agent-ts`**：前者是"它在仓库里的位置"，
> 后者是"它对外叫什么"。改名等于同时打破 JSON-RPC 的 `protocolVersion` 协商与 CLI 入口，
> 收益为零，所以目录搬了、名字没搬——看到两处不一致时不必去"统一"它们。

**验收**：自检 21/21（事件日志 seq 连续性与重开接续、沙箱越界含 Unix 绝对路径陷阱、审批 never/无人应答/用户拒绝/应答抛错四种 fail-closed）；
端到端经 eva-ai：工具调用成功、`never` 档拒绝写入、越界读取被挡。

---

### P1 · 对外接口（让界面能驱动它）

#### TS-010 JSON-RPC over stdio ✅

`src/sdk.ts` + `cli.ts --serve`。请求：`initialize` / `session/new` / `session/prompt` /
`session/cancel` / `approval/answer` / `shutdown`；通知：`session.event` / `session.status` /
`approval/request` / `approval/timeout`。

关键取舍：
- **补 DSH 缺的** `approval/answer` 与 `session/cancel`——它只有 initialize/prompt/shutdown，审批链路走不通
- 凭据**不在启动期取**：没配也能 `initialize`，缺凭据到调用时才报（否则一启动就崩，调用方问不到原因）
- 审批超时（120s）按**拒绝**处理，fail-closed
- `session/prompt` 立即回 `accepted`，事件走通知流出（长任务不能占着请求不回）

**验收**：`selftest-sdk.ts` 12/12（协议/错误码/非法帧不崩/缺凭据报得清）；真实模型端到端——
拒绝路径：2 次审批均被挡、文件未创建、如实报 `max_steps`；放行路径：1 次审批、文件创建且内容正确、`completed`。

#### TS-011 桌面端挂载 ✅

`desktop-node/src/tsAgentCore.js`（纯逻辑，可单测）+ `tsAgent.js`（electron：取令牌/IPC/生命周期）
+ `preload.js` 的 `window.evawork.tsAgent` + `api.py` 的 `GET /api/iam/access-token`。

关键取舍：
- **令牌只在拉起子进程那一刻注入 env**，主进程不留副本、不落盘；TS 侧始终不自持登录态
- 令牌在后端手里 → 主进程向后端取一次（后端固定监听 127.0.0.1）
- **未登录就不启动**，而不是起一个「看着活着、一调用就报模型不可用」的空壳
- TS agent **直连 eva-ai，不经 Python 后端**——后端挂了它仍能干活（两套互不依赖）
- 进程管理刻意拆成不含 electron 的纯模块，否则这条链路无法在纯 Node 下测

**验收**：`Temp/probe_tsagent.cjs` 跑通「拉起 → 握手 → 建会话 → 收 5 个事件 → 终态 idle →
停止后进程不存活」；令牌接口返回 340 字符令牌与正确的 base_url / model。

> ⚠ Electron 集成部分（窗口不阻塞、退出时回收子进程）为**代码级接入**，未做真机启动验证。

---

### P2 · 安全与治理（**最优先**）

#### TS-020 审批档位共用契约 ✅

契约文件 `eva-desktop/shared/agent-contract.json`：**动作风险分类 + 审批档位语义 + 沙箱档**。
TS 侧 `src/contract.ts`（判定一律读它），Python 侧 `evawork/contract.py`（读它 + 查漂移）。

关键取舍：
- **命名以契约的抽象类别为准**（`write`/`command`/…）。Python 侧历史上把工具名当类别
  （`action="write_file"`），靠 `alias` 归一，**不改注册表**——改名要动全部工具规格与断言
- TS 侧：`ApprovalGate.decide()` 不再自己持有高风险集合，判定全部来自契约
- Python 侧：`mismatches()` 比对本侧与契约，并接进 `verify.py` 成为第 ⑤ 项检查。
  行为暂不改（改 presets 风险大），先把"漂移能被发现"守住

**验收**：TS 侧自检 28/28（含"读到契约而非兜底""别名归一"）；Python 侧 `mismatches()` 为空；
改契约 → TS 侧行为随之变。

> 踩到一处自己写的假漂移：校验时拿**工具名**（`open_url`）去比对 `RISKY_ACTIONS`，
> 而那个集合存的是**类别名**（`network`），一跑报 8 条假差异——假警报会淹没真漂移。

#### TS-021 sandbox 三档 ✅

`src/sandbox.ts`：`SandboxGuard` 按档位回答「允许写吗 / 允许联网吗 / 是否限制在工作区内」，
档位语义读共用契约（`sandbox` 段）。已接入 `preExecute`：沙箱判定**在审批之前**。

两条线刻意分开，别混：
- **沙箱**管"能做到哪"（写/联网/路径边界）
- **审批**管"要不要问人"
  两者都要过——沙箱放行不代表不用审批（工作区内写文件仍可能要确认）。

关键取舍：
- 默认 `workspace-write`，**不默认** `danger-full-access`
- 沙箱挡下时问人是否**一次性放行**；无人应答 = **拒绝**（fail-closed）。
  所以 read-only 档在自动化场景里写入必被挡，不会退化成"沙箱说不行、但没人看着于是就执行了"
- 一次性升级**用完即毁**（每次工具调用结束清理）——不清就会从"这一次放行"变成永久放行

**验收**：自检 35/35（三档语义、一次性升级、read-only 下写入被挡）。

> 仍未做：真正的进程隔离（TS-022）。路径层挡不住命令里自己算出来的路径，
> 也挡不住子进程往别处写。

#### TS-022 加固档：锁住本进程写入 ✅（受限令牌 + ACL 转 ⏸）

**已做**：`--hardened` 用 Node 的 **permission model** 把**本进程**的写入锁在
工作区 / 数据目录 / temp，并**不授予** `--allow-child-process`（命令工具禁用）。

关键取舍：
- 不授予 `--allow-child-process` 是**刻意**的：Node 官方警告它会让整个 permission model
  失效（子进程根本不受约束）。代价是命令工具不可用；价值是"agent 自己能往哪写"真正被限制住
- 路径必须写成**正斜杠 + 结尾斜杠**（`D:/a/b/`）——写成 `D:\a\b` 时，连它自己的子路径都会被拒
- 它**不等于**进程隔离，别当成 DSH 那种受限令牌用

**验收**：hardened 档下只读工具可用、工作区内写正常、越界写入被挡；自检 41/41。

#### TS-022b Windows 受限令牌 + ACL ✅（原生模块，可选）

**已落地**（用户拍板"引入原生模块"后做的）：`native/win-sandbox`（Node-API 插件）+ 加载器
`src/sandbox-win.ts`。命令子进程起在**受限令牌**下，只能写工作区与私有 temp。

招式是 Windows 自己那套（Chromium 与各类沙箱同源）：

1. 造一个**一次性随机 SID**（随机是安全前提：撞上真实用户/组 SID，那条 ACE 就等于给真人开门）
2. 给"允许写"的目录加一条**可继承**的 ACE：允许这个 SID 写
3. `CreateRestrictedToken(WRITE_RESTRICTED | DISABLE_MAX_PRIVILEGE | LUA_TOKEN)`：
   写访问要做**两次**访问检查（正常 SID 一次、限制 SID 一次），两次都过才放行
4. `CreateProcessAsUser` 起来，挂 **Job Object**：结束时整棵树一起收（不留后台残留，
   也保证管道能读到 EOF）

**构建**（产物按平台生成，不入库）：

```
npm run build:native          # 等价于 node scripts/build-native.mjs；已有产物就跳过
npm run build:native:force    # 强制重编
```

需要 MSVC Build Tools（本机已有）+ Python。编不出来**不阻断打包**（TS-055 有完整说明）。

**开关**：`EVA_TS_WIN_SANDBOX=1`（默认关：这层是可选增强，不是默认路径）。
模块不在时**明说原因并退回**路径层沙箱——静默退化等于告诉用户"沙箱开着"，其实门是开的。

**验收**：自检 **194/194**（含"界外文件确实没被创建""越界给的是可读的拒绝而不是空输出"、
"不可用时给出可读原因"）；端到端经 `run_command`：界内命令正常、界外写入 `拒绝访问。`、
关掉开关后退回普通执行。

**踩到的四个坑**（都是"能起来但完全不对"那类，写在代码注释里了）：

1. `CREATE_UNICODE_ENVIRONMENT` 配 `lpEnvironment=NULL` → 子进程拿到空环境块，
   初始化直接 `STATUS_DLL_INIT_FAILED(0xC0000142)`
2. 限制 SID 只放随机 SID 也起不来：必须带上 **logon SID**（窗口站、桌面、`\BaseNamedObjects`
   这些会话级对象是按它授权的）；**用户 SID 不能**放进去，放了等于把限制取消
3. 窗口站/桌面的临时授权不能"进程一建好就收回"——子进程还在初始化
4. 控制台输出可能是 UTF-8 也可能是本地代码页：**先按 UTF-8 严格解**，失败再退 ACP，
   否则中文一片乱码

**诚实的边界**（不是全能，别当牢笼用）：

- 只限制**写**，不限制读与网络
- 限制 SID 带上了 **Everyone**（不然 node / python 这类程序**根本起不来**——它们在初始化
  阶段就要往"Everyone 可写"的位置写东西，被挡在 DLL 初始化里，连一句"拒绝访问"都没有）。
  代价如实说：子进程因而也能写 `C:\Windows\Temp` 这类世界可写位置；**用户目录、桌面、
  别的工程、Program Files、系统目录仍然是挡住的**
- **仍有程序起不来**：实测 `git`、`ping`、`whoami` 报 0xC0000142。工具层已把这种退出码
  翻译成一句人话（"该程序启动时需要往允许范围外写东西，可用 `EVA_TS_WIN_SANDBOX=0` 关掉
  这一层"），不再是一串看不懂的负数
- ACE 靠目录继承，**只对新建对象生效**：已存在的文件不在继承范围内（要覆盖就得递归改，
  代价大，暂不做）

#### TS-023 Node 侧出口管控 ✅

`src/egress.ts`：环境变量与判定规则**和 Python 侧 `security.py` 逐字对齐**
（`EVA_EGRESS_ALLOWLIST` + `EVA_EGRESS_ENFORCE=1`），**模型调用也走这个出口**——
否则配了白名单，对最主要的一个外联方向却完全不生效。

诚实边界：它管的是**本进程**发出的请求；`run_command` 拉起的子进程不受控（Node 没有
socket 级拦截，permission model 也没有 `--allow-net`）。所以真正的组合拳是：普通档
本进程受控、子进程靠审批与沙箱兜；**hardened 档命令禁用 → 除本进程外没有别的出口**。

**验收**：自检 41/41（未声明→允许、声明未强制→不拦、强制下白名单放行 / 非白名单被拒 /
相似域名不误放行）；Python 侧 `verify.py` 通过。

> 顺带修了 Python 侧一处真实缺陷：白名单写 `.github.com` 在原规则下**实际不生效**
> （`"raw.github.com".endswith("..github.com")` 恒为假），而它的示例注释正是这么写的——
> 用户照着配就会失效。两边同步改，保持一致。

#### TS-024 guard 循环卫生 ✅

`src/guard.ts`（**只判定、不动作**）+ `loop.ts` 接入。管三件事：同一工具同一参数反复
调用、单步超时、步数上限。

关键取舍：
- 只看「工具名 + **参数**」这个组合：同一个工具换不同参数是正常的（在换着法试），
  完全一样的参数反复发才是卡住了
- 参数用**稳定序列化**比较（键排序），否则 `{a,b}` 与 `{b,a}` 会被当成两次不同调用，
  死循环检测直接失效
- 提醒必须**进到模型能看到的地方**（拼进工具结果）——只在日志里记一句，它照样打转
- 重复到第 5 次判定死循环直接停，并如实记 `stop=guard`，不假装任务完成
- guard 是纯逻辑（喂调用记录进来断言结论），不跑模型就能测

> DSH 的 `guard` 同样**不是审批**（审批在 `tools/pre-execute`）——别按名字误解。

**验收**：自检 49/49（重复 3 次提醒 / 5 次停止 / 换参数不累计 / 键序无关 / reset 清零）。

#### TS-025 storage KV ✅ / TS-026 settings·credentials ✅

`storage.ts`（非会话存储）+ `settings.ts`（设置与凭据）。

关键取舍：
- 与事件日志**分开**：日志是只追加的事实（可重放），存储是会变的当前状态（最后写入生效）
- 先用 JSON 而非 SQLite：零依赖优先，这点数据量用不上数据库；真需要并发写再换
  SQLite WAL（接口不变）。schema 不匹配**直接拒绝**，不做悄悄的自动迁移
- 写盘先写 `.tmp` 再 rename——写到一半崩了不会留下半截 JSON 把整份存储毁掉
- **凭据只从 env 读、不落盘**：登录态在 Python 侧，由启动方注入。共享一份凭据存储
  等于把两套智能体又绑回一起，"独立"就只剩名义上的
- 缺一半凭据（只有 base_url）也算**没有**——别让调用方去猜

**验收**：自检 57/57（存取删、设置补丁式更新、凭据三种情形）。

---

### P3 · 能力层

#### TS-030 工具集扩充 ✅

新增 `grep`（字面搜索，非正则）/ `patch`（精确替换）/ `web_fetch`（走统一出口，
受 `EVA_EGRESS_ALLOWLIST` 约束）。共 7 个工具。

关键取舍：
- **`patch` 要求 `old` 恰好出现一次**，0 次或 >1 次都拒绝并告知次数——**不猜位置**。
  猜错位置的替换比不替换更糟，而且看不出来
- `grep` 是字面匹配不是正则：模型写的"正则"经常是错的，字面匹配失败得更明白
- `web_fetch` 依赖 TS-023 的出口管控（联网类工具必须等它）

**验收**：自检含 grep 命中/未命中、patch 唯一替换/重复拒绝/未找到三条路径。

#### TS-031 spill ✅

超过 8000 字符的工具输出写进文件，只把**摘要 + 引用**回给模型。

关键取舍：溢出文件放在**工作区内**的 `.eva-spill/`（隐藏目录）而不是数据目录——
放数据目录的话模型根本读不到（`read_file` 受工作区约束），于是"溢出"变成"丢失"。

#### TS-034 terminal ✅

`src/terminal.ts` + `terminal` 工具：**cwd 跨命令保持**（`run_command` 每条都重置回工作区根，
于是模型只能反复 `cd` 或写绝对路径）。

关键取舍：
- 用"每条命令一个进程 + 记住结束时的 cwd"来近似持久终端，**不是真 PTY**
  （那是 DSH `ptc-runtime` 的做法）。代价是不支持交互式命令（要输入的会等到超时），
  这点必须对模型说清楚，否则它会以为卡住了
- cwd 靠**显式标记**带回来：直接取输出最后一行不可靠——尾随空行会让 cwd 永远不更新
- 命令用 `&` **单行顺序连接，不能用换行分隔**：实测 `cmd /c` 收到含 `\r\n` 的参数时
  后续行根本不执行（marker 一次都没出现，cwd 一直停在根目录）
- **cd 到工作区外不跟随**：否则一条命令就能把终端挪出沙箱

**验收**：自检 71/71（cwd 保持、跨出边界不跟随、回界内正常跟随、reset 回根）。

#### TS-032 MCP 客户端 / TS-033 skill 加载 ✅

**TS-033 技能** `src/skill.ts`：与 Python 侧同格式（`SKILL.md`）。
**只把名字与摘要放进系统提示词，全文靠 `load_skill` 按需取**——全塞进来的话，上下文
先被说明书吃掉，真正能干活的窗口反而小了。找不到时把可用列表一并回给模型（否则它会
继续猜名字，一轮轮错下去）。

**TS-032 MCP 客户端** `src/mcp.ts`：stdio JSON-RPC（与 Python 侧 `mcp.py` 同一套路，
不依赖任何 MCP SDK——本机可能装不上包）。

关键取舍：
- **MCP 工具默认按最高风险处理**（要审批）。协议里没有"这个工具危不危险"的元数据，
  而 filesystem 类服务走的是**它自己的 allowed directories**，不受 EVA 沙箱约束——
  默认放行等于给外部服务开了一道不受管的门
- stderr **必须独立成管道**：真实 npm server 启动时会往 stderr 打日志，混进 stdout 就
  污染 JSON-RPC 帧（`initialize` 永远等不到合法响应，表现为"调用超时"）
- 工具名 `mcp__<server>__<tool>`（冒号在 OpenAI 函数名里非法）
- **接不上的服务跳过、只往 stderr 记一行**，不让一个坏配置把整个 agent 带崩；
  `stopMcp()` 在退出/关停时回收子进程，否则会残留孤儿

配置：`~/.evawork/ts-agent/mcp.json` → `{ "servers": [{ "name", "command", "args", "env" }] }`
（与 Python 侧插件存储分开）。`cli.ts` 与 `sdk.ts` 启动时各接一次。

**验收**：自检 **84/84**——含 mock server 的完整握手（initialize → tools/list → tools/call），
mock 一启动就往 stderr 打日志（验证混管问题已规避）、参数表从 `inputSchema` 解析、
起不来的服务跳过且不抛。

---

### P4 · 编排增强

#### TS-040 system-prompt 分节 ✅

`src/prompt.ts` 照 DSH `core/system-prompt`：提示词是一组**可增删替换的 section**，
由运行时上下文渲染：`identity / environment / sandbox / approval / tools / skills / output`。

**核心收益不是"好看"，是让边界跟着档位走**：沙箱档位、审批档位、工具清单（含 MCP 外部
工具）都是**渲染出来的**，不是写死的文本。改了档位而提示词还在说"可以随便写"，模型就会
一遍遍撞必然被拒的调用——这类"看起来像模型不听话"的问题，根子常在提示词与环境不一致。

- 某节返回空则**整节消失**，不留"## 技能（无）"这种占位噪音
- `SystemPrompt.set/setText/insertBefore/remove`，`loop.ts` 只调 `build(ctx)`
- 技能仍只上名字+摘要（TS-033）；`skills` 节内部调 `skillIndex`

**验收**：自检 **93/93**——节顺序固定、空节消失、只读档/审批档渲染进文本、
整节替换与移除、可插入自定义节。

#### TS-041 agent 接口抽出 ✅

`src/agent.ts`：把"跑一轮"抽成**可替换的 driver 接口**，`loop.ts` 退为默认 driver
（cli / sdk 仍在用），不再是唯一形态。

```
Agent { id, status, run(goal), inbox(msg), stop(reason), on(fn) }
```

`agent/*` 活事件：`status / step / request / continuation / inbox / turn-stopping`
（统一走 `onEvent`，SDK 会自动转发给外部进程）。外部**看到事件再决定**插话或叫停，
这是它存在的理由——没有活事件，"用户打断"只能靠杀进程，已跑出的上下文全丢。

- **inbox 中途插话**：消息在**下一个 step 边界**进入对话，不打断正在跑的那一步；
  空白不入队（不拿上下文换噪音）。第 1 步前不注入（等于把目标又说一遍）
- **stop 是协作式**：只置 abort，走到 step 边界停，已产出的正文保留
- `TurnOptions.stream` 留了**模型流接缝**：换掉它就能在**没有模型**的情况下跑完整一轮
  ——既方便自检，也是其它 driver（子代理、离线重放）的挂点

**验收**：自检 **102/102**——假流跑通「模型 → 工具 → 模型」两 step、inbox 进入对话、
活事件序列齐全、stop 后不再发起新请求且状态为 `stopped`。

#### TS-042 compaction / context ✅

`src/context.ts`。前提照 DSH：**事件日志是真相源，上下文只是它的投影**——所以压缩
可以放心丢，要回看就从日志重放（`projectEvents` 就是这条重放路径）。

两条硬约束：

- **tool 结果不能落单**：OpenAI 协议里 tool 消息必须挂在带 `tool_calls` 的 assistant
  后面，只丢 assistant 会让整轮请求直接报错。→ 压缩按**轮**（assistant + 它的工具结果）
  整体丢弃，绝不拆散
- **压缩是确定性的，不靠模型总结**：总结本身要发一次大请求，而"上下文快满了"恰恰最不该
  再发；且无模型时（离线重放、自检）也必须能压

策略顺序：先掐头去尾长工具输出（保留"这里被截了"）→ 仍超预算就丢最前面整轮 →
留一条 `[上下文压缩]` 痕迹（静默丢会让模型以为对话本就这么短）。**system 提示词永留**
（丢了它，档位/边界/审批语义一起没了）。

为此 `tool/result` 事件现在**连正文一起落盘**——只记长度的话，回放时还原不出上下文。

**验收**：自检 **112/112**——预算内、按轮丢弃、无落单 tool、system 保留、
最近轮保留、留痕迹、不超预算时不丢、事件日志可投影回消息且 id 对得上。

#### TS-043 subagent ✅

`src/subagent.ts` + 工具 `delegate`。委派：独立上下文、轮次上限、工具子集。

**最关键的一条（也与 Python 侧 T-090 同结论）：子代理内部一律 `never` 档，
无人应答 → 拒绝，绝不弹审批。** 否则「派个子代理」就成了绕过人工审批的暗道——
用户看得见主任务的每一步，却看不见子代理在干什么，等于把审批口子开在了看不见的地方。

- 被拒的动作**不静默吞掉**：收集进 `denied[]`，由 `summarizeSubagent` 带回主任务，
  在**人能看懂的那一层**去问人
- **独立上下文**：子代理只看到「任务是什么」，看不到主任务对话历史——不隔离的话派一次
  上下文就翻倍，越派越贵
- **轮次上限默认 6、硬顶 12**：它是去办一件事的，不是开第二个主循环
- `delegate` 动作类别是 `llm`（**非高危**）：委派本身不碰外部世界（子代理是 fail-closed 的），
  标成 command 只会多弹一次挡不住任何风险的审批
- 工具子集外的调用：不只"不给它看 schema"（模型会自己猜名字调过来），
  执行前再拦一次并把可用名单带回去

**验收**：自检 **125/125**——独立上下文（首次请求只有 system+目标）、主任务内容不泄漏、
轮次上限、高危动作被拒且文件确实没写出来、拒绝原因带回主任务、子集外调用被拒、
缺模型通道时明确报不能委派。

#### TS-044 jobs 后台任务 ✅

`src/jobs.ts`：把跑很久的那件事（构建、全量测试、装依赖）挪出主循环。
工具：`job_start` / `job_status` / `job_wait` / `job_cancel`。

三条刻意的边界：

- **返回句柄而不是结果**：`job_start` 立刻回 id，回结果就退化成同步调用，模型还是会干等
- **取消不保证立刻停干净**：只能 kill 直接子进程（进程树可能残留），如实写进状态里，
  不假装清干净了
- **输出照样截断**（2 万字符）：后台跑不代表可以无限涨内存
- `job_start` 仍是 **command 档（要审批）**——后台跑不是绕过审批的理由

**验收**：自检 **139/139**——发起即返回 running、wait 等到输出、失败命令带退出码、
取消生效且如实说明残留、找不到任务时带回可用 id 列表。

#### TS-045 plan·goal·todo ✅

`src/plan.ts` + 工具 `todo_write` / `todo_read`。

干什么：长任务最容易坏在"做到一半忘了要做什么"——跑到第 8 步时模型眼里只有第 7 步的工具
结果，第 1 步定的目标早被挤没了。给一张**显式待办**并在每个 step 边界回灌一次，是最便宜的
纠偏手段（主流编码智能体的通用做法）。

两条刻意的取舍：

- **状态存事件日志**（每次改动追加一条全量快照），不另开文件。另开文件就要自己解决
  并发/损坏/与会话对不上；追加快照虽然冗余，但重放只是"取最后一条"，几行代码完事——
  **续跑不丢目标**就是这么来的
- **整体替换而非逐条增删**：模型本来就倾向输出完整列表，让它每次给全量，比让它学会
  精确的增量编辑稳得多（与 patch 工具同一经验）
- 回灌只在清单**变了**的时候插一条，没变就不反复说同一段话
- 非法输入（status 不对、超 20 条、content 为空、items 不是 JSON）**明确回绝并说清哪里不对**：
  静默修正后模型会以为自己写对了

**验收**：自检 **155/155**——渲染含状态标记、可从事件日志恢复、mark 改单条、
四类非法输入被拒、缺 plan 时明确报错、回灌进上下文且不重复。

### P5 · 工程与集成

| 编号 | 内容 | 验收 |
|---|---|---|
| TS-050 | `boot.ts` 装配清单：运行时由一张清单决定，可替换 | ✅ 自检 166/166：换清单即换能力组合，cli 与 sdk 同源 |
| TS-051 | `session-query`：浏览/搜索/导出历史 | ✅ 自检 180/180 + SDK 20/20：可列、可搜、可导出三种格式 |
| TS-052 | 界面接入：「智能体」二选一（TS / Python） | ✅ 自检 191/191：开关 + 生命周期 + 任务页通道（事件翻译成同一套 `StreamEvent`） |
| TS-053 | telemetry | ✅ 自检 188/188：只记数字与名字，可关、失败不影响任务 |
| TS-054 | 随 Electron 打包分发 | ✅ 随包分发（无第三方依赖）；需本机 Node 22.18+，缺失/过旧会**说清原因** |

#### TS-050 boot 装配清单 ✅

`src/boot.ts`。可选模块已经有六个（MCP、后台任务、计划、子代理、技能、持久终端），
每个都在 `cli.ts` / `sdk.ts` 里 `registerXxx()` 一遍，两边随时会漂移成"命令行有、界面没有"。
清单把它们收在一处：**两个入口读同一张清单**。

清单 `~/.evawork/ts-agent/boot.json`（`--boot <file>` 可换），**只写差异**：

```json
{
  "version": 1,
  "sandbox": "workspace-write",
  "policy": "never",
  "maxSteps": 12,
  "exclude": ["run_command"],
  "modules": { "mcp": true, "jobs": true, "plan": true, "subagent": true, "skills": true },
  "prompt": { "remove": ["environment"], "set": { "output": "只输出 JSON。" } }
}
```

- **关掉的模块，它带来的工具一律不暴露**（注册过也不给模型用）——只"不注册"是不够的，
  进程里别处注册过就又冒出来了
- 版本不对 → **整个退回默认**，不半新半旧地合并
- 可选模块注册幂等（重复装配不会"工具重名"直接抛）
- 优先级：命令行显式给的 > 清单 > 默认（否则"改了清单不生效"会让人以为清单没被读）
- 刻意**不做成插件系统**：没有动态 import 的白名单机制，就不假装支持任意第三方模块

**验收**：自检 **166/166**——缺文件用默认、只写差异、未写字段回落、版本不对退回默认、
剔除生效、模块关闭即不暴露、档位进 gate/sandbox、提示词按清单裁剪、重复装配不炸。

#### TS-052 界面接入（智能体二选一）✅

**第 1 段：开关与主进程生命周期**（链路：渲染层 → preload → 主进程）：

- `desktop-ui/src/api/tsAgent.ts`（新）：preload 早就把桥暴露了，但渲染层一行封装都没有
  ——"能力存在但没人用"。补齐有类型的封装；**没有 Electron 时明确说不可用**，不假装能调
- `desktop-ui/src/api/backend.ts`：`EvaworkGlobal` 补 `tsAgent` / `agentChoice` 类型；
  `tsAgent.on` 现在**返回取消订阅函数**（组件卸载后回调必须能摘掉，否则事件继续往死组件里灌）
- `desktop-node/src/main.js`：选择存 `userData/agent-choice.json`（**不进后端设置表**——
  这是本机级选择，跟账号无关，也不该被设置同步覆盖）；新增
  `evawork:agent-choice-get/set`，切换**立刻生效**：选 py 收掉 TS 子进程、选 ts 拉起；
  启动时**只在选了 ts 才常驻拉起**（以前无条件拉起，白白占资源还让人以为历史丢了）
- `desktop-node/src/preload.js`：暴露 `agentChoice`
- 设置新增「智能体」一节（AdminLayout / router / SettingsPane 三处）：两个按钮二选一 +
  运行状态，并**写明"两套互不感知、各自独立存储与历史，切换后看不到另一套的历史"**——
  不写这句，用户会当成数据丢失

**第 2 段：任务页真正走 TS 通道**（收尾项）：

- `desktop-ui/src/api/tsChannel.ts`（新）：**把 TS 的事件流翻译成同一套 `StreamEvent`**。
  这是整件事的关键取舍——任务页那套（步骤 / 工具 / 叙述 / 审批 / 终态）有 96KB、
  与后端 SSE 长在一起，重写一遍风险太大；翻译成同形状后，**换的是数据源，不是界面**
  - `tool/call` → `tool_call`、`tool/result` → `tool_result`、`agent/continuation`
    → `narration`（模型要调工具了 → 此前流出的正文是过程叙述，不是答案）、
    `context/compact` → `notice`、`session.status` 终态 → `done` / `cancelled` / `error`
  - TS 侧**没有规划器**：合成一步「TS 智能体执行中」，不假装它有 plan
- 流式正文：SDK 新增 `session.text` 通知（走 `runTurn` 的 `onText` 接缝）。
  **正文不落事件日志**——一条一个 token 会把日志撑爆，而完整正文在 `turn/end`
  与终态里都有，日志只要"事实"那一份（自检钉住了这条）
- 审批：TS 的 `approval/request` → 界面同一套审批条，应答走 `approval/answer`
  （**不是**后端的 `/approve`）；无人应答同样 fail-closed，界面显示"已被拒绝"
- 停止：走 `session/cancel`（协作式），不关流了事
- **两套互不感知**这条边界在这一段最容易破：TS 会话不在后端库里，所以
  侧栏回看、撤销回滚点、智能跟进这些后端能力在 TS 模式下一律不调；
  万一点到 `ts-` 开头的会话，直接说清它是 TS 会话、不能从任务列表回看，
  而不是丢一个没头没尾的 404

**验收**：自检 **191/191**（新增 3 条：正文分片回调、正文不落日志、终答完整）；
`vue-tsc --noEmit` 通过；`node --check` 主进程与 preload 通过；SDK 自检 20/20。

#### TS-053 telemetry ✅

`src/telemetry.ts`。解决的问题很具体：agent 跑得"看着还行"，但**没有任何数字**——
一轮几步、哪类工具最慢、被拒了多少次、上下文压了几次，全靠猜。

指标：`step` / `tool`（耗时）/ `tool.denied` / `tool.failed` / `context.compact` /
`turn`（耗时）/ `turn.stop.<原因>`。落 `<home>/metrics.jsonl`，另有进程内摘要。

三条边界：
- **只记名字与数字，不记内容**：不落 prompt、参数、文件正文（自检里直接断言这三个键
  一个都不许出现）。遥测最容易越界成"顺手把上下文也存了"，那它就变成第二个、没人管的日志
- **绝不因为遥测失败而中断任务**：所有落盘都 try/catch 吞掉
- **可以关**：`EVA_TS_TELEMETRY=0` 或启动清单 `modules.telemetry: false`

入口：CLI `--metrics`；SDK `telemetry/summary`。

**验收**：自检 **188/188**——计时/计数/失败数、排序、渲染、
落盘不含 prompt/args/content、关掉后什么都不记、写盘失败不抛。

#### TS-054 打包分发 ✅

- `desktop-node/package.json`：`extraResources` 增一项，把 `apps/agent-ts` 随包分发到
  `resources/agent-ts`（只带 `src/**` + `package.json` + `README.md`，不含 node_modules
  与 `.eva-spill`）——TS 那一侧**零第三方依赖**，随包就是拷贝源码，没有"安装时再装一遍 npm"
- `tsAgentCore.js` 新增 `findNode()`：`apps/agent-ts` 靠 Node 原生剥离 TS 类型，需要
  **真 Node 22.18+**

**这里踩到一个真问题**：原来默认用 `process.execPath`，也就是 Electron 自己的可执行文件。
它有两个错：Electron 31 带的是 Node 20（跑不了类型剥离）；更糟的是直接 spawn 它会
**拉起一个 GUI 窗口**——属于"能启动但完全不对"的那类错。现在改为在 PATH 上找 node 并
**先验版本**；`EVA_TS_NODE` 可指定绝对路径（将来随包分发运行时就走这个口子）。

找不到/版本不够时**把版本号报出来**（"本机 Node v20.11.0，需要 22.18+" 比"没找到 Node"
有用得多），并明确告诉用户可以设 `EVA_TS_NODE`——只有一条降级路径：
**TS 智能体不启动，Python 那套照常可用**，绝不因为缺运行时把整个应用搞成不可用。

**验收**：`node --check` 通过；实测 `findNode()` 在本机返回 v22.18.0，
`EVA_TS_NODE` 指向不存在路径时返回可读原因；版本判定 20.11 → false、22.18 → true、24 → true。

#### TS-055 原生模块随包分发 ✅

TS-022b 引入了唯一的原生模块，打包链路因此出现一个**沉默的缺口**：TS-054 的
`extraResources` filter 只带 `src/**` + `package.json` + `README.md`，`native/` 一个文件
都不进包——成品里这层沙箱**凭空消失，且没有任何报错**（找不到模块和"不想用"长得一样）。

三处补齐：

1. **filter 带上 `native/`**：只要 `binding.gyp` + `src/**` + `build/Release/*.node`，
   排除 `obj/` 与 `pdb/ilk/exp/lib/tlog`（那些是 MSVC 中间产物，几十 MB，进包纯属负担）
2. **主进程把 resources 根目录递过去**：agent 是被外部 Node 拉起的**普通进程**，
   **拿不到** Electron 的 `process.resourcesPath`（那只存在于主进程）。所以
   `tsAgentCore.js` spawn 时注入 `EVA_TS_RESOURCES`，`sandbox-win.ts` 按它拼
   `resources/agent-ts/native/...`。这条链断掉的表现是"模块不存在"，而不是报错——
   自检里专门有一条用例钉住它（拿假 resources 目录断言候选路径）
3. **构建脚本 `scripts/build-native.mjs`**（`npm run build:native`）：铁律是
   **编不出来也不许让打包失败**——这层是可选的，缺了退回路径层沙箱并说明原因；
   若打包因为它挂掉，等于把"可选"做成了"必需"。所以失败默认退出 0，`--strict` 给 CI 卡口

顺手挡掉一个坑：`--force` 时先备份 `.node`——`node-gyp rebuild` 会先 clean，
**构建失败会连已有的那份一起删掉**；丢掉一个已经能用的能力比"没编出新的"糟得多。
失败时自动还原备份。（另外 Windows 上 `npx` 是 `.cmd`，`spawnSync` 必须带 `shell: true`，
否则报 EINVAL——第一次跑就撞上了。）

**验收**：自检 **195/195**（新增"打包态 resources 路径被算进候选"）；
`node scripts/build-native.mjs` 有产物时跳过、退出 0；`--force` 实测重建成功并产出
`eva_win_sandbox.node`；`node --check` 过 `tsAgentCore.js`。

#### TS-056 沙箱状态可问 ✅

"这层沙箱到底生效了吗"——在补这个入口之前，这个问题只能靠翻代码和猜。而它是安全问题里
最不该猜的一种：**没开**和**开了但模块没编**是两种完全不同的处置，混在一起就会瞎折腾
（最常见的浪费是：模块其实没编出来，却一直在查"为什么命令还能写到外面"）。

`sandboxStatus()` 一次性给出：平台、Node 版本、**开关**（`EVA_TS_WIN_SANDBOX=1`）、
**能力**（模块是否可用）、原因、实际加载到的模块路径、以及找过的候选路径。
入口：CLI `--sandbox-status`；SDK `sandbox/status`（**不需要凭据与会话**，和历史查询一样
放在"要 prompt"之前——排查是最常见的求助动作）。

输出示例（本机实测）：

```
平台 win32 | Node v24.18.0
受限令牌开关：关（默认；要开请设 EVA_TS_WIN_SANDBOX=1）
原生模块可用：是
模块：…/native/win-sandbox/build/Release/eva_win_sandbox.node
结论：命令子进程**不受写限制**，靠路径层沙箱 + 审批兜底。
```

**顺手把两个"要不要做兜底"的疑问做成了实测结论**（省得后人再排查一遍）：

- **跨 Node 版本**：`.node` 用 v24.18 编译，放到 **v22.22** 上 `require()` **照样能用**
  ——因为它是纯 N-API（`NAPI_VERSION=8`），ABI 稳定。所以不需要"按目标机 Node 版本重编"
  这类兜底逻辑
- **运行时依赖**：`dumpbin /dependents` 显示只依赖 `USER32 / ADVAPI32 / KERNEL32`
  （Windows 自带），**不依赖 VC++ 运行库**——目标机不装 Redist 也能加载，
  分发侧没有隐藏前提

**验收**：自检 **198/198**（状态字段齐、开关只有显式 `=1` 才算开、可用给模块路径否则给找过
的路径）、SDK **22/22**（新增 `sandbox/status` 与能力清单一并断言）。

#### TS-057 打包真机验证 ✅

前面几项的打包相关改动（TS-054 配置、TS-055 filter）都**只写过、没跑过**。真跑一次
`electron-builder --dir` 就抓出两个**静默**错误——两个都属于"不会报错，只是东西没了"：

**1. agent-ts 整包没进产物。** `extraResources` 的 `from` 写成了 `../../agent-ts`，
起点是 `apps/desktop-node`，两个 `..` 指到了 `eva-desktop/agent-ts`（**不存在**）；
electron-builder 遇到源目录不存在只是**跳过，一声不吭**。产物 `resources/` 下只有
`ui` / `backend` / `python`——TS 智能体在成品里等于不存在。改成 `../agent-ts` 后正常。
（`build:agent-native` 里的同一处层级也一起错了。）

**2. 原生模块路径被 URL 编码。** 候选路径用 `new URL(...).pathname` 拼，而 URL 的
pathname 是**百分号编码**过的：`~`（短名 `ADMINI~1`）→ `%7E`、中文 → `%E4%B8%AD`。
拿去 `existsSync` 的结果是"文件明明在那儿却说找不到"。改用 `fileURLToPath()`；
`build-native.mjs` 里同样的写法一并修掉。自检加了一条钉住它（候选路径不许含 `%`）。

这个 bug 只在**路径含特殊字符**时才发作——本机临时目录恰好带 `~1` 才暴露出来。
在打包布局验证里看得最清楚：修之前候选第一条是 `✗ C:/.../ADMINI%7E1/...`，
修之后是 `✓ C:\...\ADMINI~1\...`。

**验证结果**（三层都对上了）：

- 按 filter 模拟出的布局：36 文件、含 `.node`、无 pdb/lib/ilk/exp
- 真打包产物 `resources/agent-ts`：**同样是 36 文件**，含
  `native/win-sandbox/build/Release/eva_win_sandbox.node`，中间产物 0 个
- 在**产物里直接启动**（`EVA_TS_RESOURCES=<产物>/resources`）：
  `--sandbox-status` 报"可用：是"，模块路径指向产物里的 `.node`；
  受限命令界内跑通、界外写入被挡

**验收**：自检 **199/199**、SDK **22/22**；`electron-builder --dir` 成功；
产物内容与模拟布局逐项一致。

#### TS-059 模型能力自检 + 命令输出编码 ✅

**起因**：换档是后端自动做的（目录里出了新档就自动换过去），而"新档还能不能干活"
从来没人测过。于是做 `--model-probe` / `model/probe`：探两项**真出过事**的能力——
会不会发起工具调用、读不读得到含中文的工具结果。结果按「地址 + 模型名」缓存
（**不含凭据**，7 天），所以只有换档才真花钱；告警点名说清"是什么没了、会看到什么、
能怎么办"，并进会话事件（界面能看见），不只写 stderr。

探针本身踩了三个坑，都是"不修就永远报正常"的那种：

| 坑 | 不修的后果 |
|---|---|
| 探针串写进了 user 消息 | 模型不看工具结果，从用户话里抄一遍就算答对 → **永远报正常** |
| 温度用 0（真实任务是 0.7） | 测的不是真实表现 |
| 不带 system 提示词 | 真实请求有一千多字的 system，探针光秃秃的不代表真实输入 |

**真正的收获是顺手查出的一个真 bug：中文命令输出全是乱码。**

现象是：让智能体跑 `echo 中文输出测试`，它回答"输出是空的/是乱码"。我一开始判定为
"新模型读不到中文工具结果"，还准备绕开它。**这个结论是错的。** 查会话日志里的工具
结果才看到真身：`content=[锟斤拷锟斤拷…]`，而同一会话里 `chcp` 返回的是 **936**。

`锟斤拷` 是 UTF-8 字节被当 GBK 解的标志。真因在 `tools.ts`：

```ts
child.stdout.on("data", (d) => { out += String(d) })   // String(buffer) 默认按 UTF-8 解
```

中文 Windows 的 cmd 代码页是 **936（GBK）**，`echo 中文` 出来的是 GBK 字节，按 UTF-8
解就全是替换字符——模型于是只能说"输出是空的"。

修法两条，都做了：**严格** UTF-8 解码，失败才退 `gb18030/gbk`（GBK 字节不是合法 UTF-8，
严格解会失败；而非严格解**静默**产出 U+FFFD 且不报错——这正是它藏这么久的原因）；
以及**按字节收集、退出时整体解**，不能按 `data` 事件边界切（那会把一个汉字切两半）。

为什么之前一直没暴露：我先前直测时 `chcp` 恰好是 **65001**，同一个命令是好的。
**是"真实任务里的子进程环境"和"我手工直测的环境"代码页不同**——这类 bug 只在真跑时现形。

修复后：工具结果 `中文输出测试`（码点 `4e2d 6587 8f93 51fa…`），模型回答
「命令的实际输出是：中文输出测试」。

**验收**：自检 **214/214**（GBK 字节解成中文、不含 U+FFFD、UTF-8 不被误退成 GBK、
空输出不炸、探针四项判定、告警点名、缓存键不含凭据）、SDK **22/22**；
真机：`--model-probe` 两个档都跑过，T9 中文命令输出恢复正常。

**教训（值得留在这一节）**：现象长在模型那一侧（"它说输出是空的"），真因却在自己的
字节处理里。定责顺序应该是：先看**我方落盘的工具结果**，再谈模型行不行。

#### TS-058 模型裁决唯一 ✅

**病因**：两套智能体各判各的模型。TS 侧 `llmConfigFromEnv` 是
`EVA_AI_MODEL || "qwen-plus"`，而它的上游 `/api/iam/access-token` 给的是**硬编码的通道默认**
`qwen-plus`——Python 侧的代码注释早就写明那是**上一代**默认值：

> 通道默认实测是上一代的 qwen-plus——它挂在"自动选择"名下，于是用户选了自动，
> 拿到的却是最老那一档，这条通道的升级永远吃不到。

结果：Python 侧走 `resolve_auto()` 吃目录里的 balanced 档，**TS 侧永远吃旧档**，而用户
以为自己选的是"自动"。这是最难发现的一类漂移——两边都能跑，只是一个始终用旧模型。

**根治办法是收裁决权，不是补一个默认值**：

- 后端新增 `resolve_for_agent()`——**唯一的裁决点**：自定义通道（`custom:<id>`）→
  `auto` 裁决（目录 balanced 档）→ 通道默认。返回**具体**模型名 + 同通道降级链 +
  `source`（这次是谁定的）
- `/api/iam/access-token` 改走裁决，**不再给 TS 一个未裁决的值**；`auto` 这种占位
  也不会出现在返回里（`auto` 不是模型名，发出去就是拿接口不认识的名字去请求）
- TS 侧**删掉兜底模型名**：拿不到模型就报错说清是谁没给，而不是悄悄用旧档
- TS 侧支持请求级降级（`EVA_AI_ROUTES`）：只在**一个字都还没吐出去**时换下一个模型；
  流已经开了再重试会把半截回答重复一遍。401/403 换哪个模型都一样，不重试
- 顺手修：`custom:<id>` 指向不存在的通道时，不再把它原样当模型名返回（那是必败请求）

**实测**（都是真跑，不是读代码）：

| 输入 | 裁决结果 | source |
|---|---|---|
| `auto`（默认） | `qwen3.7-plus` | `auto:catalog` |
| 显式 `qwen-max` | `qwen-max` | `explicit` |
| `custom:nope`（不存在） | 拒绝启动 | 给可读原因 |

另外补了一条运维开关：`EVAWORK_MODEL_PIN`（钉住模型）。它作用在裁决链最上游，
所以**两套智能体一起生效**，不会又变成一边一个样。注意要设在**启动后端之前**的环境里：

```powershell
$env:EVAWORK_MODEL_PIN = "qwen-plus"
pnpm dev
```

> **更正**：这一节最初把"中文命令输出为空"归给了 `qwen3.7-plus`（说它读不到含中文的
> 工具结果），**那个结论是错的**。真因在 TS-059 里查实：是我方把 GBK 字节当 UTF-8 解了，
> 模型拿到的是一堆替换字符。详见 TS-059——这件事本身比结论更值得记：
> **"看起来像模型不行"的故障，先怀疑自己这一层的字节**。
> `EVAWORK_MODEL_PIN` 保留（钉住模型本身有用），但不再是"规避缺陷"的用途。

**验收**：自检 **202/202**（模型链去重+丢 `auto`、没有模型时报错说清、报错里不再出现旧档）、
SDK **22/22**；端到端：裁决模型下 T1（工具闭环+中文）跑通、T8（英文命令）正常、
T9（中文命令）暴露缺陷、钉住后 T9 恢复。

#### TS-051 session-query ✅

`src/query.ts`。事件日志保证了"事实都在"，但没有查询就等于**存了看不见的东西**——
出问题时第一句话永远是"刚才那轮到底发生了什么"，答不上来就是白记。

- 浏览：`listSessions()` 摘要（事件数/步数/目标/结束原因），按最后事件时间倒序
- 搜索：`searchSessions(term)` 全文（大小写不敏感），可限定会话，返回 `会话#seq + 类型 + 片段`
- 导出：`md`（给人看）/ `json`（给程序）/ `jsonl`（原文，可回放）
- **坏行跳过不整份报废**：写到一半崩了的那半条 JSON 不能让整个会话读不出来
- 摘要目前是读全文算的（本地单用户，规模有限）；真变慢了再上索引，现在加只是把复杂度提前

入口：CLI `--sessions` / `--show <id>` / `--search <term>` / `--export <id> [--format …]`；
SDK `session/list` `session/events` `session/search` `session/export`。
**这两类入口都放在"要 prompt / 要凭据"之前**——查历史是最常见的求助动作，
不能因为没配凭据就查不了。

**验收**：自检 **180/180** + SDK **20/20**——列出/摘要/排序/命中/大小写/空词/限定会话/
三种导出/坏行可读；SDK 侧含缺参数 -32602、查不存在返回空数组、非法格式 -32602。

#### TS-060 文件回滚点 ✅

`src/checkpoint.ts` + `tools.ts`（统一落盘口）+ `loop.ts`（按步采集）+ `sdk.ts`（两个方法）
+ 界面复用 T-092 那张回滚点卡。

**做法**：写类工具落盘**前**留快照 → 用户可按「步」撤销。一步 = 一个 step
（`loop.ts` 的 `steps += 1`），同一步里多次写入归到同一个回滚点。

存储用**影子仓库**：`git --git-dir` 落在数据目录、`--work-tree` 指向工作区。
实现是 **isomorphic-git**（纯 JS、无原生编译），**内置**在应用里，
所以不依赖用户机器装没装 git。

**为什么用 git**：内容寻址、去重、差异检测、回滚、gc 它全有——自造等于重新实现
git 的一部分，还拿不到它的成熟度。Cline / Roo-Code 的 checkpoint 也是这条路
（Roo-Code changelog 明写"switch checkpoints to a shadow git repository"）。
（零依赖约束已在 §1.3 解除，这才成为可能。）

**六条语义**（沿用 Python 侧 `checkpoint.py`，它踩过的坑直接继承）：

1. 同一文件同一轮只记**第一次**写入前（撤销回到本步开始前，不是中间态）
2. `sha_after` 在**本步结束**时才定型（同一步后一次写覆盖前一次）
3. 撤销前比对 `sha_after`，被改过 → **整体拒绝**，不静默覆盖后来的改动
4. 快照失败**不阻断写入**，如实标注；撤销时说"这个文件没留住"
5. **空步不留**回滚点
6. **只覆盖写文件类工具**（`write_file` / `patch`）；`run_command` / terminal
   造成的变化不在范围内——界面文案照抄这一句，不给"撤销一切"的错觉

**绝不碰工作区自己的 `.git`**：Cline 在这上面出过事故（issue #5598 把用户的
`.git` 挪成 `.git_disabled`）。同理绝不 `git add -A`，只 add 本次改动的路径。

**踩到的三个坑**（都是"能跑但完全不对"那类）：

| 坑 | 现象 | 修法 |
|---|---|---|
| isomorphic-git 在 Node 下**必须显式传 `fs`** | 不传就抛 `MissingParameterError`，而抛在 try 里 → 表现为"回滚点永远不可用" | 所有调用带 `fs`；失败原因存 `checkpointLastError()`（能力可问，同 TS-056） |
| `git.hashBlob` 返回的**不是**裸字符串 | 拿它当 sha 比对 → 每次撤销都被判成"之后又被改过"，**撤销全部失效** | 改用自算 sha1：这里只需回答"内容变没变"，不必与 git 对象模型对齐 |
| `checkout` 对"index 与 ref 一致、只有工作区被改过"的文件**不写盘** | 撤销返回 `ok:true`、文件纹丝不动——比报错还糟 | 改用 `readBlob` 取回内容自己写 |

界面侧**没有重写**：后端契约里已有 `checkpoint` 帧与那张卡（T-092），
`tsChannel` 只需把 TS 的形状翻译成同一张（`rel`→`path`、`existed`→`existed_before`），
撤销按钮、冲突提示、"已撤销"标记全部复用。撤销调用按 `ts-` 前缀分流：
TS 走主进程（影子仓库），Python 走后端接口。

**验收**：自检 **227/227**（新增 13 条：撤销回原文、新建文件撤销即删除、同一轮两次写、
之后被改过→拒绝、空步不留、撤销两次被拒、超上限如实报、经 runTurn 端到端撤销）；
SDK **27/27**；`pnpm typecheck` 通过。

#### TS-060 后续：打包验证 + 界面实测 ✅（2026-10-07）

**打包验证的做法定为：用成品跑自检**（不是"看文件在不在"）。
这一改立刻抓到两个只在成品里犯的静默错（都已修，见 §5 与 6.3）：

| 只在成品里犯的错 | 开发期的表现 | 成品里的表现 | 怎么发现的 |
|---|---|---|---|
| 共用契约没进包 | 正常（从仓库 `shared/` 读） | 静默退化到内置兜底 → `write_file` 别名不归一 → **写操作全被拒** | 用 `release/win-unpacked/resources/agent-ts` 跑 `selftest.ts`，5 条断言失败 |
| 影子仓库按工作区散列，而 `checkpoint/list` 用 SDK 启动工作区 | 碰巧一致 | 列表永远为空、撤销毫无反应、无报错 | 界面实测（真 Electron 真点按钮） |

**界面实测的做法**：`playwright` 的 `_electron` 起真实 Electron 壳（preload 才有 IPC），
注入侧栏条目 → 点进 TS 会话回放 → 真点「撤销这一轮」→ 断言文件回到改动前、卡片翻成"已撤销"。
用假流造的会话 fixture（不需要真实模型），跑完即删。

两条都写进自检锁住，**不是只修了就完事**。

#### TS-061 工作区隔离 ✅

`src/isolate.ts` + `sdk.ts`（`isolate/*` 五个 RPC + `session/prompt` 带 `isolate` 闭环）。

**先纠正一个判断**：动手前我以为"worktree 是 Python 侧独占的能力"。查完不是——
`apps/desktop-py/evawork/worktree.py` 只是一个**设置页手工工具**：有 create / list / remove / prune，
但**没有 merge / checkout / commit**，而且 `orchestrator.py / agent.py / tools.py` 全都**没引用**它——
建出来的 tree 没有任何 agent 会进去干活。所以 TS-061 不是"迁移"，是**新建**。

**为什么不用 git worktree**（Python 侧用的就是它）：

- 它要求**本机装了 git** 且**工作区本身是仓库**——两个前提都不一定成立
- isomorphic-git 没有 `worktree` 子命令
- 复制 + 按内容比对合回，是我唯一能同时满足"能用"和"不依赖外部环境"的做法

**核心设计：不改主循环。** 调研确认所有文件系统类工具都是**每次调用时**按
`ctx.workspace` 现算路径（`sandbox.ts` 的 `resolveInWorkspace`），因此只要把传给
`runTurn` 的 workspace 换成副本路径，工具、沙箱、终端、回滚点自动全部跟着走——
`loop.ts` 里不需要任何"隔离模式"分支。自检里有一条专门证明这件事（跑真工具调用）。

**几条边界（都有依据，不是随手加的）**：

| 边界 | 为什么 |
|---|---|
| 副本落在**工作区内** `.evawork/isolates/` | 放工作区之外沙箱进不去——Python 侧 `worktree.py` 同一条理由 |
| 复制时跳过 `node_modules` / `dist` / `.git` 等 | 复制它们只会拖慢并吃满磁盘（shadow git 的通病，见 6.3） |
| 隔离名白名单（`../` 被规范化） | 名字要进路径，别让它可以指到工作区外 |
| `abandon` 只删受管目录内的东西 | 删了别人的没法赔（Python 侧 `prune` 同一条纪律） |
| 复制失败 → **整轮不开始**并说清原因 | 在"半个副本"上干活，合回会把半成品盖到真工作区上，比不隔离还糟 |
| 合回前先用回滚点留快照 | 隔离保证"改的时候没碰到"，回滚点保证"合"本身也能退——两条叠起来才算完整 |

**踩到的坑**：隔离原本写在 `runPrompt` 里**靠后**的位置（取 LLM 配置之后），
结果"没配模型"这种无关的错会让副本根本没建起来——用户以为自己在隔离里改，
其实连那层保护都没起来。现在移到**所有可能失败的步骤之前**（自检撞出来的）。

**验收**：自检 **239/239**（新增 12 条）、SDK **35/35**（新增 8 条）、打包产物自检通过。

**界面入口 ✅**（2026-10-07 补完）：输入栏的「在副本里改」开关（默认关——合回是有代价的
动作，不该顺手发生）、副本卡片（明确写出"改动还没进工作区"）、以及
**查看差异 / 合回工作区 / 丢弃**三个按钮。主进程用一个 `isolate` 通道按 `method`
分发，**工作区解析仍在 SDK 侧**（TS-060 那次"查错仓库"的教训）。

**实测**（Playwright + 真 Electron，真点击）：造一份带 `isolate/created` 的会话 →
回放出隔离卡片 → 点「查看差异」→ 真实走 IPC → 主进程 → SDK → 真副本，返回
"改动 1：a.txt / 新增 1：new-in-iso.txt"，而**工作区的 a.txt 全程是原始内容**。

#### TS-062 plan mode / 只规划 ✅

对齐 Claude Code 的 **plan mode**（§6.1 里标的那个缺口）：选这一档就是"先给方案，
别动手"。

**关键判断：写/命令/联网一律"直接拒绝"而不是弹审批。** 用户选 plan 就是不想现在动手，
弹审批等于问"要不要现在动手"——那是在把决策推回给一个已经做过决定的人。

**改动小得出奇，因为语义早就在**：`plan` 档在共用契约里就是 `on_risky: deny`，
而 `write / command / network / install / computer_control` 本来就都是高风险动作，
`read` 与 `memory_write`（写待办）本来就不是。所以 **`approval.ts` 一行没改**——
这正是"档位语义来自契约"这条设计在三年后仍然成立的样子。

| 层 | 改动 |
|---|---|
| `shared/agent-contract.json` | 加 `plan` 档（两侧共用的同一份定义） |
| `types.ts` | `ApprovalPolicy` 加 `"plan"` |
| `cli.ts` | `parsePolicy` 认 plan；**沙箱联动** plan → `read-only`（serve 与 manifest 两处） |
| `prompt.ts` | 审批那节加 plan 文案 |
| `main.js` / `tsAgent.ts` | 界面「只规划」→ `policy: plan`（换档会重启 TS 子进程，档位是启动时定死的） |
| 界面 | 审批下拉加「只规划」（仅 TS 模式可见，写明只对 TS 生效） |

**提示词那一节才是关键**：只说"不许写"，模型会反复试写然后被拒——那看起来就像模型不听话。
所以文案直接说清"你的任务是读清楚现状、给出可执行的方案，用 todo 列出步骤，
用户认可后会说「开始做」，那时才动手"。

**诚实边界**：Python 后端没有这一档，界面选了会按「手动审批」跑（下拉里写明只对 TS 生效）。

**验收**：自检 **247/247**（新增 8 条：契约里有 plan、写/命令/联网直接拒绝、读与待办放行、
write_file 走不到人面前、提示词含"只规划"）。

#### TS-066 办公文档四件套 ✅

docx / xlsx / pptx / pdf。**这不是"又加几个工具"，是补上一个一直空着的能力位**——
官方那四个技能（docx/pptx/xlsx/pdf）是 Anthropic **专有许可**（source-available,
not open source，且捆绑 GPL 的 FFmpeg），所以只能自己实现。

| 工具 | 做什么 | 读 | 写 |
|---|---|---|---|
| `create_document` | Markdown → .docx（`#` 标题、`- ` 要点、可选 JSON 表格） | | ✅ |
| `read_document` | 读 .docx / .xlsx 文本（表格按行返回） | ✅ | |
| `create_spreadsheet` | 表头 + 数据行 → .xlsx（可指定工作表名） | | ✅ |
| `create_slides` | `{title, bullets, note}[]` → .pptx | | ✅ |
| `create_pdf` | 正文 → .pdf（空行分页、自动折页、页码） | | ✅ |

**刻意没做的**：PDF **读取**（要引入 pdfjs-dist，体积大得多；用别的工具抽文本更合适）。
工具描述里明写了这一点，不让模型以为它能读 PDF。

**依赖**（都是 MIT/Apache、纯 JS、无原生编译）：`docx` / `exceljs` / `pptxgenjs` /
`pdf-lib` + `jszip`（读 docx）+ `@pdf-lib/fontkit`（中文 PDF）。**全部动态 import**——
用到才加载，不给启动路径添 200ms。

**四个真实踩过的坑**（写进 office.ts 文件头，省得下次再踩）：

| 坑 | 现象 | 修法 |
|---|---|---|
| **PDF 的中文** | pdf-lib 的 14 个标准字体是 WinAnsi 编码，`drawText("中文")` 直接抛 `WinAnsi cannot encode "中"` | `registerFontkit` + 嵌入系统中文字体（黑体/雅黑/等线/宋体按序找）。**找不到就明确报错并建议改用 docx**，绝不静默出一份乱码 PDF |
| **嵌入体积** | 不做子集化的话，每个 PDF 都是 9MB 起（黑体 9.3MB） | `subset: true`——实测 9.3MB 字体嵌四个字只产出 **4.4KB** |
| **pptx 的要点列表** | 传 `string[]` 报 `Cannot create property 'options' on string` | 必须传 `[{ text, options: { bullet: true } }]` |
| **exceljs 的导入形状** | `new mod.default()` 报 "not a constructor" | 它是 CJS 包，`default` 是 module.exports 对象，真正的类在 **`default.Workbook`** |

**两条设计决定**：

1. **输入用 Markdown / JSON 字符串，不让模型拼 OOXML**。模型写 Markdown 几乎不会错，
   拼 OOXML 一定会有结构错误。复杂参数（表格/幻灯片/数据行）一律传 JSON 字符串——
   OpenAI 兼容接口对 array/object 参数的支持参差，而字符串一定到得了。
2. **落盘走统一出口 `writeText`**，所以**生成文档也在回滚点覆盖范围内**（TS-060）。
   否则"能生成文件"和"生成的文件能退回去"就是两件事——自检里有一条专门经 `runTurn`
   验证：撤销后生成的 docx 确实消失。

**契约零改动**：5 个工具全部映射到既有的 `read` / `write` 动作，所以 plan 档
（TS-062）天然"拒绝生成文档、但放行读取"——正是该有的语义。

**验收**：自检 **277/277**（新增 16 条：五个工具都注册、docx 读回标题/段落/要点/表格、
xlsx 读回表头与数据、中文 PDF 走嵌入字体、PDF 文件头正确、经 runTurn 生成文档也留回滚点、
撤销后文件消失、JSON 错时说清示例、扩展名错时说清只支持什么、plan 档拒绝生成放行读取）；
SDK **40/40**；**打包产物自检必须同样通过**——本轮新增 6 个 npm 依赖，
按 TS-057 的纪律要用成品跑，而不是看文件在不在（历史上栽过两次）。

> 顺带修掉三条**会随功能增长而失效的断言**：原来写着"工具恰好 9 个""schema 生成 9 份"
> 这类写死数字的断言——这轮加了 5 个工具就全炸了。改成下限守卫 + 按名字 `findTool`。
> 失效的断言比没有断言更糟：它会让人以为覆盖率还在。

#### TS-063 上下文连续性 + 撤销对话 ✅

**先说个发现，它比"撤销对话"本身更重要**：`context.ts` 里的 `projectEvents`
写好了、有自检覆盖，但 `loop.ts` **从来没调用过它**。也就是说每一轮发出去的消息是
「system + 当前这一句」——**追问是没有记忆的**。用户以为它记得上文，它其实每次都从零开始
（而事件日志里明明记着前几轮说了什么）。

rewind（Claude Code `/rewind` 的另一半）的前提是"对话是累积的"，所以先补连续性：

| 层 | 改动 |
|---|---|
| `loop.ts` | 投影历史事件进上下文（system → 历史 → 当前提问），并按预算压缩（保轮次完整、不拆散 tool 配对） |
| `session.ts` | `rewindPoint` / `turnStartSeq` / `turnCount` / `recordRewind` 四个原语 |
| `sdk.ts` | `session/rewind { toTurn }` |
| 界面 | 每轮用户消息旁「从这里重跑」（仅 TS 会话——回退语义不同就不假装一致） |

**回退的定义**：回到第 N 轮**开始处**（那一轮的问题会被丢掉，可以换个问法重来），
与 `/rewind` 的语义一致。

**不删事件**。rewind 只写一条 `session/rewound` 事实，退掉的轮次仍在日志里（可查、可导出），
只是**不再被算进上下文**。日志是 append-only 的真相源，rewind 改的是"往哪儿看"，
不是"发生了什么"——这是 §0 那条原则的直接应用。

**验收**：自检 **253/253**（新增 6 条：追问真的带上了历史、system 没被重复灌入、回退点生效、
回退后第 2 轮不进上下文而第 1 轮还在、**rewind 不删事件**、无效轮次返回 0）、
SDK **40/40**（新增 4 条：缺参 -32602 ×2、回到不存在的轮次 -32006 且说清当前几轮、rewind 只记事实）。

---


#### TS-064 子代理轨迹回传 ✅

**先说清现状**：界面上早就有"子代理干了什么"那张卡（T-090，数据源是后端的
`tool_result.subagent`）。所以这不是"新建视图"，而是**把 TS 侧的数据接上去**——
此前 `runSubagent` 只带回一句结论摘要，TS 会话那张卡**永远是空的**：
派了活却看不见，等于"派了就信了"。

| 层 | 改动 |
|---|---|
| `types.ts` | `SubagentTrace`（形状与界面 `SubagentTrace` **刻意一致**）+ `ToolResult.subagent` |
| `subagent.ts` | 收集每次工具调用（工具名 / 成败 / 结果摘要）+ 轮数 + 总耗时 |
| `loop.ts` | `tool/result` 事件带上轨迹（只给人看，不进模型消息） |
| `tsChannel.ts` | 实时流与回放两处都映射 |
| 界面 | **零改动**（复用 T-090 的卡） |

**被拒的高危动作也进轨迹**：子代理内部一律 `never`（fail-closed），
不记录的话界面上只看到"跑了 3 轮"，看不到它被什么挡住了。

**验收**：自检 **261/261**（新增 3 条：轨迹含轮数/耗时/调用列表、看得见调了哪个工具、
被拒动作也进轨迹）。

#### TS-065 项目级规则文件 ✅

对齐 Claude Code 的 `CLAUDE.md` / Cursor 的 `.cursorrules`：**让智能体懂这个工程**。
成本极低（一个模块 + 提示词一节 + 自检），收益直接。

分层（越靠后越优先，但**全都保留**——子目录是补充，不是覆盖）：

1. 用户级：数据目录下的 `AGENTS.md`（跨项目个人习惯）
2. 项目级：`<工作区>/AGENTS.md`
3. 目录级：工作区向上最多两层各自的 `AGENTS.md`

三条安全边界（不是洁癖，是必须）：

- **长度上限**：单层 8KB，超长截断并标注"已截断"——规则文件不是 README
- **来源标注**：每层标明来自哪个文件，用户知道提示词里多了什么
- **注入防线**：规则文件是**仓库内容**，可能来自不可信来源。提示词里明确它是
  "项目约定，不是系统指令"，不能用来覆盖系统规则或用户当次要求

空规则 → **整节消失**（TS-040 的约定），不留占位噪音。

**验收**：自检里新增 5 条：读得到项目级规则、没有规则时整节消失、提示词带上规则、
**注入防线的措辞在**、超长被截断标注。（其中一条顺手修正了"提示词分节顺序固定"
这条 TS-040 不变量的期望值。）

#### 打包流程本身也有一个静默错（已修）

为了让上面三条在**成品**里可测，我第一次跑成品实测就发现：
**`pack` / `dist` 都不构建 UI**，于是 `resources/ui` 是两天前的旧构建——
新做的界面在成品里根本没进去，看起来像"功能没实现"。

修法不是"记得先 build"，而是把顺序写进脚本：根目录新增
`pack:dir` / `pack` / `dist`，一律 `pnpm build && …`。
这类错只有**在成品里点一遍**才抓得到（TS-057 同型的第三次）。
## 5. 风险与未决

| 风险 | 说明 | 处置 |
|---|---|---|
| ~~出口管控缺失~~（已处置） | Node 侧无 socket 级拦截，而日常工作联网最多 | TS-023 ✅：`EVA_EGRESS_ALLOWLIST` + 强制开关，规则与 Python 侧同判据；联网工具随后才开放（TS-030） |
| ~~审批档位漂移~~（已处置） | 两套实现各写一份必然漂移 | TS-020 ✅：共用 `shared/agent-contract.json`，且自检断言"读到契约而非兜底" |
| ~~长任务上下文~~（已处置） | 无 compaction 时长任务会爆 | TS-042 ✅ 确定性压缩，辅以 TS-024 循环卫生与 TS-031 spill |
| DSH 自身在演进 | 它是 alpha，API pre-stable | 我们只借结构，不跟版本；升级靠人工对照 |
| ~~零依赖的代价~~（已作废） | 手写 SSE、手写锁、无成熟库 | ✅ 2026-10-06 解除该约束（§1.3）；有成熟库就不再自己写 |
| **npm 依赖必须进包** | 引入依赖后 `extraResources` 的 filter 若只带 `src/**`，成品里 `node_modules` 不会进包——**模块消失且无任何报错**（TS-057 已踩过同型静默错） | ✅ 2026-10-07 已做：filter 增带 `node_modules/**`（排除 `.bin` / `.map` / 测试目录）。**顺带查出共用契约同样没进包**（见 6.3），两侧一起补上 |
| 界面二选一的认知成本 | 用户要理解两套智能体的区别 | ✅ TS-052：设置页写明「互不感知、各自独立存储与历史」；任务页按选择走对应通道，点到 TS 会话时也说清它不在任务列表里 |
| ~~TS 会话不能回看~~（已处置） | §4 TS-052 第 2 段写的"TS 会话不能从任务列表回看" | ✅ 2026-10-06 已补：主进程读落盘 JSONL 回放（`tsAgent.js` 的 `replay` + `tsChannel.replayTsTask`），按轮重建对话与执行过程；回看完绑定 taskId 可直接追问。该段描述已过时，以本节为准 |

---

## 6. 与前沿智能体实践对照（升级索引）

> **这一节是升级用的对照表，不是需求。**
>
> 用法：每次要加一项能力，先到这里看「前沿怎么做 → 我方差在哪 → 为什么暂不照搬」，
> 再决定自建还是复用。与第 0 节同一条原则：**借结构与设计，不搬代码**。
>
> 日期：2026-10-06

### 6.0 参照对象与证据强度

| 对象 | 参照它的什么 | 证据强度 |
|---|---|---|
| **DeepSeek Harness (DSH)** `0.2.1-alpha.1` | 模块边界、事件模型、扩展点（`pre-execute`、fail-closed） | **一手**（本地仓库，可直接读源码） |
| **Cline / Roo-Code** | checkpoint 实现、审批与全可见性 | **一手**：Roo-Code changelog「switch checkpoints to shadow git…thanks Cline」+ Cline `CheckpointTracker` 源码片段 |
| **Claude Code** | checkpoint/rewind、权限档（plan mode）、hooks、subagents、skills、CLAUDE.md | 二手中文来源为主；`/rewind` 细节**待验证** |
| **Aider** | 用 git commit 承载撤销、repo-map（代码结构摘要） | 记忆，待验证 |
| **Anthropic 工程博客** | harness 设计原则 | 二手转述，多条来源结论一致 |

引用 Anthropic 的结论（转述）：harness 的价值主要不在模型，而在**状态管理、检查点、校验与干净交接**这类朴素的系统工程；且**先做最简单的模式，复杂度只在有度量依据时才加**——有些为早期模型设计的机制（如上下文重置）在新模型上不仅无用甚至有害。

### 6.1 能力对照矩阵

| 能力 | 前沿做法 | 我方现状 | 差距与判断 |
|---|---|---|---|
| 事件日志为真相源 | 普遍共识（DSH durable events） | ✅ `session.ts` JSONL 只追加，投影可重建 | 一致，且做得更彻底（压缩是确定性投影） |
| 上下文压缩 | Claude Code `/compact` | ✅ TS-042 确定性压缩（不靠模型总结） | 我方更强：不需要额外模型调用，离线可压 |
| **文件回滚（checkpoint）** | Cline/Roo **shadow git**；Claude Code `/rewind`（代码+对话） | ✅ TS-060（内置 git 影子仓库，按步撤销） | **对话 rewind**（回到某一轮重问） | Claude Code `/rewind`（对话 + 代码一起退） | ✅ TS-063：回到第 N 轮开始处；**不删事件**，只改上下文起点 | 代码那一半由 TS-060 回滚点 / TS-061 隔离承担 |
| **上下文连续性** | 普遍共识（追问要接上文） | ⚠️→✅ TS-063 之前**每轮从零开始**（`projectEvents` 写好了却没人调用），已修并锁进自检 | 这一条曾长期没人发现：自检覆盖了投影函数，却没覆盖"它被调用了吗" |
| **工作区隔离**（在副本上大改、改好再合回） | Claude Code 无此物；Cline/Roo 无此物；Python 侧 `worktree.py` 经查**只是设置页手工工具**（见 6.4b） | ✅ TS-061：副本 + 按内容比对合回 + 丢弃；合回前留回滚点，于是"合"本身可撤销 | 界面入口（任务页的"在副本里改"）未做；大工程复制耗时未优化 |
| 权限档位 | Claude Code：`default` / `acceptEdits` / **plan mode**（只读规划） / `bypassPermissions` | ⚠️ 只有 `ask` / `never`（TS-020） | 缺 **plan mode**——"先给方案不改文件"是高频诉求 |
| 工具钩子 | Claude Code hooks（Pre/PostToolUse） | ⚠️ 只有前置 `pre-execute`（DSH 借来） | 缺**后置**钩子；回滚点/审计/统计都需要它（见 6.2） |
| 子代理 | Claude Code subagents / Task | ✅ TS-043（独立上下文 + 内部 fail-closed）+ TS-064（轨迹回传，界面复用 T-090 那张卡） | 一致；我方"子代理内一律 never"是**更严**的选择 |
| MCP | 事实标准 | ✅ TS-032（零依赖 stdio，默认按高危审批） | 一致；我方默认不信任外部服务，更保守 |
| Skills | Claude Code Skills（模型自动触发） | ✅ TS-033 `SKILL.md`（只上摘要，全文按需） | 一致 |
| 项目规则文件 | `CLAUDE.md` / `AGENTS.md` / `.cursorrules`（分层：用户级/项目级/目录级） | ⚠️ `skill.ts` 是**按需加载**的技能，未见项目级规则自动注入 | 待确认；缺则补（最便宜的"让智能体懂这个工程"的手段） |
| 计划/待办 | Claude Code TodoWrite | ✅ TS-045（存事件日志，step 边界回灌） | 一致 |
| 审批 | 人机协同、fail-closed | ✅ TS-020/021（无人应答=拒绝，不挂起） | 一致 |
| 沙箱 | 多数工具只做路径/命令过滤 | ✅ TS-021/022/022b（含 Windows 受限令牌+ACL） | **我方强于多数同类**（真进程级写限制） |
| 后台任务 | Claude Code background bash | ✅ TS-044 句柄式 jobs | 一致 |
| 持久终端 | 真 PTY（DSH `ptc-runtime`） | ⚠️ TS-034 近似（每条一进程 + 记 cwd） | 已知边界，已对模型说明；交互式命令不支持 |
| 代码结构理解 | Aider repo-map；LSP | ❌ 只有 `grep`（字面匹配） | 大工程里"先看结构再动手"的能力缺失 |
| 搜索 | ripgrep（正则、快） | ⚠️ 自研字面 grep | 刻意选择（模型写的正则常错）；但性能与能力弱于 ripgrep |
| 遥测 | 普遍有 | ✅ TS-053（只记名字与数字） | 一致 |
| 会话续跑 | `--resume` / `--continue` | ⚠️ 事件日志可重开（seq 接续），界面侧"继续"仅 Python 有 | 待补：TS 侧中断后续跑 |
| 浏览器/桌面控制 | computer-use / browser-use | ⏸ 未做 | 日常工作场景迟早要，但优先级低 |
| 多模态输入 | 截图/图像理解 | ⏸ 未做 | 同上 |

### 6.2 差距 → 升级优先级

**P0（必须，涉及数据安全）**

1. ✅ ~~文件回滚点（TS-060）~~：已落地（影子仓库 + 按步撤销）。
2. ✅ ~~工作区隔离（TS-061）~~：已落地（副本 + 差异合回 + 丢弃，合回本身可撤销）。
   **注**：原以为这是 Python 侧独占能力，查下来不是——见 6.4b，它只是个手工工具。
3. ✅ ~~撤销对话（TS-063）~~ 与 ~~plan mode（TS-062）~~：都已落地。
4. **下一个缺口**：仓库还认得出"这一轮动过哪些文件"（回滚点/隔离），但**没有全局时间轴**——
   逐轮按钮够用，跨会话的"上次改到哪"仍要靠搜索；以及子代理的产出没有汇总视图。

**P1（决定"好不好用"）**

2. **后置钩子**：把"工具执行后"做成统一挂点。回滚点、审计、产物登记、统计都能挂上去，
   而不是每次往 `loop.ts` 里塞代码。**先有第二个真实用例再造**，不为空想设计。
3. **项目规则文件**（`AGENTS.md` 之类，分层加载）：成本极低、收益极高——它决定智能体
   "懂不懂这个工程"。
4. **plan mode**：只规划不改文件。与现有两档并列，不是替换。
5. **TS 侧中断续跑**：事件日志已支持，缺界面入口。

**P2（决定"优秀"）**

6. 代码结构摘要（repo-map 思路，可用零依赖自研的轻量版，不必上 LSP）
7. 浏览器/桌面控制
8. 搜索能力增强（正则 + 性能；是否换成 ripgrep 需权衡零依赖约束）

### 6.3 已知事故（别人的坑，直接规避）

| 事故 | 来源 | 我方规避办法 |
|---|---|---|
| Checkpoint 把用户 `.git` 挪成 `.git_disabled`，**污染用户仓库** | Cline issue #5598 | 用**独立 git-dir**（`--git-dir` 指向数据目录、`--work-tree` 指向工作区），**绝不触碰工作区 `.git`** |
| 影子仓库把 `node_modules` 等巨量文件吞进去 | shadow git 的通病 | 严格 ignore；且**只 add 本次改动路径**，不用 `git add -A` |
| 一次 add 把用户无关改动卷进回滚点 | 同上 | 同上：只 add 智能体实际写的路径 |
| 撤销覆盖后来的人工改动 | Python 侧 checkpoint 设计第 3 条 | 撤销前比对"这一轮之后文件是否被改过"，是则拒绝并说清 |
| **共用契约没随包分发 → 静默退化到内置兜底** | **2026-10-07 打包验证实测**（用成品跑自检发现的） | `extraResources` 增带两侧契约（`backend/contract/`、`agent-ts/contract/`）；并把 `capabilities.contract` 暴露出来——**能力要能问**，不能等到用户撞上"点了完全访问还是写不了" |
| **影子仓库查错分支** | **2026-10-07 界面实测发现**：影子仓库按工作区路径散列，而 `checkpoint/list` 用的是 SDK 启动时的 `--workspace`——API 正常返回，列表却是空的，撤销毫无反应且**无报错** | 改为按会话**实际用过**的工作区查找（从事件的 `workspace` 字段读），并锁进 SDK 自检 |
| 为留快照让写入失败 | Python 侧第 4 条 | 快照失败**不阻断写入**，如实标注；撤销时说"这个文件没留住" |

### 6.4 文件回滚（TS-060）：方案与待定项

**结论：必须做。** 方案三选一，取舍如下（零依赖约束见 §1.3）：

| 方案 | 做法 | 优点 | 代价 | 评价 |
|---|---|---|---|---|
| **A. shadow git**（调系统 git） | `git --git-dir=<数据目录> --work-tree=<工作区>`，逐步提交，回滚用 `restore` | 零依赖不变；git 提供内容寻址/去重/差异/gc | **机器必须装 git**；没装则功能不可用 | 推荐为**主路径** |
| **B. 自研极简快照** | 借 git 的**思想**（内容寻址：sha1 + 不可变对象 + 清单），只实现写入/回滚/变更检测，约 200–300 行 | 零依赖、**永远可用**；无外部前提 | 只覆盖我们要的 5%，不追求 git 兼容 | 推荐为**保底路径**（若要求覆盖无 git 机器） |
| **C. 引入 `isomorphic-git`** | 纯 JS 的完整 git 实现，可内置 | 成熟、久经考验、能力完整；**无原生编译** | 需随包分发 `node_modules`（打包 filter 要带，见 §5） | ✅ **选定**（2026-10-06：§1.3 零依赖约束已解除） |

**为什么最终选 C**：解除了零依赖约束之后，"能复用就复用"应当压倒"自己写 250 行"。
isomorphic-git 是**纯 JS、无原生编译**的成熟实现，正好满足 §1.3 的选包偏好；它是内置在应用里的，
因此**不依赖用户机器装没装 git**——"必须要有"这条也一并满足。
（原方案 B 的论证仍然有效，只是不再是首选：若将来 isomorphic-git 在打包/体积上暴露问题，
B 是约 250 行的退路，接口不变即可换——与 TS-025「storage 后端可换，接口保持不变」同一套路。）

**不管选哪个，这几条语义不变**（沿用 Python 侧 checkpoint 已验证的五条）：

1. 一轮 = 一个 **step**（`loop.ts` 的 `steps += 1`，比 Python 侧 `execute_batch` 更清晰，无串台风险）
2. 同一文件同一轮**只记第一次写入前**（撤销回到本步开始前，不是中间态）
3. 撤销前**比对是否被后续改动过**，是则拒绝覆盖
4. 快照失败**不阻断写入**，如实标注
5. 空 step **不留**回滚点（没有东西可撤时不让按钮亮着）
6. **诚实边界**：只覆盖 `write_file` / `patch`；`run_command` / terminal 造成的文件变化不在范围内——写进界面文案，不给"撤销一切"的错觉

**已落地**：TS-060 按方案 **C** 实现——内置 isomorphic-git + 影子仓库，不依赖本机 git。

**遗留待办**：`node_modules` 必须进打包产物（见 §5）。TS-054 的 `extraResources`
filter 若仍只带 `src/**`，成品里回滚点会**凭空消失且没有任何报错**
（与 TS-057 同型的静默错）。下次真机打包验证要断言产物里含 `node_modules/isomorphic-git`。

### 6.5 以后怎么对照升级（流程，写在这里以免忘）

1. **动手前先查**：这项能力前沿叫什么、怎么做（Claude Code / Cline / Codex / OpenHands / Aider）
2. **能复用成熟基建就复用**：git（版本与回滚）、MCP（外部能力）、ripgrep（搜索）、LSP（代码理解）
3. **顺带搜它的已知事故**，把别人的坑直接写进我们的设计（见 6.3）
4. **说明我们为什么不同**：差异点才自己写，并写进代码注释
5. 结论回写本节（对照矩阵 + 优先级），保持"升级索引"是最新的
