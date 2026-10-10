// LLM 适配器：OpenAI 兼容 /chat/completions，**流式**。
//
// 零依赖：用内置 fetch 手写 SSE 解析，不装 openai SDK（本机可能无外网）。
// 与 Python 版 evawork 共用同一条通道（eva-ai 的 /api/ai/v1），因此
// **同一份模型白名单对两边都生效**——不会出现"Python 侧 16 个模型、TS 侧 5 个"的漂移。
//
// 凭据不由本模块自己保管：由启动方通过 EVA_AI_BASE_URL / EVA_AI_TOKEN 注入。
// 这样 TS agent 不必去读 evawork 的 SQLite 登录态，两套智能体的存储保持独立。

import type { LlmConfig, Message, StreamChunk, ToolCall } from "./types.ts"
import { egressFetch } from "./egress.ts"
import { telemetry } from "./telemetry.ts"
import fs from "node:fs"
import path from "node:path"
import { homeDir } from "./session.ts"

/** 流式工具调用在途状态：按 index 累加（见下）。 */
interface PendingCall {
  id: string
  name: string
  args: string
}

/* ---- 请求看门狗（TS-066）----------------------------------------------------
   对标前沿：Claude Code 的 API 层就带 **stream watchdog / stall 检测 / timeout** 三件套。
   光有"轮次上限"挡不住"请求挂住"——挂住的那一步既不推进也不报错，
   界面就一直转圈（实测：一个 turn 停在第 90 步的 agent/request 上再无回音）。

   做成**三段**而不是一段，因为它们防的是三种不同的挂法：
     connect  首字节超时   —— 连上了但不响应（网关卡住、上游排队）
     idle     片间静默超时 —— 流开了但中途断流（最常见：上游生成到一半失联）
     total    单次总时长   —— 一直在慢慢吐字，永远吐不完
   只用 idle 挡不住"慢速滴漏"（每 59s 吐一个字也能永远跑下去）；
   只用 total 又会把正常的长思考误杀。三段各管一段，才不留缝。

   用 Node 内置 AbortController/AbortSignal 实现，**零依赖**（与本项目不装 SDK 一致）。 */
function msFromEnv(name: string, fallback: number): number {
  const v = Number(process.env[name] || "")
  return Number.isFinite(v) && v > 0 ? v : fallback
}

export interface LlmTimeouts {
  connectMs: number
  idleMs: number
  totalMs: number
}

export function llmTimeouts(): LlmTimeouts {
  return {
    connectMs: msFromEnv("EVA_TS_LLM_CONNECT_MS", 30_000),
    idleMs: msFromEnv("EVA_TS_LLM_IDLE_MS", 60_000),
    totalMs: msFromEnv("EVA_TS_LLM_TOTAL_MS", 600_000),
  }
}

/**
 * 一次模型请求的看门狗：三段超时共用一个 AbortController。
 *
 * **用户取消（`external`）不归它管**，只是透传：取消是外部意图，必须原样报成
 * "请求被取消"，否则会被误报成"超时"——界面上的人会以为是自己网络的问题。
 */
class RequestWatchdog {
  private ctl = new AbortController()
  private connect: ReturnType<typeof setTimeout> | null = null
  private idle: ReturnType<typeof setTimeout> | null = null
  private total: ReturnType<typeof setTimeout> | null = null
  /** 触发原因：空串 = 尚未触发。`cancelled` 表示是外部信号触发的。 */
  reason = ""
  /* **不用参数属性**（`constructor(private t: LlmTimeouts)`）：子进程是
     `node src/cli.ts` 直接跑的，走 Node 原生类型剥离，而它明确不支持参数属性
     ——一加载就 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，整个智能体起不来。
     同 terminal.ts / session.ts / mcp.ts 的做法：显式声明 + 显式赋值。 */
  private t: LlmTimeouts

  constructor(external: AbortSignal | undefined, t: LlmTimeouts) {
    this.t = t
    if (!external) return
    if (external.aborted) this.fire("cancelled")
    else external.addEventListener("abort", () => this.fire("cancelled"), { once: true })
  }

  /** 透传给 fetch 的信号：外部取消与本看门狗共用一条，谁先到算谁。 */
  get signal(): AbortSignal {
    return this.ctl.signal
  }

  /** 请求发出前：开始计首字节与总时长。 */
  start(): void {
    if (this.reason) return
    this.connect = setTimeout(() => this.fire("connect"), this.t.connectMs)
    this.total = setTimeout(() => this.fire("total"), this.t.totalMs)
  }

