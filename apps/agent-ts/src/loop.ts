// 主循环：turn / step。
//
// 一个 **step** = 一次模型请求 + 它调用的工具；一个 **turn** = 若干 step，直到模型不再要工具。
// （这个概念与 deepseek-harness 的 turn flow 一致，Python 版 evawork 里叫"步骤"。）
//
// 刻意的边界：
//   1. **不按步数 / 不按时间 / 不按"有没有进展"收口**。跑多少步、跑多久由模型按任务
//      复杂度自己决定——写死上限等于替它猜，猜错了只能让用户点「继续」补救。
//      真正的失控只有一个硬证据：绕不出来（同一工具 + 完全相同参数反复调用，
//      由 `LoopGuard` 判定）；慢与长都不是失控，不再替用户"好心收尾"。
//   2. **取消是协作式**的：收到 AbortSignal 就在当前 step 边界停，已拿到的正文原样保留，
//      不重发、不重试（用户已经不想看了）。

import type { InboxMessage, LlmConfig, Message, SessionEvent, StreamChunk, ToolCall, ToolContext, ToolResult } from "./types.ts"
import type { StopReason } from "./types.ts"
import { parallelSafe } from "./types.ts"
export type { StopReason }

import { streamChat } from "./llm.ts"
import { allTools, executeTool, openaiSchemas, parseArgs, preExecute } from "./tools.ts"
import type { PreExecResult } from "./tools.ts"
import type { SessionLog } from "./session.ts"
import { LoopGuard } from "./guard.ts"
import { maybeSpill } from "./spill.ts"
import { compactMessages, projectEvents, clipText, estimateTokens, withCompactSummary, NOTICE_PREFIX, systemNotice } from "./context.ts"
import type { ContextUsage } from "./context.ts"
import { computeContextUsage } from "./usage.ts"
import { ensureMemoryDir, formatIndexForContext, loadIndex } from "./memory.ts"
import { telemetry } from "./telemetry.ts"

import { rewindPoint } from "./session.ts"
import { SystemPrompt } from "./prompt.ts"
import type { PromptContext } from "./prompt.ts"

const MAX_TOOL_RESULT = 20_000

/** 模型流的接缝：默认走 `llm.ts`，测试/替代 driver 可以换掉（TS-041 的 adapter seam）。 */
export type StreamFn = (
  cfg: LlmConfig,
  messages: Message[],
  opt: { tools?: unknown[]; signal?: AbortSignal },
) => AsyncIterable<StreamChunk>

export interface TurnOptions {
  prompt: string
  cfg: LlmConfig
  workspace: string
  log: SessionLog
  system?: string
  /**
   * 上下文压缩时，要不要让模型把被丢掉的轮次归档成结论（TS-042 第二层）。
   * 默认开。子代理传 false：它生命周期短、几乎撞不到压缩，多一次模型调用是纯亏。
   */
  archiveDropped?: boolean
  signal?: AbortSignal
  /**
   * 本轮是**子代理的 turn**（runSubagent 传 true）。它决定两件事：
   * `handback` 工具认不认这次交付（ToolContext.subtask），以及交付闸在 step 边界生效。
   */
  subtask?: boolean
  /**
   * 在每个 step 边界拉一次外部注入的消息（agent 的 inbox；中途插话靠它）。
   * **带来源**：用户插话与系统转发（后台任务完成通知等）协议上不同——
   * 系统来源的注入必须自带"非用户输入"声明（文档 19 P0-4），见下面的注入代码。
   */
  inbox?: () => InboxMessage[]
  /** 换掉模型流：不填就用 `streamChat`。**这是给测试和替代 driver 留的口子。** */
  stream?: StreamFn
  /** 工具子集（子代理用）：只把白名单里的工具暴露给这次 turn。不填 = 全部。 */
  tools?: string[]
  /** 提示词构造器（由启动清单装配，TS-050）；不填用默认分节。
      注意别叫 `prompt`——那是用户目标的字段名，撞了会变成"给模型发的提示词是字符串"。 */
  systemPrompt?: SystemPrompt
  onText?: (s: string) => void
  /** 每个 step 的上下文用量（TS-065）：供界面监控条显示"还能塞多少、被什么吃掉的"。
      它是**派生值、不落盘**——所以走回调而不是事件，免得把会话日志撑大。 */
  onUsage?: (u: ContextUsage) => void
  onTool?: (name: string, args: Record<string, unknown>, res: ToolResult | null, denied: string) => void
  /** 每个落盘事件也推一份给调用方（SDK 用它把事件流转发给外部进程）。 */
  onEvent?: (e: SessionEvent) => void
}

