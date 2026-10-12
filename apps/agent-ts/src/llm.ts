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
import { aliveFallbacks } from "./modelcatalog.ts"
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

/* ---- 请求时限 ------------------------------------------------------------
   本模块**不再**自设超时：以前这里有"首字节 30s / 片间静默 60s / 总时长 10min"
   三段看门狗，一旦触发就把这一步判死、吐一条"已放弃本步"的错误出来。
   实测那是有害的：思考型模型在长上下文下**开吐第一个字之前**就可能超过 30s
   （前面排着几十秒的推理），结果不慢的请求被当成"通道没响应"掐掉，
   界面上不断重复"30s 内没返回任何数据"，每一步都白等一轮。

   慢 ≠ 挂死，超时猜不出来谁是哪一个，所以这里一律**等它**：
     · 用户点停止 / 上层取消一律透传：那是外部意图，必须原样报成"请求被取消"。
   好处很简单：模型慢慢吐就让它吐完，不必按秒猜它的死活。 */

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
    /* usage 索要（缓存命中率观测，文档 19 P2-11）：**默认不开**。`stream_options`
       不是 OpenAI 兼容网关的必选扩展——不支持的网关可能整条流 400，而 400 发生在
       请求阶段会**把降级链的每一档都撞一遍**，观测指标不该有这种破坏半径。
       开关在 LlmConfig.streamUsage（EVA_LLM_STREAM_USAGE=1）。 */
    if (cfg.streamUsage) body.stream_options = { include_usage: true }
    /* 服务端上下文管理（P2-13）：**原样透传，不猜语义**。上游不认就忽略它；
       客户端压缩（context.ts）继续是正路，这里只是"策略可灰度"的口子。 */
    if (cfg.contextManagement) body.context_management = cfg.contextManagement
    // 请求留痕：把发出去的完整 body（含 system 提示词）写盘，调提示词时复盘用
    traceRequest(opts.step, model, body)

    let resp: Response | null = null
    let errMsg = ""
    try {
      // 走统一出口：模型通道也要受 allowlist 约束，否则"配了白名单"对最主要的
      // 一个外联方向完全不生效
      resp = await egressFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          /* 自带通道可以没有 Key（本地推理服务）：这时**不发**这个头，
             免得某些网关把 `Bearer `（空令牌）当成无效凭据直接 401。 */
          ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
        },
        body: JSON.stringify(body),
        // 直接透传上层给的信号：取消由它带进来，本文件不再自备计时器
        signal: opts.signal,
      })
    } catch (err) {
      // fetch 失败只给TypeError，连不上和取消长得一样，必须自己说清
      const e = err as { name?: string; message?: string }
      errMsg = e.name === "AbortError" ? "请求被取消" : `连不上模型通道（${url}）：${e.message || e.name}`
    }

    if (resp && (!resp.ok || !resp.body)) {
      const text = await resp.text().catch(() => "")
      const hint = resp.status === 401 || resp.status === 403 ? "登录态失效或无权限" : "上游错误"
      errMsg = `模型通道 ${resp.status}（${hint}）：${text.slice(0, 300)}`
    }

    if (!resp || errMsg) {
      /* 请求阶段就失败 = **一个字都还没吐出去**，这时换下一个模型是安全的；
         流已经开了再重试，前半截回答会重复一遍，所以只在这个点换。
         401/403 是凭据问题，**换哪个模型都一样**，不做无意义的重试。 */
      const authFailed = /登录态失效或无权限/.test(errMsg)
      if (!authFailed && i < models.length - 1) {
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
        /* usage 分片（开了 stream_options 才有）：协议上它单独成帧、**choices 为空**，
           所以必须放在 choice 判空之前，否则永远够不到。
           cached_tokens 在 OpenAI 兼容里的字段名不统一（qwen 放 prompt_tokens_details，
           有的网关直接平铺），两边都认。 */
        if (obj?.usage) {
          const u = obj.usage as Record<string, any>
          yield {
            type: "usage",
            promptTokens: Number(u.prompt_tokens) || undefined,
            cachedTokens: Number(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens) || undefined,
            completionTokens: Number(u.completion_tokens) || undefined,
          }
        }
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
    /* 被掐断（用户停止 / 上层取消）要报 `done/aborted`，让它区别于"读取失败"：
       这两件事的上层判据是信号本身，loop 会据 signal 如实判成 cancelled，
       报成 error 只会把"用户主动停"误写成"模型出错"。 */
    if (e.name === "AbortError") yield { type: "done", finish: "aborted" }
    else yield { type: "error", message: `读取模型流失败：${e.message || e.name}` }
    return
  } finally {
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
 * 非流式一次性小调用（动作安全分类器专用，文档 19 P1-8[0]）。
 *
 * 与 streamChat 的三点不同，每点都是刻意的：
 *   1. **不走 modelChain 降级链**：分类器换模型 = 换判断标准，降级出来的结论
 *      不能当同一个分类器用；模型名给谁就只试谁。
 *   2. **小 max_tokens + stop 截断**：分类输出协议就一句话，没必要让它写小作文。
 *   3. **失败不抛异常**，一律折算进 finish_reason：调用方（分类器）要据此
 *      fail-closed——"通道没答上来"与"通道答了 ALLOW"是两种安全含义，
 *      抛异常把它们压成同一种。
 */
export interface CompleteOnceOpts {
  model: string
  messages: { role: string; content: string }[]
  system?: string
  maxTokens?: number
  /** 停止序列（OpenAI 兼容的 `stop`）：命中即截断返回 */
  stop?: string[]
  timeoutMs?: number
  signal?: AbortSignal
}

export interface CompleteOnceResult {
  text: string
  /** stop=正常答完 / length=被 max_tokens 截 / error=上游或解析错 / timeout=超时 / unreachable=连不上 */
  finishReason: "stop" | "length" | "error" | "timeout" | "unreachable"
  promptTokens?: number
  completionTokens?: number
  error?: string
}

export async function completeOnce(cfg: LlmConfig, o: CompleteOnceOpts): Promise<CompleteOnceResult> {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions"
  const body: Record<string, unknown> = {
    model: o.model,
    messages: o.messages,
    stream: false,
    temperature: 0,
    max_tokens: o.maxTokens ?? 128,
  }
  if (o.system) body.messages = [{ role: "system", content: o.system }, ...o.messages]
  if (o.stop?.length) body.stop = o.stop

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 15_000)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  const onOuter = (): void => ctl.abort()
  o.signal?.addEventListener("abort", onOuter, { once: true })
  try {
    const resp = await egressFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => "")
      return { text: "", finishReason: "error", error: `分类通道 ${resp.status}：${text.slice(0, 200)}` }
    }
    /* 解析单独兜一层：200 但 body 不是 JSON（网关把 502 包成 HTML 页、登录劫持页）
       不能落进下面的 catch 被报成"连不上分类通道"——那是误导排查方向：
       通道连上了，坏的是响应格式。 */
    let j: Record<string, any>
    try {
      j = (await resp.json()) as Record<string, any>
    } catch (e) {
      const msg = (e as Error).message || String(e)
      return { text: "", finishReason: "error", error: `分类通道响应不是 JSON：${msg.slice(0, 160)}` }
    }
    const choice = j?.choices?.[0]
    const text = String(choice?.message?.content ?? "")
    const finish = String(choice?.finish_reason ?? "")
    return {
      text,
      finishReason: finish === "length" ? "length" : "stop",
      promptTokens: Number(j?.usage?.prompt_tokens) || undefined,
      completionTokens: Number(j?.usage?.completion_tokens) || undefined,
    }
  } catch (err) {
    const e = err as { name?: string; message?: string }
    // 超时与"外部取消"在本地都长得像 AbortError：看外层信号存不存在来分家
    if (e.name === "AbortError") {
      return o.signal?.aborted
        ? { text: "", finishReason: "error", error: "调用被取消" }
        : { text: "", finishReason: "timeout", error: `分类调用超时（${o.timeoutMs ?? 15_000}ms）` }
    }
    return { text: "", finishReason: "unreachable", error: `连不上分类通道：${e.message || e.name}` }
  } finally {
    clearTimeout(timer)
    o.signal?.removeEventListener("abort", onOuter)
  }
}