  /** 拿到响应头：首字节已过，转入"片间静默"计时。 */
  connected(): void {
    if (this.connect) {
      clearTimeout(this.connect)
      this.connect = null
    }
    this.tick()
  }

  /** 收到一片数据就重置静默计时——只要在动，就不算卡住。 */
  tick(): void {
    if (this.reason) return
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.fire("idle"), this.t.idleMs)
  }

  private fire(reason: string): void {
    if (this.reason) return
    this.reason = reason
    // 故意不传 reason：传了 fetch 会直接抛出该对象，`e.name === "AbortError"` 就判不出来了
    try {
      this.ctl.abort()
    } catch {
      /* 已 abort */
    }
  }

  /** 收工：清掉计时器。不清的话它们会把事件循环拖住，进程退出不了。 */
  dispose(): void {
    for (const t of [this.connect, this.idle, this.total]) if (t) clearTimeout(t)
    this.connect = this.idle = this.total = null
  }
}

/** 把看门狗的触发原因翻译成人能读懂、且**能据此决定下一步**的一句话。 */
function timeoutMessage(reason: string, t: LlmTimeouts): string {
  const sec = (ms: number): string => `${Math.round(ms / 1000)}s`
  if (reason === "cancelled") return "请求被取消"
  if (reason === "connect") return `模型通道 ${sec(t.connectMs)} 内没返回任何数据（已放弃本步，可继续）`
  if (reason === "idle") return `模型流静默超过 ${sec(t.idleMs)}（上游可能已断流，已放弃本步，可继续）`
  return `单次模型请求超过总时限 ${sec(t.totalMs)}（已放弃本步，可继续）`
}

function openaiTools(schemas: unknown[] | undefined): unknown[] | undefined {
  return schemas && schemas.length ? schemas : undefined
}

/* ---- 请求留痕（按需开启，默认关，见下方 gate）-----------------------------
   调提示词时想看"到底发给模型什么"（system 提示词 + 完整 messages + tools），
   而会话日志（session.ts）只记模型**返回**的内容与工具调用，不记这份请求体。
   默认关闭：开启会把完整对话（可能含文件正文 / 私密）写到磁盘，仅调试时打开。
   开法：`EVA_TS_TRACE=1`。落点：`~/.evawork/ts-agent/trace/`（可用
   `EVA_TS_TRACE_DIR` 覆盖），每个模型调用一个 `req-<step>-<ts>.json`，
   按 step 与同轮会话日志里的 `assistant/message.step` 一一对应。 */
function traceEnabled(): boolean {
  const v = (process.env.EVA_TS_TRACE || "").trim().toLowerCase()
  return v === "1" || v === "on" || v === "true"
}

let traceSeq = 0

/** 把一次模型请求发出的 body 落盘（含 system 提示词与 messages）。失败静默。
 *
 *  **瘦身**：`tools` 的 schema 是文件体积的绝对大头——100+ 个插件 / 技能 / MCP 工具，
 *  每个几十行 JSON，堆起来比整段对话还长；但它对本机几乎不变，调提示词时真正要看的是
 *  messages。所以这里只留工具**名字**（外加一个数量），完整 schema 需要时去
 *  shared/agent-contract.json 与 MCP 配置里查。 */
function traceRequest(step: number | undefined, model: string, body: unknown): void {
  if (!traceEnabled()) return
  try {
    const dir = process.env.EVA_TS_TRACE_DIR?.trim() || path.join(homeDir(), "trace")
    fs.mkdirSync(dir, { recursive: true })
    const name = `req-${step ?? "x"}-${Date.now().toString(36)}-${++traceSeq}.json`
    const b = body as Record<string, unknown>
    const slim: Record<string, unknown> = { step: step ?? null, model, ...b }
    if (Array.isArray(b.tools)) {
      slim.tools = b.tools.map((t) => {
        const fn = t as { function?: { name?: string }; name?: string }
        return fn?.function?.name ?? fn?.name ?? "?"
      })
      slim.toolsCount = b.tools.length
    }
    fs.writeFileSync(path.join(dir, name), JSON.stringify(slim, null, 2), "utf8")
  } catch {
    /* 留痕失败绝不影响主流程 */
  }
}