/* ---- 第二层压缩：把被丢掉的轮次让模型归档成结论（借鉴 DSH） ----
   第一层（context.ts 的 clipText + 丢整轮）是无模型的、免费的、永远能做的；
   但它只让模型知道"东西没了"，不知道"没了什么"。第二层补的就是这个洞：
   真丢了轮次，就让模型把那些轮次压成一份结论清单贴回上下文，
   于是"收集了半天，一压缩就白收集"不成立。

   三条刻意的约束（都是为了不让这一层反噬）：
     1. **素材有上限**：输入封顶、每条掐头去尾。再大就是"为了省上下文先烧一次
        更大的请求"，本末倒置。
     2. **失败即退回**：拿不到归档就退回第一层的行为，绝不把主循环带崩，
        也绝不编一段假摘要糊上去。
     3. **不传 tools**：归档是一次"写笔记"，绝不能让它顺手去调工具改环境。 */

/** 送进归档的素材上限（token）。 */
const SUMMARY_INPUT_MAX_TOKENS = 24_000
/** 归档输出上限（字符）：它要替代的是几万 token 的原始轮次，几千字足够。 */
const SUMMARY_OUT_MAX_CHARS = 2_000
/** 归档超时（ms）。它是锦上添花，卡住绝不能把主循环拖住。 */
const SUMMARY_TIMEOUT_MS = 30_000
/** 单条素材的掐头去尾（字符）。 */
const SUMMARY_ITEM_MAX_CHARS = 800
/** **每轮**最多归档几次。上下文吃紧时会每步都丢轮次，不封顶就是每步多烧一次模型调用。 */
const SUMMARY_MAX_PER_TURN = 3

/** 把被丢的消息压成一段"给人看的文字素材"，供模型归档。 */
function transcriptForSummary(dropped: Message[]): string {
  const lines: string[] = []
  let used = 0
  for (const m of dropped) {
    let line: string
    if (m.role === "tool") {
      line = `【工具 ${m.name ?? ""}】${clipText(String(m.content ?? ""), SUMMARY_ITEM_MAX_CHARS)}`
    } else if (m.tool_calls && m.tool_calls.length) {
      const calls = m.tool_calls.map((c) => `${c.name}(${clipText(c.arguments || "{}", 200)})`).join(", ")
      line = `【助手 · 调用工具】${calls}`
    } else if (m.role === "user") {
      line = `【用户】${clipText(String(m.content ?? ""), SUMMARY_ITEM_MAX_CHARS)}`
    } else {
      line = `【助手】${clipText(String(m.content ?? ""), SUMMARY_ITEM_MAX_CHARS)}`
    }
    if (!line.trim()) continue
    const t = estimateTokens(line)
    if (used + t > SUMMARY_INPUT_MAX_TOKENS) {
      // 到上限就**明说截断了**：静默截会让模型以为自己看全了
      lines.push("…（素材已达上限，后续轮次未纳入归档）")
      break
    }
    used += t
    lines.push(line)
  }
  return lines.join("\n")
}

/** 归档请求本身：一次纯文本生成，不带任何工具。 */
function summaryRequest(transcript: string): Message[] {
  return [
    {
      role: "system",
      content: [
        "你在为一个编程智能体做**上下文归档**。它刚把早期若干轮对话从上下文里移除了，",
        "那些原始内容它自己以后再也看不到。",
        "你唯一的任务：把那些轮次里**已经确定的结论**压成一份紧凑清单，",
        "让它不用重跑一遍就能接着干活。",
        "规则：",
        "1. 只写结论与事实（找到了哪些文件/接口/约定、问题出在哪、做过哪些修改、还剩什么没做）。",
        "2. 不要写过程、不要写客套话、不要复述工具名。",
        "3. 没有得出结论的探索过程直接省略。",
        "4. 简体中文，最多 12 条，每条一行。",
        "5. **不要调用任何工具**，只输出清单本身。",
      ].join("\n"),
    },
    { role: "user", content: `以下是即将被移除的轮次：\n\n${transcript}` },
  ]
}

