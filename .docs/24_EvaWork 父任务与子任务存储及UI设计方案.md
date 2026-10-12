# 24 · EvaWork 父任务与子任务存储及 UI 设计方案

> 上游依据：`23_EvaWork Trace 问题诊断与改进清单.md`（根因定位）、`19_EvaWork 借鉴 Claude Code 改进清单.md`
> 落地对象：`apps/agent-ts`（`session.ts` / `subagent.ts` / `loop.ts` / `query.ts`）、`apps/desktop-node`（`tsAgent.js`）、`apps/desktop-ui`（`stores/ui.ts` / `api/tasks.ts` / `api/tsAgent.ts`）
> 角色定位：**资深智能体架构师**视角，面向"任务（session）即智能体会话"这一 EvaWork 核心范式，给出可落地的父子任务存储与展示方案

---

## 1. 问题回顾与设计目标

### 1.1 现状痛点（`23` 号已定位）

EvaWork 目前 **没有独立的任务表**，"任务列表"的真相源是扫描 `~/.evawork/ts-agent/sessions/` 下所有 `.jsonl`。子代理执行时（`subagent.ts:39` `new SessionLog(\`${parentLog.id}-sub-${seq}\`)`）被当作**顶级会话**落盘到同一目录，而 `tsAgent.js:390` 的 `listSessions()` 只按 `.jsonl` 后缀过滤、不过滤 `-sub-`。于是每条子代理日志以 goal 首行为标题，作为独立任务出现在列表里。

本质缺陷：**数据模型层面没有父子关系字段**，父子只编码在文件名约定里；读取侧没有过滤，也没有树形展示。

### 1.2 设计目标

| 目标 | 含义 |
|---|---|
| G1 父子可区分 | 存储层显式携带 `parentId` 与 `kind`，不再依赖文件名约定 |
| G2 列表干净 | 默认只展示根任务；子任务可折叠为父任务的子节点，而非并列污染 |
| G3 可追溯 | 父任务能回溯"派生了哪些子任务、各自花了多少 token/时间/是否成功" |
| G4 零数据丢失 | 子代理日志**保留**用于调试，只是默认不进列表 |
| G5 兼容历史 | 旧 `-sub-` 命名日志在迁移后仍能正确归并到父任务 |
| G6 对标前沿 | 采用业界通用的 Trace/Span 层级模型，而非自创结构 |

---

## 2. 行业前沿方案调研

作为设计论据，调研了六类主流做法，共性结论高度一致：**把"一次完整目标"建模为一棵有根的执行树（Tree / Trace），节点间用 `parent` 引用 + `kind` 区分，而非平铺列表**。

| 方案 | 父子任务的核心机制 | 对 EvaWork 的启发 |
|---|---|---|
| **OpenTelemetry / OpenInference（可观测性事实标准）** | 一次请求 = 一个 `trace`，由若干 `span` 组成；每个 span 带 `trace_id` + `parent_span_id`，天然形成树。Agent 框架（LangChain/LlamaIndex）的 trace 都是这个模型 | **直接采用**：session = trace，turn/subtask = span；树由 `parent_id` 而非目录位置决定 |
| **LangGraph（有状态编排）** | `checkpointer` 按 `thread_id` 持久化图状态；`subgraph` / `superstep` 把子图执行结果聚合回父图状态。父子共享同一 `thread`，子图状态是父状态的一个命名子空间 | 父任务持有子任务引用与聚合结果；子任务状态隔离但可回溯 |
| **CrewAI（层级流程）** | `Crew → Task → Agent`，支持 `sequential / hierarchical` 流程；task 之间通过 `context` 传递产物，manager agent 负责分解与回收 | 子任务有"产物（output）"概念，可向上聚合为父任务的进度/结论 |
| **AutoGen（事件驱动多智能体）** | `Core` 是事件总线，`AgentChat` 的 `Team`/`SelectorGroupChat` 中任务通过 `sender→receiver` 事件流转；子会话是 team 内的协作单元 | 父子不是"谁调用谁"的命令式，而是事件拓扑；便于后续做并行子任务 |
| **Claude Code（子智能体）** | 父会话里写 `subagent/start` + `subagent/result`（含子会话 id），子代理有**独立上下文窗口**，执行完把结果 handback 给父。EvaWork 的 `subagent.ts` 已部分实现这一点 | 复用现有 `subagent/start|result` 事件作为父→子的"指针"，补齐 `parent` 元数据 |
| **OpenAI Agents SDK / Swarm** | `handoffs` + 统一 `tracing`，每个 agent run 是 trace 下的子 span；UI 里父 run 可展开看到 handoff 到的子 run | 列表即"可展开的 span 树"，与 G2/G3 完全契合 |

> **提炼出的统一范式**：`Trace（根任务）→ Span（轮次/子任务）`，节点带 `id / parent_id / kind / status / timing / token_usage`。EvaWork 的"会话 = JSONL 事件流"天然契合 span 模型——只要给每个 session 补上 `parent_id` 和 `kind` 头。