/**
 * 把内部消息格式转成 OpenAI 线上格式。
 *
 * 只转一处，但这一处最关键：**`assistant.tool_calls` 有两种写法**。
 * 我们从流里解析出来的是扁平的 `{id, name, arguments}`（内部好处理），
 * 而发给 API 必须是 `{id, type:'function', function:{name, arguments}}`。
 *
 * 直接把扁平结构塞回去会静默出错：网关拿到的 tool_calls 形状不对，
 * 于是模型"看不出自己刚才调用过工具"，下一轮既不说话也不调工具——
 * 表现为"任务莫名结束、最终回答是空的"，而 HTTP 是 200、没有任何报错。
 * （实测：qwen-plus 第二次请求返回空 content，日志里 assistant/message 的 text 为 ""。）
 */
function toWireMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length) {
      return {
        ...m,
        tool_calls: m.tool_calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      }
    }
    return m
  })
}

/**
 * 流式调用。
 *
 * `tool_calls` 是**分片**发来的：`delta.tool_calls[i].function.arguments` 只是一小段，
 * 必须按 index 累加拼接，只取最后一片会拿到残缺 JSON——这是流式 function-call 最
 * 经典的 bug，Python 版 evawork 的注释里也专门记了这一条。
 */
export async function* streamChat(
  cfg: LlmConfig,
  messages: Message[],
  opts: { tools?: unknown[]; signal?: AbortSignal; temperature?: number; step?: number } = {},
): AsyncGenerator<StreamChunk> {
  const models = modelChain(cfg)
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions"
  const tools = openaiTools(opts.tools)

  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    const body: Record<string, unknown> = {
      model,
      messages: toWireMessages(messages),
      stream: true,
      temperature: opts.temperature ?? 0.7,
    }
    if (tools) body.tools = tools
    // 请求留痕：把发出去的完整 body（含 system 提示词）写盘，调提示词时复盘用
    traceRequest(opts.step, model, body)

    const timeouts = llmTimeouts()
    const wd = new RequestWatchdog(opts.signal, timeouts)
    let resp: Response | null = null
    let errMsg = ""
    try {
      // 走统一出口：模型通道也要受 allowlist 约束，否则"配了白名单"对最主要的
      // 一个外联方向完全不生效
      wd.start()
      resp = await egressFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          /* 自带通道可以没有 Key（本地推理服务）：这时**不发**这个头，
             免得某些网关把 `Bearer `（空令牌）当成无效凭据直接 401。 */
          ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: wd.signal,
      })
      wd.connected()
    } catch (err) {
      // fetch 失败只给TypeError，连不上和超时长得一样，必须自己说清
      const e = err as { name?: string; message?: string }
      if (wd.reason) errMsg = timeoutMessage(wd.reason, timeouts)
      else errMsg = e.name === "AbortError" ? "请求被取消" : `连不上模型通道（${url}）：${e.message || e.name}`
    }

    if (resp && (!resp.ok || !resp.body)) {
      const text = await resp.text().catch(() => "")
      const hint = resp.status === 401 || resp.status === 403 ? "登录态失效或无权限" : "上游错误"
      errMsg = `模型通道 ${resp.status}（${hint}）：${text.slice(0, 300)}`
    }

    if (!resp || errMsg) {
      /* 请求阶段就失败 = **一个字都还没吐出去**，这时换下一个模型是安全的；
         流已经开了再重试，前半截回答会重复一遍，所以只在这个点换。
         401/403 是凭据问题，**换哪个模型都一样**，不做无意义的重试。
         超时同理：换模型很可能再挂一次，而且用户已经等了几十秒——不如如实停下。 */
      wd.dispose()
      const authFailed = /登录态失效或无权限/.test(errMsg)
      // 超时不再换下一个候选：用户已经等了几十秒，再挂一次只会更久；如实停下让他决定
      const timedOut = wd.reason !== "" && wd.reason !== "cancelled"
      if (!authFailed && !timedOut && i < models.length - 1) {
        telemetry.count("model/fallback")
        continue
      }
      yield { type: "error", message: errMsg }
      return
    }

    // --- 流已建立：往后一律直接 yield，中途失败不再重试 ---

  const pending = new Map<number, PendingCall>()
  const decoder = new TextDecoder()
  let buf = ""

  // 手动读流：SSE 帧边界按空行切，不能假设一次 read 就是一帧
  const reader = resp.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      wd.tick() // 收到一片就续命：只要还在动就不算卡住
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split("\n")
      buf = parts.pop() ?? ""
      for (const line of parts) {
        const t = line.trim()
        if (!t.startsWith("data:")) continue
        const payload = t.slice(5).trim()
        if (!payload || payload === "[DONE]") continue
        let obj: any
        try { obj = JSON.parse(payload) } catch { continue }
        const choice = obj?.choices?.[0]
        if (!choice) continue
        const delta = choice.delta ?? {}

        if (typeof delta.content === "string" && delta.content) {
          yield { type: "text", text: delta.content }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = Number(tc.index ?? 0)
            const cur = pending.get(idx) ?? { id: "", name: "", args: "" }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.name = tc.function.name
            if (tc.function?.arguments) cur.args += tc.function.arguments
            pending.set(idx, cur)
          }
        }

        if (choice.finish_reason) {
          const calls: ToolCall[] = [...pending.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.args }))
          if (calls.length) yield { type: "tool_calls", calls }
          yield { type: "done", finish: String(choice.finish_reason) }
          return
        }
      }
    }
  } catch (err) {
    const e = err as { name?: string; message?: string }
    /* 看门狗触发要**报成 error，不能报成 done**：报成 done 等于告诉 loop
       "这一轮正常结束了"，于是模型没说的话就凭空消失，界面上还显示已完成。
       挂住必须在明面上——这是 TS-066 修的那个"停在第 90 步再也回不来"的病根。 */
    if (wd.reason) yield { type: "error", message: timeoutMessage(wd.reason, timeouts) }
    else if (e.name === "AbortError") yield { type: "done", finish: "aborted" }
    else yield { type: "error", message: `读取模型流失败：${e.message || e.name}` }
    return
  } finally {
    wd.dispose()
    try { await reader.cancel() } catch { /* 已结束 */ }
  }

  // 流结束却没收到 finish_reason：如实报"不完整"，不假装这一轮是完整的
  const calls: ToolCall[] = [...pending.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.args }))
  if (calls.length) yield { type: "tool_calls", calls }
  yield { type: "done", finish: "stop" }
  return // 这条流跑完了就收工，别再去试降级链上的下一个
  } // ← 关闭候选模型循环（chain 里的下一个只在**请求失败**时才轮到）
} // ← 关闭 streamChat

