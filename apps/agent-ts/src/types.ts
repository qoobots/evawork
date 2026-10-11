// 公共类型。
//
// 命名与分层参考 deepseek-harness（Cordis 插件化 harness），但**不依赖它的任何包**：
// 它是 private（未发 npm）、v0.2.1-alpha、且锁定了自己的 Node 版本。我们只借设计。
// 借来的三条最关键：
//   1. session 是 **append-only 事件日志**（不是可变状态表）—— 事实只追加，可重放；
//   2. 工具执行有统一前置钩子 `tools/pre-execute`，审批/沙箱都挂这一处；
//   3. 审批**没有应答者就 deny**（fail-closed），绝不一挂了之。
//
// 与 Python 版 evawork 的关系：**互不感知**。各自独立存储、独立历史，界面上二选一。

export type Role = "system" | "user" | "assistant" | "tool"

/**
 * 一个 turn 为什么停（TS-066）。
 *
 * 放在 `types.ts` 而不是 `loop.ts`：`guard.ts` 的停止条件也要用，而 `loop.ts`
 * 反过来要 import `guard.ts`——放 loop 里就成了循环依赖。
 *
 * 分类是有代价的，界面据此决定给「继续」还是「重试」：
 *   - **预算/上限类**（deadline / timeout / stalled）→ 已产出的内容
 *     都还在上下文里，给「继续」（复用会话续跑），不给「重试」（那暗示从头重来）；
 *   - **真失败类**（error / cancelled）→ 给「重试」。
 *     guard 死循环不再作为 turn 级错误：同一工具同参数第 5 次会被跳过，并把阻塞信息
 *     作为工具结果喂给模型，让它自己换做法；最终停止原因通常是 deadline / stalled。
 *
 * 没有"步数上限"这一类：跑多少步由模型按任务复杂度自己决定，预算按**时间**和
 * **有没有进展**收口，而不是按数到第几步。
 */
export type StopReason =
  | "completed"
  /** 墙钟预算用尽 */
  | "deadline"
  /** 单个 step 超时（含模型请求挂住） */
  | "timeout"
  /** 连续多步无进展，判定空转 */
  | "stalled"
  | "cancelled"
  | "error"
  /** 循环卫生：同一工具同一参数反复调用 */
  | "guard"
  /** 进程被杀/退出，本轮没跑完（由 sdk 的退出钩子补写，不来自 runTurn 内部） */
  | "killed"

export interface ToolCall {
  id: string
  name: string
  /** JSON 字符串（模型给的原始形式） */
  arguments: string
}

export interface Message {
  role: Role
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolParam {
  name: string
  type: string
  required?: boolean
  desc: string
}

/** 动作类别：**审批闸门只认这个，不认工具名**。 */
export type ToolAction = "read" | "write" | "command" | "network" | "llm"

export interface ToolContext {
  /** 工作区根（审批与路径约束已移除，命令/文件可在任意路径操作） */
  workspace: string
  signal?: AbortSignal
  /** 委派子代理（TS-043）才用得到：模型通道 / 事件日志。缺了就明确报不能委派。 */
  cfg?: LlmConfig
  log?: unknown
}

/**
 * 子代理轨迹。**只给人看**——模型手里已经有子代理的结论摘要了。
 *
 * 形状与界面 T-090 的 `SubagentTrace` 刻意保持一致，于是任务页那张"子代理干了什么"
 * 的卡片不用为 TS 侧再写一遍：换的是数据源，不是界面。
 */
export interface SubagentTrace {
  rounds: number
  elapsed_ms?: number
  calls: { tool: string; ok: boolean; elapsed_ms?: number; head: string }[]
}

export interface ToolResult {
  ok: boolean
  output?: string
  error?: string
  /** 附带的执行轨迹（目前只有 delegate 会给）。同样只给人看，不进模型消息。 */
  subagent?: SubagentTrace
}

export interface ToolDef {
  name: string
  description: string
  parameters: ToolParam[]
  action: ToolAction
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult
}

/**
 * 审批档位。`ask` / `never` 与 dsh 一致；`full` 是**共用契约里已有**的档
 * （界面"完全访问"对应它，Python 侧在用）。
 *
 * 早期这里刻意不收 `full`，顾虑是它会把沙箱一并降到 danger-full-access，
 * 从此没人看着"这一步写到哪去了"。但界面上的"完全访问"档**必须**有个落点——
 * 拒收的结果是：用户选了完全访问，TS 侧仍按 never 拒绝，界面选择静默失效。
 * 现在收下它，当初的顾虑由两件事兜住：沙箱联动在 CLI 层显式做（不藏在档位里），
 * 且**事件日志照记**——每个动作仍落 tool/call 与自动放行的审批记录，可审计。
 */
export interface SessionEvent {
  seq: number
  ts: number
  type: string
  [key: string]: unknown
}

/** LLM 适配器产出的流片段（对齐 OpenAI 流式语义）。 */
export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "done"; finish: string }
  | { type: "error"; message: string }

export interface LlmConfig {
  baseUrl: string
  token: string
  model: string
  /**
   * 备用模型（**同通道**的模型级降级链），由**后端裁决**一并给出。
   *
   * TS 侧不自己挑模型：裁决只做一次、只在后端做，否则两套智能体各判各的
   * （用户选了"自动选择"，TS 侧却吃硬编码的旧档）。
   */
  routes?: string[]
}