/**
 * 问模型"这些被丢的轮次里你已经确定了什么"。拿不到就返回空串（=退回第一层）。
 *
 * 走 `stream` 接缝而不是直接 `streamChat`：测试与替代 driver 换的是同一个口，
 * 这里必须跟着换——否则自检里那套假模型会被真网络调用绕过。
 */
async function summarizeDropped(
  dropped: Message[],
  stream: StreamFn,
  cfg: LlmConfig,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (!dropped.length) return ""
  const transcript = transcriptForSummary(dropped)
  if (!transcript) return ""

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), SUMMARY_TIMEOUT_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  const onOuterAbort = (): void => ctl.abort()
  signal?.addEventListener("abort", onOuterAbort, { once: true })
  const stop = telemetry.time("context.summarize")
  try {
    let out = ""
    // 注意不传 tools：这是一次"写笔记"，绝不能让它顺手改环境
    for await (const chunk of stream(cfg, summaryRequest(transcript), { signal: ctl.signal })) {
      if (chunk.type === "text") {
        out += chunk.text
        if (out.length >= SUMMARY_OUT_MAX_CHARS) break
      } else if (chunk.type === "error") {
        // 通道本身报错就别编：老老实实退回"只提示丢了"
        stop()
        return ""
      }
    }
    return out.trim().slice(0, SUMMARY_OUT_MAX_CHARS)
  } catch {
    return ""
  } finally {
    stop()
    clearTimeout(timer)
    signal?.removeEventListener("abort", onOuterAbort)
  }
}

export interface TurnResult {
  text: string
  steps: number
  stopReason: StopReason
  note: string
  /** 本轮**未成功**的工具调用数（执行失败 + 被拒）——"completed"只说明模型
   *  停止了调用，不说明这些调用都做成了；界面要拿它说"完成（有失败）"。 */
  failedTools: number
}