---

## 3. 总体架构：Trace-Span 模型

把现有"平铺的 session 目录"升级为**有根的森林**：

```
root-task-A  ──sub──> sub-task-A1 (只读调研)
            ──sub──> sub-task-A2 (编码)
            └──sub──> sub-task-A3 (测试)
root-task-B  (无子任务，单轮)
```

- 一个 **root task** = 用户发起的一个目标（一次 `tsAgentPrompt` 触发）。
- 每个 **subtask** = 一次 `delegate` 调用产生的子代理会话（`runSubagent`）。
- 关系由 `parent_id` 显式表达；目录位置不再承担语义（兼容旧 `-sub-` 命名）。

---

## 4. 存储方案（落点：`session.ts` / `subagent.ts`）

### 4.1 数据模型

为 `SessionLog` 增加结构化头事件，作为每条会话的"元数据首行"：

```ts
// session.ts —— 新增 SessionMeta 类型
export type SessionKind = "root" | "subtask" | "job"   // job = 后台任务（见 23 号 P1-7）

export interface SessionMeta {
  type: "session/meta"
  id: string                 // 会话 id（文件名去掉 .jsonl）
  parentId: string | null    // 根任务为 null；子任务为父会话 id
  kind: SessionKind
  goal: string               // 任务目标（列表标题来源，已是现状）
  workDir: string            // 用于按工作区分组（现状 ui.ts:137 taskGroups）
  model: string
  createdAt: string          // ISO 时间戳
  status: "running" | "done" | "error" | "aborted"
  usage?: { promptTokens: number; completionTokens: number; cachedTokens: number }  // 复用 23 号 P1-5
}
```

`SessionLog` 在构造时**强制先写这一行**（无论根/子），后续 `turn/start`、`subagent/*`、`turn/end` 照旧追加。

### 4.2 子任务创建（修复 `subagent.ts:39` 的缺陷 A）

```ts
// subagent.ts —— runSubagent
export async function runSubagent(o: SubagentOpts): Promise<SubagentResult> {
  const id = `${o.parentLog.id}-sub-${++seq}`          // 保留现有命名，向后兼容
  const log = new SessionLog(id, {                     // 构造参数新增 meta
    parentId: o.parentLog.id,
    kind: "subtask",
    goal: o.goal,
    workDir: o.workDir,
    model: o.model,
  })
  o.parentLog.append({ type: "subagent/start", session: id, goal: o.goal, parentId: o.parentLog.id })
  // ...原有 runTurn 逻辑不变
  o.parentLog.append({ type: "subagent/result", session: id, ok, summary })
  return result
}
```

> **顺带修掉 `23` 号未覆盖的次要 bug**：`seq` 是模块级变量，子进程重启归零会重名。改为基于"父目录内已有 `-sub-N` 计数"或写入 meta 时递增 `parentLog` 的计数器，保证唯一。

### 4.3 目录与文件（保持现状，零迁移风险）

- **不拆目录**：所有 `.jsonl` 仍落在 `sessions/`，避免破坏 `trace` 解析脚本（`23` 号 §11）。
- **子任务日志保留**：满足 G4，调试时可直接读子代理上下文。
- 标题与分组逻辑不变，仅增加按 `parentId / kind` 的过滤与树构建能力。

---

## 5. 读取 / 查询层（落点：`tsAgent.js` `listSessions()` / `query.ts` `listSessions()`）

把"全量平铺"改为"构建森林 + 默认只返根"。

### 5.1 列表查询（修复 `tsAgent.js:390` 的缺陷 B）

```js
// tsAgent.js —— listSessions()
const files = (await fs.promises.readdir(dir)).filter(n => n.endsWith('.jsonl'))
const metas = await Promise.all(files.map(f => readMeta(dir, f)))   // 只读首行 session/meta

const roots = metas.filter(m => m.kind === 'root' || (!m.parentId))
const byParent = group(metas, m => m.parentId)

// 返回树：根为列表项，children 挂其子任务
return roots.map(r => ({
  ...r,
  childCount: (byParent[r.id] || []).length,
  children: (byParent[r.id] || []).map(c => ({ ...c, parentId: r.id })),
  // 聚合：子任务的总 token / 耗时 / 失败数（G3）
  agg: aggregate(byParent[r.id] || []),
}))
```

- `readMeta` 只读 JSONL **首行**（成本极低），无需解析整文件。
- 兼容历史：旧 `-sub-` 文件若没有 `session/meta` 首行，则回退到现逻辑（`parentId = 文件名含 -sub- ? 解析前缀 : null`），保证 G5。

### 5.2 API 契约（新增可选参数）

`fetchTaskList()`（`api/tasks.ts:252`）增加 `includeSubtasks?: boolean`：
- 默认 `false` → 列表干净（G2）；
- `true` 或 UI 展开某父任务时 → 返回该父任务的 `children`。

---