/**
 * 本次请求的候选模型链：首选 + 备用 + 套餐内兜底（去重、丢掉 `auto` 这类**未裁决**的占位）。
 *
 * `auto` 不是一个模型名，是"请你替我挑"的占位；把它发给接口，就是拿一个它不认识的
 * 名字去请求。裁决只该发生一次，且在后端——所以这里的职责只是把裁决结果排好队。
 *
 * **兜底为什么挂在这里**：eva-ai 切到包月套餐后，按量档（kimi-k3 / qwen-max …）
 * 从通道里下架了，而它们的名字可能还留在用户选过的设置里。那种名字发过去必然
 * `503 模型通道未配置`，整轮任务就败在一个用户选不回来的模型上。挂上同套餐的
 * 备选，请求阶段失败时顺着退（只在**一个字都还没吐出去**时换，已有逻辑保证）。
 * `custom:` 是自带通道，EVA 的备选跟它没关系，不能往它的链上挂。
 */
export function modelChain(cfg: LlmConfig): string[] {
  const out: string[] = []
  for (const m of [cfg.model, ...(cfg.routes || [])]) {
    const v = (m || "").trim()
    if (!v || v === "auto" || out.includes(v)) continue
    out.push(v)
  }
  if (!out.some((m) => m.startsWith("custom:"))) {
    for (const m of aliveFallbacks()) if (!out.includes(m)) out.push(m)
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
  /* usage 索要开关（见 streamChat 里的注释）：默认关，EVA_LLM_STREAM_USAGE=1 才开 */
  const streamUsage = ["1", "on", "true"].includes((process.env.EVA_LLM_STREAM_USAGE || "").trim().toLowerCase())
  /* 服务端上下文管理：整段 JSON 原样透传，解析失败就当没配（不猜形状、不报错拦启动） */
  let contextManagement: unknown
  const cmRaw = (process.env.EVA_LLM_CONTEXT_MANAGEMENT || "").trim()
  if (cmRaw) {
    try {
      contextManagement = JSON.parse(cmRaw)
    } catch {
      console.error("[llm] EVA_LLM_CONTEXT_MANAGEMENT 不是合法 JSON，已忽略")
    }
  }
  return { baseUrl, token, model, routes, streamUsage, contextManagement }
}
