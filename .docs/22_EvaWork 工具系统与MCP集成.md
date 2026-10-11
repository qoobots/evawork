# 22 · EvaWork 工具系统与 MCP 集成

> 素材：`scripts/ev-out/tools.txt` / `tools.json`（70 个工具清单）、`apps/agent-ts/src/tools.ts`、`jobs.ts`、`subagent.ts`、`mcp.ts`、`boot.ts`、`types.ts`

---

## 1. 总览：70 个工具 = 8 内置 + 62 MCP

| 来源 | 数量 | 说明 |
|---|---:|---|
| 内置 | 8 | `run_command` / `web_fetch` / `terminal` / `delegate` / `job_start` / `job_status` / `job_wait` / `job_cancel` |
| `mcp__Playwright` | 25 | 浏览器自动化 |
| `mcp__Filesystem` | 14 | 文件读写与检索 |
| `mcp__Everything` | 13 | MCP 官方测试 server（`_____echo` 等） |
| `mcp__Memory` | 9 | 知识图谱记忆 |
| `mcp__Sequential_Thinking` | 1 | 结构化思考 |
| **合计** | **70** | |

**对比 Claude Code**：主智能体 27 个工具、只读子智能体 13 个。EvaWork 一次给到 70 个，且**没有按角色裁剪**（`delegate` 派出的子 agent 才走白名单裁剪）。

---

## 2. 内置工具（8 个）

| 工具 | 参数 | 说明（`description` 原文） | 审批动作 |
|---|---|---|---|
| `run_command` | `command*`, `timeout_ms`(默认 30000) | "在工作区内执行一条命令（Windows 走 PowerShell，其它平台走 sh）。需要确认；有超时，输出会被截断。" | `command` |
| `terminal` | `command*`, `timeout_ms`(默认 30000) | "在持久终端里执行命令：**cwd 会保持到下一次**（run_command 每条都重置回工作区根）。不支持交互式命令。" | `command` |
| `web_fetch` | `url*`, `max_chars`(默认 8000) | "抓取一个 URL 的内容（走统一出口，受 `EVA_EGRESS_ALLOWLIST` 约束）。返回纯文本摘要，超大内容会被截断。" | `network` |
| `delegate` | `goal*`, … | "把一件独立的小任务派给子代理：它有自己的上下文、看不到主任务的对话历史，可限定工具子集；**子代理那边写文件/跑命令/联网一律不执行**，会把需要批准的事带回结论里。" | — |
| `job_start` | `command*`, `timeout_ms`(默认 120000) | "把一条命令放到**后台**跑（构建/测试这类慢活用）：立刻返回任务 id，不要干等。用 job_status 看结果。需要确认。" | — |
| `job_status` | `id` | "看后台任务的状态与输出。传 id 看一个；不传就列全部（含仍在跑的）。" | `read` |
| `job_wait` | `id*`, `timeout_ms`(默认 30000) | "等一个后台任务结束（最多等 timeout_ms）。超时就照实说还在跑，不假装结束。" | — |
| `job_cancel` | `id*` | "取消一个后台任务。只保证 kill 直接子进程，进程树可能仍有残留。" | `memory_write` |

### 2.1 审批按"动作类别"，不按工具名

```ts
/** 动作类别：**审批闸门只认这个，不认工具名**。 */
export type ToolAction = "read" | "write" | "command" | "network" | "llm"
```

这是正确的抽象：MCP 工具不断增减，但动作类别是稳定的。**新增一个 MCP 工具时，只要声明它的 action，就自动接入既有的审批链**——不需要为每个工具单独配规则。

不过本次 trace 里的 62 个 MCP 工具**有没有正确声明 action 无法从 trace 验证**（trace 不含 schema）。这是一个值得核查的点：MCP 工具的 action 默认值是保守还是宽松，直接决定安全水位。

### 2.2 两条描述写得很到位的例子

- `terminal` vs `run_command` 的 **cwd 语义差异**直接写进 description，并在系统提示词里再强调一次（`terminal 的当前目录会跨命令保持；run_command 每条都重置回工作区根。`）。这是"把运行时的坑前置"的正确做法。
- `job_wait` 的 "**超时就照实说还在跑，不假装结束**"、`job_cancel` 的 "**只保证 kill 直接子进程，进程树可能仍有残留**"——把能力的边界如实告诉模型，避免它基于错误假设继续推理。

---

## 3. MCP 集成（`mcp.ts`）

无 SDK 依赖，直接走 stdio JSON-RPC（`PROTOCOL_VERSION = "2024-11-05"`）。三条从 Python 侧搬过来的踩坑经验写在文件头：

1. **stderr 必须独立成管**——真实 npm server 启动时往 stderr 打日志，混进 stdout 就污染 JSON-RPC 帧 → `initialize` 永远等不到合法响应 → 表现为"调用超时"。
2. **请求要编号**，用条件变量等配对响应（通知没有 id，不能当响应）。
3. **握手失败就不算装上**，别留"看着像装了其实没装"的空壳（并保留 `spawnError`，请求进来先看它，别干等超时）。

### 3.1 命名规范

`mcp__<server>__<tool>`，与 Claude Code 完全一致。注意 `Everything` server 的工具名以 `_____` 开头（`mcp__Everything_______echo`）——**双下划线前缀会被拼成 5 个下划线**，可读性很差，但这是 MCP server 自己的命名，客户端照搬是对的（不要为了好看去改，改了就和 server 对不上）。