## 6. UI 展示方案（落点：`stores/ui.ts` / `api/tasks.ts` / `api/tsAgent.ts`）

核心思路：**列表即可展开的 span 树**，对标 OpenAI Agents Tracing 与 LangSmith 的 tree view。

### 6.1 任务列表树（替换现状的纯平铺）

```
▸ 研究 codex 的状态管理、记忆系统和上下文管理        12 分钟 · 8.2k tok · 3 子任务
    ▸ 子任务：读取并总结下列文件 ...                  2 分 · 1.1k tok · done
    ▸ 子任务：调研记忆系统实现 ...                    3 分 · 2.0k tok · done
    ▸ 子任务：对比上下文窗口策略 ...                  7 分 · 5.1k tok · error
▸ EvaWork 后端升级                                    已完成
```

- 父行右侧展示**聚合指标**（`childCount` + 累计 token/耗时/失败数，来自 §5.1 的 `agg`），满足 G3。
- 展开/收起由 UI 本地状态控制，不重复拉全量；展开时按需 `fetchTaskList({ includeSubtasks, parentId })`。

### 6.2 过滤开关（兜底 G2）

列表顶部加开关：**"隐藏子任务 / 显示全部"**。默认隐藏，用户需要时一键展开全部平铺（便于调试 / 回溯历史泄漏现象）。

### 6.3 任务详情：执行时间线

点开任一任务（根或子）进入详情：
- 根任务详情：先展示 `subagent/start → ... → subagent/result` 的**派生时间线**，再可下钻到具体子任务会话；
- 子任务详情：复用现有会话回放（turn/start、工具调用、溢出判定等，`23` 号已解析），但因 `parentId` 已知，详情页顶部加**面包屑 `根任务 > 子任务`** 与"返回父任务"入口。

### 6.4 进度与状态聚合

父任务 `status` 由子任务推导（任一 `error` → 父标黄；全部 `done` → 父 `done`；有 `running` → 父 `running`），无需子任务反向写父文件，避免写竞争。

---

## 7. 迁移与落地步骤

```
第 1 步（1 天，存储侧，零风险）
  session.ts   新增 SessionMeta 类型 + SessionLog 构造写 meta 首行
  subagent.ts   runSubagent 传 parentId/kind；修 seq 重名
  loop.ts       runTurn 入口为主会话写 root meta（现有 prompt 即 goal）

第 2 步（1 天，读取侧）
  tsAgent.js    listSessions 改为读 meta + 建树 + 默认只返根；兼容旧 -sub- 文件
  query.ts      CLI sessions 命令同步（保持前后端一致）
  api/tasks.ts  fetchTaskList 增加 includeSubtasks/parentId

第 3 步（2 天，UI）
  ui.ts         refreshTasks 支持树结构 + 展开状态
  tsAgent.ts    透传新契约
  列表组件      树形渲染 + 过滤开关 + 聚合指标

第 4 步（0.5 天，迁移历史）
  写一次性脚本：扫描旧 sessions/，对缺 meta 首行的文件补写（parentId 从 -sub- 解析）
```

---

## 8. 验收标准

| 验收项 | 标准 |
|---|---|
| 列表干净 | 默认列表项 == 根任务数，子任务不再作为并列项出现（回归 `23` 号截图现象消失） |
| 可追溯 | 展开父任务可见其全部子任务及各自 token/耗时/状态，且父行聚合值正确 |
| 历史兼容 | 迁移脚本运行后，旧的 `-sub-` 日志正确归并到对应父任务，不再泄漏 |
| 数据不丢 | 子任务 `.jsonl` 仍存在，`trace` 解析脚本（`23` 号 §11）不受影响 |
| 性能 | `listSessions` 只读取每文件首行，`O(文件数)` 而非 `O(文件大小)`，大目录无退化 |

---

## 9. 风险与权衡

- **为何不拆目录（如 `sessions/sub/`）**：拆目录会破坏现有 `trace` 目录约定与解析脚本，迁移成本高；用 meta 首行 + 查询过滤既满足 G2 又不破坏现状。若未来会话量极大，再考虑按 `createdAt` 分桶，与本次设计正交。
- **为何子任务不反向写父文件**：避免并发写竞争（多个子任务并行时父文件写入串行化）；改为"读取时聚合"，父状态由查询推导，简单且幂等。
- **命名 `Trace-Span` 而非 `parent-child-task`**：与 OpenTelemetry 对齐，便于将来接 LangSmith / Phoenix 等外部可观测性后端，降低锁定风险（G6）。

---

## 10. 关联文档

- `23_EvaWork Trace 问题诊断与改进清单.md` —— 本方案的**根因输入**（缺陷 A/B 定位）
- `19_EvaWork 借鉴 Claude Code 改进清单.md` —— 子代理独立上下文、handback 思路来源
- `20`–`22` 号文档 —— 会话解剖 / 系统提示词 / 工具系统，子任务"产物聚合"可复用其事件格式