/**
 * 本次请求的候选模型链：首选 + 备用（去重、丢掉 `auto` 这类**未裁决**的占位）。
 *
 * `auto` 不是一个模型名，是"请你替我挑"的占位；把它发给接口，就是拿一个它不认识的
 * 名字去请求。裁决只该发生一次，且在后端——所以这里的职责只是把裁决结果排好队。
 */
export function modelChain(cfg: LlmConfig): string[] {
  const out: string[] = []
  for (const m of [cfg.model, ...(cfg.routes || [])]) {
    const v = (m || "").trim()
    if (!v || v === "auto" || out.includes(v)) continue
    out.push(v)
  }
  return out
}

/**
 * 从环境变量取通道配置（失败就抛，绝不静默用一个空 token 去请求）。
 *
 * **模型没有兜底值**（TS-058）：以前缺省是硬编码 `qwen-plus`，那是通道的**上一代**
 * 默认值——静默兜底等于让 TS 侧永远吃最老那一档，而用户以为自己选的是"自动"。
 * 拿不到模型就说清楚是谁没给（启动方没注入，还是后端没裁决出来）。
 */
export function llmConfigFromEnv(overrides: Partial<LlmConfig> = {}): LlmConfig {
  /* `baseUrl` 显式给了 = **这一轮走用户自带通道（BYOK）**：它有自己的地址与 Key，
     既不该回落到 EVA 的令牌，也允许没有 Key（本地推理服务本就不校验）。 */
  const custom = overrides.baseUrl !== undefined
  const baseUrl = (overrides.baseUrl ?? process.env.EVA_AI_BASE_URL ?? "").trim()
  const token = custom
    ? String(overrides.token ?? "").trim()
    : String(overrides.token ?? process.env.EVA_AI_TOKEN ?? "").trim()
  const model = (overrides.model ?? process.env.EVA_AI_MODEL ?? "").trim()
  const routes = String(overrides.routes?.join(",") || process.env.EVA_AI_ROUTES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (!baseUrl) throw new Error("缺少 EVA_AI_BASE_URL（例：http://localhost:8080/api/ai/v1）")
  if (!token && !custom) throw new Error("缺少 EVA_AI_TOKEN（EVA 登录令牌；未登录就没有凭据，不假装有模型）")
  if (!model) {
    throw new Error(
      "没有指定模型：应由启动方注入 EVA_AI_MODEL（后端裁决后的**具体**模型），" +
        "或直接用 --model 指定。这里不猜一个默认值——猜出来的往往是已下线的旧档。",
    )
  }
  return { baseUrl, token, model, routes }
}
