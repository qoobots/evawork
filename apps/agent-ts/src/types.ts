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
 * 放在 `types.ts` 而不是 `loop.ts`：它跨模块共用（sdk / 会话日志 / 界面），
 * 放 loop 里会让这些地方反过来依赖 loop。
 *
 * 分类是有代价的，界面据此决定给「继续」还是「重试」：
 *   - **真失败类**（error / cancelled）→ 给「重试」。
 *     guard 死循环不再作为 turn 级错误：同一工具同参数第 5 次会被跳过，并把阻塞信息
 *     作为工具结果喂给模型，让它自己换做法。
 *
 * 没有"步数上限 / 墙钟 / 无进展"这几类：跑多少步、跑多久由模型按任务复杂度自己
 * 决定，慢与长都不是失控，不再替用户"好心收尾"。
 */
export type StopReason =
  | "completed"
  | "cancelled"
  | "error"
  /** 循环卫生：同一工具同一参数反复调用 */
  | "guard"
  /** 进程被杀/退出，本轮没跑完（由 sdk 的退出钩子补写，不来自 runTurn 内部） */
  | "killed"
  /**
   * 子代理经 `handback` 工具显式交付结论，本轮提前结束（文档 19 P0-3）。
   * 它**不是失败**：交付正是子代理的正常终点。`text` 里装的就是 handback 的正文。
   */
  | "handback"

/**
 * 会话（= 任务）的层级种类。
 *
 * 引入它是为了把"父任务 / 子任务"从**文件名约定**（`-sub-`）提升为**结构化字段**——
 * 否则侧栏列表只能靠扫描目录、按后缀猜测谁是谁的孩子（`24` 号方案根因）。
 * 旧会话没有这个字段，列表查询按文件名 `-sub-<n>` 兜底回退。
 */
export type SessionKind = "root" | "subtask" | "job"

/**
 * 会话元信息事件（`session/meta`）。
 *
 * 作为每条会话 JSONL 的**首行**写入（新建时），把层级关系、来源显式落盘：
 *   - 父子关系由 `parentId` 表达，而不是靠文件位置或命名；
 *   - `kind` 区分根任务与子任务，侧栏据此默认只展示根、可选展开子任务；
 *   - 不重复存 goal/title：标题仍由既有 `turn/start` / `session/renamed` 推导。
 */
export interface SessionMetaEvent {
  type: "session/meta"
  id: string
  /** 根任务为 null；子任务为其父会话 id */
  parentId: string | null
  kind: SessionKind
  goal?: string
  workDir?: string
  model?: string
  createdAt?: number
}

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

/**
 * 动作类别：**分类器与并发策略只认这个，不认工具名**。
 *
 * `memory_write` 是第 6 类：改的是 **agent 自己的状态**（取消后台任务、写记忆索引
 * 这类），既不碰用户工作区也不碰外部世界 → 与 `read` 一样算"非高危"。
 * `contract.ts` 的风险表里它一直有定义（risky: false），但联合类型此前漏了，
 * `jobs.ts` 的 job_cancel 只能靠"没开严格检查"混过去——补上，别再靠运气。
 */
export type ToolAction = "read" | "write" | "command" | "network" | "llm" | "memory_write"

/**
 * 并发判定（文档 19 P2-14"并行 spawn"的口径）：同一 step 里的多个调用，
 * **全部**满足 parallelSafe 才并行执行。判据是**动作类别**而不是工具名——
 * 新工具默认落到串行，是安全的错法；把并行窗口开大才是需要论证的改动。
 *   - read / memory_write：不产生外部副作用；
 *   - llm：只派生独立上下文的子代理（delegate 的调用点已显式列入）；
 *   - write / command / network 一律串行：写要防互相覆盖，命令会动终端 cwd，
 *     外联要防同一目标连打。
 */
export function parallelSafe(action: ToolAction): boolean {
  return action === "read" || action === "llm" || action === "memory_write"
}

export interface ToolContext {
  /** 工作区根（审批与路径约束已移除，命令/文件可在任意路径操作） */
  workspace: string
  signal?: AbortSignal
  /** 委派子代理（TS-043）才用得到：模型通道 / 事件日志。缺了就明确报不能委派。 */
  cfg?: LlmConfig
  log?: unknown
  /**
   * 本轮是**子代理的 turn**（由 runSubagent 传入）。`handback` 工具只在这里为真时
   * 接受调用——主任务误调它不会悄悄"交付"掉自己的一轮。
   */
  subtask?: boolean
  /**
   * `handback` 工具写入的交付正文。loop 在**全部工具执行完之后**的 step 边界检查它：
   * 非空即 finalText 换成本值、stopReason 置 "handback"、本轮到此为止。
   * 放在 step 末尾而不是调用当场，是为了不把 tool_call 群劈成半截（协议错误）。
   */
  handback?: string
  /**
   * 本轮已经加载过的技能名（load_skill 的幂等保护）：同一技能重复加载 = 白白再吃
   * 一份正文。loop 每个 runTurn 建一个新 Set，跨轮不残留（技能正文本来就在压缩时丢弃）。
   */
  loadedSkills?: Set<string>
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

/**
 * LLM 适配器产出的流片段（对齐 OpenAI 流式语义）。
 *
 * `usage` 只有在上游支持且**我们主动索要**时才会出现
 * （OpenAI 兼容协议要在请求体带 `stream_options.include_usage`，qwen 通道支持；
 * 由 `LlmConfig.streamUsage` 开关控制——对不支持的网关多发这个字段可能整条流报错，
 * 所以默认关，宁可不看命中率也不把主链路赌上）。cached_tokens 是缓存前缀
 * 健康度的直接读数（文档 19 P2-11：Claude Code 93% 命中靠的就是 append-only 纪律）。
 */
export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "done"; finish: string }
  | { type: "error"; message: string }
  | { type: "usage"; promptTokens?: number; cachedTokens?: number; completionTokens?: number }

/**
 * inbox 的一条消息。**带来源是安全要求**，不是装饰：
 * 用户真插话与系统转发（后台任务完成通知、子代理回话）必须能区分——
 * 后者注入对话时要包上"非用户输入"声明（context.ts 的 systemNotice），
 * 否则模型会把"任务跑完了"读成"用户让我继续"，甚至当成授权。
 */
export interface InboxMessage {
  message: string
  /** 缺省按 "user"（现有调用方都是在转达用户插话）；系统侧注入必须显式给 "system"。 */
  source?: "user" | "system"
}

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
  /**
   * 流式结束时索要 usage（OpenAI 兼容：`stream_options.include_usage`）。
   * 只为观测缓存命中率（上面的 usage 分片），默认不开。
   */
  streamUsage?: boolean
  /**
   * 服务端上下文管理（Anthropic 风格 `context_management` 的透传槽位，
   * 文档 19 P2-13）。原样并进请求体，由上游爱收不收：
   * 客户端压缩（context.ts）继续兜底，这里只是把"策略可灰度"的口子留给后端。
   */
  contextManagement?: unknown
}