export async function runTurn(o: TurnOptions): Promise<TurnResult> {
  // 遥测（TS-053）：只记数字与名字，不记 prompt / 参数 / 正文
  const stopTurn = telemetry.time("turn")

  /** 循环卫生（TS-024）：只做判定，停不停由下面决定。 */
  const guard = new LoopGuard()

  /** 落盘 + 转发给调用方（SDK 靠它把事件流推给外部进程）。 */
  const emit = (ev: Omit<SessionEvent, "seq" | "ts">): SessionEvent => {
    const full = o.log.append(ev)
    o.onEvent?.(full)
    return full
  }

  const messages: Message[] = []
  // 提示词按节组装（TS-040）：档位/边界/审批语义是从**运行时状态**渲染出来的，
  // 不是写死的文本——否则改了档位而提示词还在说"可以随便写"，模型就会一直撞拒绝。
  const sp = o.systemPrompt ?? new SystemPrompt()
  if (o.system) sp.setText("identity", o.system)
  const ctx: PromptContext = {
    workspace: o.workspace,
    // 提示词里的工具清单 = **这一轮实际暴露给模型的那份**（o.tools 就是暴露名单/子集）。
    // 用全量注册表会把子代理专属通道（handback）也列进主任务提示词——
    // 名单里出现却调不通的工具，只会诱导模型去猜。
    tools: o.tools ?? allTools().map((t) => t.name),
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
  }
  messages.push({ role: "system", content: sp.build(ctx) })

  /* 持久记忆索引（文档 19 P0-5）：每轮从磁盘现读，作为**独立一条 system 消息**注入。
     不进固定前缀——写一条记忆索引就多一行，塞进前缀等于让缓存前缀天天失效；
     也不指望模型"记得去读 MEMORY.md"——忘了是常态，清单在眼前才会真去读正文。
     空清单不注入（没有记忆就没有这条消息，缓存前缀与"从无记忆"完全一致）。 */
  ensureMemoryDir(o.workspace)
  const memoryIndex = formatIndexForContext(loadIndex(o.workspace))
  if (memoryIndex) messages.push({ role: "system", content: memoryIndex })

  /* 本轮共享的工具上下文：
     - loadedSkills 每个 runTurn 一个新 Set（load_skill 的幂等保护，跨轮不残留——
       技能正文本来就会在压缩时被丢，残留反而会让"重新加载"被错误地拒绝）；
     - handback 由子代理的交付工具写入，step 边界统一收口（见下面交付闸）；
     - cfg/log 传进去，delegate 才知道自己有没有模型通道可派子代理。 */
  const toolCtx: ToolContext = {
    workspace: o.workspace,
    signal: o.signal,
    cfg: o.cfg,
    log: o.log,
    subtask: o.subtask,
    loadedSkills: new Set<string>(),
  }

  /* 历史对话必须进上下文（TS-063）。
     此前每轮都是「system + 当前这一句」——**追问其实是没有记忆的**：
     用户以为它记得上文，它其实每次都从零开始（`projectEvents` 写好了却没人调用）。
     真相源就是事件日志：投影回来，并按预算压缩（保轮次完整，不拆散 tool 配对）。
     有回退点时只投影到那个点为止——这就是"撤销对话"。 */
  const rp = rewindPoint(o.log)
  const past = o.log.events().filter((e) => !rp || Number(e.seq) < rp)
  const history = projectEvents(past)
  if (history.length) messages.push(...compactMessages(history).messages)

  messages.push({ role: "user", content: o.prompt })

  emit({ type: "turn/start", prompt: o.prompt, model: o.cfg.model, workspace: o.workspace })
  emit({ type: "agent/status", status: "running" })

  let steps = 0
  let finalText = ""
  let stopReason: StopReason = "completed"
  let note = ""
  let failedTools = 0
  // 上一次向界面上报的压缩量（-1 = 还没报过）。只有"又多丢了轮/又截了条"才再报一次，
  // 否则一个超预算的 turn 会每个 step 都推一条相同的"已压缩"notice（TS 任务里实测连发 8 条）。
  let lastCompactDropped = -1
  let lastCompactTruncated = -1
  // 这一轮已经让模型归档过几次（第二层压缩）。每轮封顶，见 SUMMARY_MAX_PER_TURN。
  let summariesThisTurn = 0

  /* 这次**真正发给模型**的工具集：算用量必须用同一份，否则面板上的数字与请求对不上。
     子代理传了 `tools` 白名单就按它过滤（与下面 stream 调用共用，不再各算一遍）。 */
  const visible = o.tools ? allTools().filter((t) => o.tools!.includes(t.name)) : allTools()

  for (;;) {
    if (o.signal?.aborted) { stopReason = "cancelled"; note = "收到取消信号，已在本步边界停下"; break }
    steps += 1
    telemetry.count("step")
    emit({ type: "step/start", step: steps })
    emit({ type: "agent/step", step: steps })

    /* inbox：外部在 step 边界插进来的话（人中途插一句、后台任务完成通知、子代理回话）。
       只在**第 2 步之后**注入——第 1 步前注入等于把目标又说一遍。
       **带来源的注入**（文档 19 P0-4）：jobs 的通知在源头就包了 systemNotice，
       这里兜住"没包装的漏网之鱼"——system 来源没带声明前缀就当场补上，
       绝不裸着进对话：模型把"任务跑完了"读成"用户让我继续"是真实发生过的事故。 */
    if (steps > 1) {
      for (const m of o.inbox?.() || []) {
        const raw = String(m.message || "")
        if (!raw.trim()) continue
        const isSystem = m.source === "system"
        const body = isSystem && !raw.startsWith(NOTICE_PREFIX) ? systemNotice("inbox", raw) : raw
        messages.push({ role: isSystem ? "system" : "user", content: body })
        emit({ type: "agent/inbox", step: steps, message: body, source: isSystem ? "system" : "user" })
      }
    }

    /* 上下文压缩（TS-042）：**丢的是投影，不是事实**——事件日志里还在。
       放在请求前做，而不是等快炸了再抢救。
       幂等上报：只有"丢的轮数/截断的条数"相对上次**增加**才再通知界面一次，
       否则超预算的 turn 会每个 step 都推一条相同的"已压缩"notice。
       两层（见 summarizeDropped）：第一层无模型地丢；第二层让模型把丢掉的那些
       归档成结论贴回来——否则"收集了半天，一压缩就白收集"。 */
    let c = compactMessages(messages)
    if ((c.droppedTurns > 0 || c.truncated > 0) && (c.droppedTurns !== lastCompactDropped || c.truncated !== lastCompactTruncated)) {
      telemetry.count("context.compact")
      /* 归档默认只给主任务做（`archiveDropped !== false`，子代理传 false）：
         子代理生命周期短、几乎撞不到压缩——为每个子代理加一次模型调用是纯亏。
         取消中也不做：用户已经不想看了，没必要为一个必然被丢的结果付费。 */
      if (c.droppedTurns > 0 && o.archiveDropped !== false && !o.signal?.aborted) {
        /* 每轮封顶：上下文吃紧时几乎**每步**都在丢轮次，不封顶就会变成"每步多烧一次
           模型调用"，而且恰好烧在最不该花钱的时刻。封顶后仍退回第一层（照丢不误），
           只是不再替它写归档——前几次归档已经把早期结论保住了，边际收益远低于成本。 */
        if (summariesThisTurn < SUMMARY_MAX_PER_TURN) {
          summariesThisTurn += 1
          c = withCompactSummary(c, await summarizeDropped(c.droppedMessages, o.stream ?? streamChat, o.cfg, o.signal))
        } else {
          telemetry.count("context.summarize.skipped")
        }
      }
      messages.length = 0
      messages.push(...c.messages)
      emit({
        type: "context/compact",
        step: steps,
        droppedTurns: c.droppedTurns,
        truncated: c.truncated,
        charsBefore: c.charsBefore,
        charsAfter: c.charsAfter,
      })
      lastCompactDropped = c.droppedTurns
      lastCompactTruncated = c.truncated
    }

    /* 用量快照（TS-065）：放在压缩之后、请求之前——此刻的 messages 就是要发出去的那一份，
       所以算出来的占比与真实占用一致（不是"猜"出来的另一套数）。 */
    o.onUsage?.(computeContextUsage({ system: sp, promptCtx: ctx, tools: visible, messages }))

    /* 不设单步时限：慢 ≠ 挂死，按秒猜模型的死活只会把正常的长思考/长工具
       误杀成"已放弃本步"（实测：长上下文下委托一个子代理跑满 300s 很正常）。
       收尾只看两个信号：用户点停止（o.signal）与整轮的墙钟/无进展停止条件，
       它们会在下一步开跑前如实把这一轮停下。 */
    emit({ type: "agent/request", step: steps, messages: messages.length })
    let text = ""
    let calls: ToolCall[] = []
    let err = ""
    const stream = o.stream ?? streamChat
    const pump = (async (): Promise<void> => {
      for await (const chunk of stream(o.cfg, messages, {
        tools: openaiSchemas(visible),
        signal: o.signal,
        step: steps,
      })) {
        if (chunk.type === "text") {
          text += chunk.text
          o.onText?.(chunk.text)
        } else if (chunk.type === "tool_calls") {
          calls = chunk.calls
        } else if (chunk.type === "usage") {
          /* 缓存命中率读数（文档 19 P2-11）：只有 EVA_LLM_STREAM_USAGE 开着才有分片。
             只进遥测、不进事件日志——它是聚合指标，不是会话事实；
             cached/prompt 的比值就是"只追加不修改"纪律（P1-10）的验收指标。 */
          if (chunk.promptTokens) telemetry.count("llm.prompt_tokens", chunk.promptTokens)
          if (chunk.cachedTokens) telemetry.count("llm.cached_tokens", chunk.cachedTokens)
          if (chunk.completionTokens) telemetry.count("llm.completion_tokens", chunk.completionTokens)
        } else if (chunk.type === "error") {
          err = chunk.message
        }
      }
    })()
    await pump

    // 用户点了停止：就得报"已取消"，不能因为它这轮没再调工具而报"已完成"
    if (o.signal?.aborted) {
      stopReason = "cancelled"
      note = "收到取消信号，已停下（已流出的正文保留）"
      break
    }

    if (err) {
      stopReason = "error"
      note = err
      emit({ type: "step/error", step: steps, error: err })
      break
    }

    const assistant: Message = { role: "assistant", content: text || null }
    if (calls.length) assistant.tool_calls = calls
    messages.push(assistant)
    o.log.append({
      type: "assistant/message",
      step: steps,
      text,
      calls: calls.map((c) => ({ name: c.name, args: c.arguments })),
    })

    if (!calls.length) {
      finalText = text
      break
    }
    // 还要继续：把"为什么继续"落成事件，调用方能据此决定要不要掐断（DSH 的 turn-stopping 挂点）
    emit({ type: "agent/continuation", step: steps, reason: `模型请求 ${calls.length} 个工具`, tools: calls.map((c) => c.name) })

    /* ---- 工具调用分三段处理（文档 19 P2-14 的并行口径）----
       **计划**（按调用顺序）：子集拒 → 循环卫生 → preExecute（含安全分类器）。
         全部 `tool/call` 事件按序在这里落——界面先看见"这一步要干什么"，再看见结果。
       **执行**：这批要真跑的执行段**全部** parallelSafe（read / memory_write / llm）才并行；
         掺进一个 write / command / network 就整批退回串行。判据是动作类别不是工具名——
         新工具默认落串行是安全的错法，把并行窗口开大才需要论证。
       **落账**（仍按调用顺序）：`tool/result`、onTool、失败计数、工具消息全部按**调用顺序**落，
         并行只改完成顺序，不改协议顺序——tool 消息与 tool_calls 的配对按 id 成立，
         但乱序落盘会让回放看起来像配错了行，不给这个机会。 */
    interface Planned {
      c: ToolCall
      args: Record<string, unknown>
      /** 非空 = 不执行，直接以"未执行：{reject}"回填。 */
      reject?: string
      /** 子代理越界调用：既有语义是"有 tool/call、无 tool/result、不计失败"。 */
      subset?: boolean
      /** 循环卫生拒绝：既有语义是"tool/result 带专门话术、计一次失败"。 */
      looped?: boolean
      /** preExecute 的判定结果（只有真走到这层的调用才有）。 */
      pre?: PreExecResult
      /** 循环卫生的提醒（不拦，只贴进结果）。 */
      warn?: string
      /** 执行结果（进入执行段的调用才有）。 */
      res?: ToolResult
    }

    const plans: Planned[] = []
    for (const c of calls) {
      const args = parseArgs(c.arguments)

      /* 工具子集（子代理）：子集外的调用**明确拒绝并把名单带回去**。
         只靠"不给它看 schema"是不够的——模型会自己猜名字调过来。 */
      if (o.tools && !o.tools.includes(c.name)) {
        telemetry.count("tool.denied", 1, { tool: c.name, reason: "工具子集外" })
        const reason = `子代理不可用工具 ${c.name}（可用：${o.tools.join(", ")}）`
        emit({ type: "tool/call", step: steps, call: c.id, tool: c.name, args, allowed: false, reason: "工具子集外" })
        plans.push({ c, args, reject: reason, subset: true })
        continue
      }

      /* 循环卫生：同一个工具、同一组参数反复调用 = 卡住了。
         第 5 次不再硬停整个 turn（那样会报错），而是跳过这次调用、把"你被循环阻断了"
         作为工具结果喂给模型，让模型自己换做法或向用户说明。 */
      const verdict = guard.record(c.name, args)
      if (verdict.kind === "stop") {
        emit({ type: "tool/call", step: steps, call: c.id, tool: c.name, args, allowed: false, reason: "循环调用" })
        plans.push({ c, args, reject: verdict.reason, looped: true })
        continue
      }

      const pre = await preExecute(c.name, args, { cfg: o.cfg, signal: o.signal })
      // emit 而不是 log.append：工具事件**要推给界面**——执行过程卡片就靠这两类事件
      // （tool/call → "在跑什么"，tool/result → 结果与成败）。只落盘的话，
      // 界面的"执行过程"里就只有叙述文字，用户看不到它到底干了什么。
      // call = OpenAI 的 tool_call_id：界面靠它配对"调用 → 结果"。**一轮可以并发
      // 调多个同名工具**（两次 list_dir），用 step+tool 拼 id 会撞车——结果回填错行、
      // 去重误杀，界面上工具卡片就少一截。
      emit({ type: "tool/call", step: steps, call: c.id, tool: c.name, args, allowed: pre.allowed, reason: pre.reason })
      plans.push({ c, args, pre, reject: pre.allowed ? undefined : pre.reason, warn: verdict.kind === "warn" ? verdict.reason : undefined })
    }

    /* 执行段：全并行或全串行，没有"一半一半"——掺进 write/command 时，
       并行的那半先跑完也可能把串行的依赖顺序搅乱，整批串行最省心。 */
    const toRun = plans.filter((p) => !p.reject && p.pre)
    if (toRun.length > 1 && toRun.every((p) => parallelSafe(p.pre!.action))) {
      telemetry.count("tool.parallel_batch")
      await Promise.all(
        toRun.map((p) => {
          const stop = telemetry.time("tool", { tool: p.c.name })
          return executeTool(p.pre!.tool!, p.args, toolCtx).then((r) => {
            p.res = r
            stop()
          })
        }),
      )
    } else {
      for (const p of toRun) {
        const stop = telemetry.time("tool", { tool: p.c.name })
        p.res = await executeTool(p.pre!.tool!, p.args, toolCtx)
        stop()
      }
    }

    /* 落账：按调用顺序。上面执行段只往 p.res 里放结果，这里才产生事件与消息。 */
    for (const p of plans) {
      let content: string
      if (p.reject) {
        content = `未执行：${p.reject}`
        if (p.subset) {
          // 走 onTool 的"被拒"通道：子代理据此把它带回主任务（TS-043）
          o.onTool?.(p.c.name, p.args, null, p.reject)
          if (p.warn) content += `\n[循环卫生] ${p.warn}`
          messages.push({ role: "tool", tool_call_id: p.c.id, name: p.c.name, content })
          continue
        }
        failedTools += 1
        if (p.looped) {
          content = `${p.reject}。本次调用已被跳过，请换一种做法或向用户说明当前卡住的原因。`
          emit({ type: "tool/result", step: steps, call: p.c.id, tool: p.c.name, ok: false, error: content, content })
          o.onTool?.(p.c.name, p.args, { ok: false, error: content }, "循环调用")
        } else {
          telemetry.count("tool.denied", 1, { tool: p.c.name, reason: String(p.reject).slice(0, 80) })
          emit({ type: "tool/result", step: steps, call: p.c.id, tool: p.c.name, ok: false, error: content, content })
          o.onTool?.(p.c.name, p.args, null, String(p.reject))
        }
        // 提醒要**进到模型能看到的地方**（工具结果里），否则它不知道自己在打转
        if (p.warn) content += `\n[循环卫生] ${p.warn}`
        messages.push({ role: "tool", tool_call_id: p.c.id, name: p.c.name, content })
        continue
      }

      const res = p.res!
      content = res.ok ? String(res.output ?? "") : `执行失败：${res.error}`
      // content 一并落盘：事件日志是真相源，只记长度的话回放时无法还原上下文（TS-042）
      emit({
        type: "tool/result",
        step: steps,
        call: p.c.id,
        tool: p.c.name,
        ok: res.ok,
        chars: content.length,
        content,
        // 子代理轨迹（只有 delegate 会给）：界面那张卡的数据源，与后端同形
        subagent: res.subagent ?? null,
      })
      o.onTool?.(p.c.name, p.args, res, "")
      if (!res.ok) {
        failedTools += 1
        telemetry.count("tool.failed", 1, { tool: p.c.name })
      }
      if (p.warn) content += `\n[循环卫生] ${p.warn}`
      // 长输出溢出到文件：不把几万字符塞回上下文（TS-031）
      const shown = maybeSpill(o.workspace, content.slice(0, MAX_TOOL_RESULT))
      messages.push({ role: "tool", tool_call_id: p.c.id, name: p.c.name, content: shown.text })
    }

    /* 交付闸（文档 19 P0-3）：handback 工具写入正文后，在 **step 边界**收口——
       此刻本轮的 tool_call 已全部配好 tool_result，协议不破。
       放在这里而不是调用当场，是因为当场 break 会把同批其余调用劈成半截。 */
    if (toolCtx.handback !== undefined) {
      finalText = toolCtx.handback
      stopReason = "handback"
      note = "子代理经 handback 交付结论，本轮到此为止"
      emit({ type: "step/end", step: steps })
      break
    }

    emit({ type: "step/end", step: steps })
  }

  telemetry.count(`turn.stop.${stopReason}`)
  stopTurn()
  emit({ type: "agent/turn-stopping", reason: stopReason, steps, note })
  emit({ type: "agent/status", status: stopReason === "completed" ? "done" : "stopped", note })
  emit({ type: "turn/end", steps, stop: stopReason, note, text: finalText, failedTools })
  return { text: finalText, steps, stopReason, note, failedTools }
}