### 3.2 `ToolAnnotations` 的处理（安全上很清醒）

```ts
/**
 * MCP 规范的服务端自述（ToolAnnotations）。**这是 server 自己声明的，不是我们验证过的**——
 * 所以它只能用来"决定要不要多问一次"，绝不能当成安全边界。缺失时默认值要按危险处理。
 */
annotations?: {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}
```

**"server 自述不能当安全边界，缺失按危险处理"** —— 这条判断是对的，而且与 Claude Code 把 MCP 视为"真实用户环境、不在沙箱内"的立场一致。

### 3.3 5 个 MCP server 的实际用途

| server | 工具数 | 定位 | 本会话使用 |
|---|---:|---|---|
| `Filesystem` | 14 | 文件读写/检索（受 `list_allowed_directories` 约束） | **用了 8 次**（`search_files`×1、`read_text_file`×7） |
| `Playwright` | 25 | 浏览器自动化 | 未用 |
| `Memory` | 9 | 知识图谱（`create_entities` / `search_nodes` / `read_graph`…） | 未用 |
| `Everything` | 13 | MCP 官方测试 server | 未用 |
| `Sequential_Thinking` | 1 | 结构化思考 | 未用 |

**62 个 MCP 工具里只用了 2 个名字（`search_files` / `read_text_file`），其余 60 个每一步都要把 schema 送一遍。**

这与 Claude Code 的做法形成对比：Claude Code 主智能体 27 个工具、子智能体 **13 个**——按角色裁剪。EvaWork 目前是"全量给所有人"。

---

## 4. 模块开关与工具裁剪（`boot.ts`）

`~/.evawork/boot.json` 声明显式差异，缺字段用默认补：

```ts
const MODULE_TOOLS: Record<string, string[]> = {
  jobs: ["job_start", "job_status", "job_wait", "job_cancel"],
  subagent: ["delegate"],
}
```

逻辑：

- 模块关掉 → 它带来的工具**一律不进暴露名单**（注册过也不给模型用）；
- `m.prompt.remove` / `m.prompt.set` 可整节删改提示词；
- `m.exclude` 可单独排除某个工具；
- `modules.mcp` 关掉则完全不接 MCP（本会话显然是开的）。

还有一条：清单文件**版本不对就整个退回默认**——"半新半旧地合并，比全用默认更危险"。

> 这是 EvaWork 比 Claude Code 更灵活的地方：**工具集是声明式装配的**，不需要改代码。缺的是"按角色（主/只读子/后台）自动裁剪"的策略层。

---

## 5. 工具调用失败的处理（`loop.ts`）

失败结果原样回上下文，由模型自己判断：

```ts
emit({ type: "tool/result", step, call: c.id, tool: c.name, ok: false, error: content, content })
```

本会话的实测（step 6 → step 7）：

```
step 6: run_command("wc -l D:\…\agent-architecture-paper.md")
        → 执行失败：退出码 1 … "wc : 无法将"wc"项识别为 cmdlet、函数、脚本文件或可运行程序的名称…"
step 7: run_command("(Get-Content D:\…\agent-architecture-paper.md).Count")
        → 194
```

**模型自己修好了**，没有重试中间件介入。这是正确的（Claude Code 同样如此）。

但结果里混进了 **1,177 字符的 PowerShell CLIXML 噪音**：

```
执行失败：退出码 1
#< CLIXML
<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">
  <Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T>…
```

而有用的信息只有一句"wc 无法识别"。成功那条（step 7）也带 398 字符，其中 `194` 之外全是 CLIXML 进度包。

→ 见 `23` 号文档 P0-2。

---

## 6. 子代理与后台任务（本会话未触发，但机制已就绪）

| 能力 | 实现 | 约束 |
|---|---|---|
| `delegate` | `subagent.ts`，独立 `SessionLog`、独立上下文、`SUBAGENT_MAX_STEPS = 12` 硬顶 | 子 agent 侧**写文件/跑命令/联网一律不执行**，被拒的事带回结论 |
| 子 agent 工具白名单 | `runTurn({ tools })` → `allTools().filter(...)` | 计数用同一份 `visible`，保证面板数字与请求一致 |
| 后台任务 | `jobs.ts` 的 4 个工具 | 完成不会自动重唤醒主循环 |
| 停止条件 | `guard.ts`：`deadlineMs`(15 min) + `stallSteps`(12) + `stepTimeoutMs`(5 min) | **`loop.ts` 刻意不设步数上限**："跑多少步由模型自己决定，拿步数卡它就是替它猜答案" |

`loop.ts` 那句注释值得单独记一笔——这是一个明确的产品判断，不是遗漏。

---

## 7. 小结：工具系统的三个判断

1. **审批按 action 不按工具名** —— 对。MCP 工具无限增长时这个抽象能兜住。
2. **MCP annotations 不当安全边界，缺失按危险处理** —— 对，且比多数实现清醒。
3. **模块声明式装配（boot.json）** —— 对，比硬编码灵活。

短板在两处：**不按角色裁剪工具集**（70 个全给），以及**工具名清单重复进提示词**（2,329 字符，占系统提示词 20.5%）。两者都直接推高每一步的固定成本。
