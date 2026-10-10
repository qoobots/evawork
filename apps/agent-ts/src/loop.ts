// 主循环：turn / step。
//
// 一个 **step** = 一次模型请求 + 它调用的工具；一个 **turn** = 若干 step，直到模型不再要工具。
// （这个概念与 deepseek-harness 的 turn flow 一致，Python 版 evawork 里叫"步骤"。）
//
// 两条刻意的边界：
//   1. **有轮次上限**。dsh 没有内置上限（它要求调用方用 `agent/turn-stopping` 自行封顶），
//      而 evawork 实测撞过"工具轮次上限"——所以这里默认 12 步，到了就如实停下，
//      绝不假装任务完成了。
//   2. **取消是协作式**的：收到 AbortSignal 就在当前 step 边界停，已拿到的正文原样保留，
//      不重发、不重试（用户已经不想看了）。

import type { LlmConfig, Message, SessionEvent, StreamChunk, ToolCall, ToolResult } from "./types.ts"
import type { StopReason } from "./types.ts"
export type { StopReason }

/**
 * 步数预算到点时给模型的提醒。
 *
 * 这一步以前是"撞线就停 → 界面弹「继续」→ 用户决定"。用户要的是反过来：
 * **由模型自己判断该不该继续**，所以这里把预算现状和两个明确选项交给它，
 * 并要求它把"还需要多少步、为什么"讲出来——步数于是变成模型按任务复杂度
 * 分析出来的结果，而不是一个写死的数字。
 */
function budgetNotice(maxSteps: number): string {
  return [
    `[轮次预算] 本轮步数预算（${maxSteps} 步）已用尽。请评估后二选一：`,
    `1) 任务已完成 → 直接给出最终结论，本轮不要再调用其它工具；`,
    `2) 确实还需要继续 → 调用 set_max_steps，说明还需要多少步及理由（最多可到 ${MAX_STEPS_HARD_CAP} 步）。`,
    `不要在不说明的情况下继续调用其它工具。`,
  ].join("\n")
}
import { streamChat } from "./llm.ts"
import { allTools, executeTool, openaiSchemas, parseArgs, preExecute } from "./tools.ts"
import type { SessionLog } from "./session.ts"
import { defaultStopConditions, firstStop, LoopGuard } from "./guard.ts"
import type { StopCondition } from "./guard.ts"
import { DEFAULT_MAX_STEPS, MAX_STEPS_HARD_CAP } from "./boot.ts"
import { maybeSpill } from "./spill.ts"
import { compactMessages, projectEvents, clipText, estimateTokens, withCompactSummary } from "./context.ts"
import type { ContextUsage } from "./context.ts"
import { computeContextUsage } from "./usage.ts"
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

export interface TurnOptions extends TurnStopOptions {
  prompt: string
  cfg: LlmConfig
  workspace: string
  log: SessionLog
  system?: string
  maxSteps?: number
  /**
   * 步数上限当**硬顶**用：到点直接停，不给模型"自己决定要不要继续"的机会。
   *
   * 默认（不传）是**软预算**：到 `maxSteps` 只提醒模型自评——要么收尾给结论，
   * 要么调 `set_max_steps` 申请扩展接着跑；决定权在模型，不甩给用户。
   * 子代理必须传 true——它是并行跑的、每个都在烧钱，需要一个谁来都改不动的封顶，
   * 不能变成"第二个主循环"（见 subagent.ts 的 SUBAGENT_MAX_STEPS）。
   */
  hardStepLimit?: boolean
  signal?: AbortSignal
  /** 在每个 step 边界拉一次外部注入的消息（agent 的 inbox；中途插话靠它）。 */
  inbox?: () => string[]
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

/** 停止条件可整体替换（测试/子代理用）：不填就用 `defaultStopConditions`。 */
export interface TurnStopOptions {
  stopWhen?: StopCondition[]
  /** 墙钟预算（ms） */
  deadlineMs?: number
  /** 连续无进展步数上限 */
  stallSteps?: number
  /** 单步墙钟上限（ms）。可注入是为了能测：默认取自 `guard.ts` 的环境/常量。 */
  stepTimeoutMs?: number
}

/**
 * 合并多个取消信号（零依赖）。
 *
 * 不用 `AbortSignal.any`：一是它的 TS 类型在部分 lib 版本里缺失，二是我们要的语义
 * 只是"谁先到算谁"，手写十行就够，不值得为此改 tsconfig。
 */
function mergeSignals(list: (AbortSignal | undefined)[]): { signal: AbortSignal; dispose: () => void } {
  const src = list.filter((s): s is AbortSignal => !!s)
  // 总是新建自己的 controller：返回 `src[0]` 会让调用方把监听器挂到**外部**信号上，
  // 每步挂一个、又不一定摘得掉，跑满 100 步就撞 MaxListenersExceededWarning。
  const ctl = new AbortController()
  if (!src.length) return { signal: ctl.signal, dispose: () => {} }
  if (src.some((s) => s.aborted)) {
    ctl.abort()
    return { signal: ctl.signal, dispose: () => {} }
  }
  const bound = src.map((s) => {
    const h = (): void => ctl.abort()
    s.addEventListener("abort", h, { once: true })
    return { s, h }
  })
  return {
    signal: ctl.signal,
    dispose: () => {
      for (const b of bound) b.s.removeEventListener("abort", b.h)
    },
  }
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
  let maxSteps = Math.max(1, o.maxSteps ?? DEFAULT_MAX_STEPS)
  // 硬顶模式（子代理）：到 maxSteps 就停。软预算模式（主任务）：见下面的提醒逻辑。
  const hardStepLimit = o.hardStepLimit === true
  // 遥测（TS-053）：只记数字与名字，不记 prompt / 参数 / 正文
  const stopTurn = telemetry.time("turn")

  /** 循环卫生（TS-024）：只做判定，停不停由下面决定。 */
  const guard = new LoopGuard({ maxSteps, stepTimeoutMs: o.stepTimeoutMs })

  /* 结构化停止条件（TS-066）：**硬顶 + 墙钟 + 无进展**一起判。
     步数这一项刻意用 `MAX_STEPS_HARD_CAP` 而不是 `maxSteps`：`maxSteps` 现在是
     "**预算**"——到点只提醒模型自己决定收尾还是 `set_max_steps` 申请扩展，**不硬停**
     （硬停等于把"继不继续"甩给用户点按钮，那正是要去掉的行为）。
     硬顶/deadline/stall 都与 `maxSteps` 无关，所以这份条件建好就是常量，
     `set_max_steps` 只需推后下一次提醒点，不必重建它。 */
  const stopWhen =
    o.stopWhen ??
    defaultStopConditions({
      maxSteps: hardStepLimit ? maxSteps : MAX_STEPS_HARD_CAP,
      deadlineMs: o.deadlineMs,
      stallSteps: o.stallSteps,
    })

  // 软预算的下一次提醒点。默认就在 maxSteps；模型调 set_max_steps 抬高预算后同步推后。
  let nextBudgetNotice = maxSteps
  const startedAt = Date.now()
  /** 距上一次"有进展"过去了多少步（进展 = 本步至少有一个工具执行成功）。 */
  let stepsSinceProgress = 0
  let progressedThisStep = false

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
    tools: allTools().map((t) => t.name),
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
  }
  messages.push({ role: "system", content: sp.build(ctx) })

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

  emit({ type: "turn/start", prompt: o.prompt, model: o.cfg.model, workspace: o.workspace, maxSteps })
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
    /* 停止条件在**每步开始前**判一次（不是只在末尾）：撞线的那一刻就停，
       不再发一次注定要被丢掉的模型请求。 */
    const verdict = firstStop(stopWhen, { steps, startedAt, stepsSinceProgress, now: Date.now() })
    if (verdict) {
      stopReason = verdict.reason
      note = verdict.note
      break
    }
    /* 轮次预算到点：**不硬停**，把"要不要继续"的决定权交回模型。
       它要么收尾给结论（自然结束），要么调 set_max_steps 申请新预算（接着跑）。
       硬停只留给硬顶/墙钟/无进展——那些是真的该停了。 */
    if (!hardStepLimit && steps >= nextBudgetNotice && steps < MAX_STEPS_HARD_CAP) {
      messages.push({ role: "user", content: budgetNotice(maxSteps) })
      emit({ type: "agent/status", status: "running", note: `步数预算（${maxSteps} 步）已用尽，由模型决定收尾或扩展` })
      // 模型若无视提醒继续硬跑，下一个预算点再提醒一次；到硬顶由 firstStop 如实收尾。
      nextBudgetNotice = steps + Math.max(1, maxSteps)
    }
    steps += 1
    progressedThisStep = false
    telemetry.count("step")
    // maxSteps 一并落盘：界面要显示"第 N / M 步"，回放时才能重建（TS-066）
    emit({ type: "step/start", step: steps, maxSteps })
    emit({ type: "agent/step", step: steps, maxSteps })

    /* inbox：外部在 step 边界插进来的话（人中途插一句、子代理回了消息）。
       只在**第 2 步之后**注入——第 1 步前注入等于把目标又说一遍。 */
    if (steps > 1) {
      for (const m of o.inbox?.() || []) {
        messages.push({ role: "user", content: m })
        emit({ type: "agent/inbox", step: steps, message: m })
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
      /* 归档只给主任务做（`!hardStepLimit`）：子代理是并行跑的、每个都在烧钱，
         而且生命周期短、几乎撞不到压缩——在这里为每个子代理加一次模型调用，
         是纯亏。取消中也不做：用户已经不想看了，没必要为一个必然被丢的结果付费。 */
      if (c.droppedTurns > 0 && !hardStepLimit && !o.signal?.aborted) {
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

    /* 单步超时（TS-066）：`guard.stepTimeoutMs` 以前是**死配置**——guard 里定义了值，
       loop 里从没读过，等于没兜底，所以"请求挂住"能一直挂到天亮。
       这里把它接上，并且用同一个 signal 同时取消**模型请求和工具执行**：
       不止是"不再等它"，而是真的把在途请求掐掉，否则挂住的 fetch 还占着连接。
       模型通道另有自己的三段看门狗（首字节/片间静默/总时长，见 llm.ts），
       那是内层；这里是外层兜底，两者不冲突。 */
    const stepCtl = new AbortController()
    const stepTimer = setTimeout(() => stepCtl.abort(), guard.stepTimeoutMs)
    // unref：本步正常结束后即使忘了清，也别让这个计时器拖住进程退出
    ;(stepTimer as unknown as { unref?: () => void }).unref?.()
    const stepSig = mergeSignals([o.signal, stepCtl.signal])
    /** 单步超时到了（且**不是**用户点的取消——那要报 cancelled，语义不同）。 */
    const stepTimedOut = (): boolean => stepCtl.signal.aborted && !o.signal?.aborted

    emit({ type: "agent/request", step: steps, messages: messages.length })
    let text = ""
    let calls: ToolCall[] = []
    let err = ""
    const stream = o.stream ?? streamChat
    /* 与单步超时**赛跑**，而不是"等流结束再回过头看表"：卡住的那一步根本不会结束，
       回看那一行永远执行不到——那正是 TS-066 要治的病（挂在 agent/request 上不返回）。
       赛跑输了也不等它：继续往下走，由 stepTimedOut() 如实收尾。 */
    const pump = (async (): Promise<void> => {
      for await (const chunk of stream(o.cfg, messages, {
        tools: openaiSchemas(visible),
        signal: stepSig.signal,
        step: steps,
      })) {
        if (chunk.type === "text") {
          text += chunk.text
          o.onText?.(chunk.text)
        } else if (chunk.type === "tool_calls") {
          calls = chunk.calls
        } else if (chunk.type === "error") {
          err = chunk.message
        }
      }
    })()
    // 先挂个兜底：赛跑输了以后 pump 仍在跑，它若之后 reject 会变成 unhandled rejection
    pump.catch(() => undefined)
    await Promise.race([
      pump,
      new Promise<void>((res) => stepSig.signal.addEventListener("abort", () => res(), { once: true })),
    ])

    // 用户点了停止：就得报"已取消"，不能因为它这轮没再调工具而报"已完成"
    if (o.signal?.aborted) {
      stopReason = "cancelled"
      note = "收到取消信号，已停下（已流出的正文保留）"
      break
    }

    /* 单步超时：这一步卡住了（最常见就是模型请求没回来）。
       必须排在"模型没调工具 → 已完成"**之前**判——否则卡住的那一步会被当成
       正常结束，界面显示"已完成"而它其实一步都没走完。 */
    if (stepTimedOut()) {
      stopReason = "timeout"
      note = `第 ${steps} 步超过单步时限 ${Math.round(guard.stepTimeoutMs / 1000)}s——卡在这一步，可继续`
      emit({ type: "step/timeout", step: steps, timeoutMs: guard.stepTimeoutMs })
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

    for (const c of calls) {
      const args = parseArgs(c.arguments)

      /* 工具子集（子代理）：子集外的调用**明确拒绝并把名单带回去**。
         只靠"不给它看 schema"是不够的——模型会自己猜名字调过来。 */
      if (o.tools && !o.tools.includes(c.name)) {
        telemetry.count("tool.denied", 1, { tool: c.name, reason: "工具子集外" })
        const reason = `子代理不可用工具 ${c.name}（可用：${o.tools.join(", ")}）`
        const content = `未执行：${reason}`
        messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content })
        emit({ type: "tool/call", step: steps, call: c.id, tool: c.name, args, allowed: false, reason: "工具子集外" })
        // 走 onTool 的"被拒"通道：子代理据此把它带回主任务（TS-043）
        o.onTool?.(c.name, args, null, reason)
        continue
      }

      /* 循环卫生：同一个工具、同一组参数反复调用 = 卡住了。
         第 5 次不再硬停整个 turn（那样会报错），而是跳过这次调用、把"你被循环阻断了"
         作为工具结果喂给模型，让模型自己换做法或向用户说明。 */
      const verdict = guard.record(c.name, args)
      if (verdict.kind === "stop") {
        const loopMsg = `${verdict.reason}。本次调用已被跳过，请换一种做法或向用户说明当前卡住的原因。`
        failedTools += 1
        emit({
          type: "tool/call",
          step: steps,
          call: c.id,
          tool: c.name,
          args,
          allowed: false,
          reason: "循环调用",
        } as Omit<SessionEvent, "seq" | "ts">)
        emit({
          type: "tool/result",
          step: steps,
          call: c.id,
          tool: c.name,
          ok: false,
          error: loopMsg,
          content: loopMsg,
        } as Omit<SessionEvent, "seq" | "ts">)
        messages.push({
          role: "tool",
          tool_call_id: c.id,
          name: c.name,
          content: loopMsg,
        })
        o.onTool?.(c.name, args, { ok: false, error: loopMsg }, "循环调用")
        continue
      }

      const pre = await preExecute(c.name, args)
      // emit 而不是 log.append：工具事件**要推给界面**——执行过程卡片就靠这两类事件
      // （tool/call → "在跑什么"，tool/result → 结果与成败）。只落盘的话，
      // 界面的"执行过程"里就只有叙述文字，用户看不到它到底干了什么。
      // call = OpenAI 的 tool_call_id：界面靠它配对"调用 → 结果"。**一轮可以并发
      // 调多个同名工具**（两次 list_dir），用 step+tool 拼 id 会撞车——结果回填错行、
      // 去重误杀，界面上工具卡片就少一截。
      emit({
        type: "tool/call",
        step: steps,
        call: c.id,
        tool: c.name,
        args,
        allowed: pre.allowed,
        reason: pre.reason,
      } as Omit<SessionEvent, "seq" | "ts">)

      let content: string
      const stopTool = telemetry.time("tool", { tool: c.name })
      if (!pre.allowed) {
        telemetry.count("tool.denied", 1, { tool: c.name, reason: String(pre.reason).slice(0, 80) })
        content = `未执行：${pre.reason}`
        failedTools += 1
        emit({ type: "tool/result", step: steps, call: c.id, tool: c.name, ok: false, error: content, content })
        o.onTool?.(c.name, args, null, pre.reason)
        stopTool()
      } else {
        const res = await executeTool(pre.tool!, args, {
          workspace: o.workspace,
          // 单步超时也要能掐断工具：否则卡在一条命令上时，"停止/超时"都不管用
          signal: stepSig.signal,
          cfg: o.cfg,
          log: o.log,
        })
        content = res.ok ? String(res.output ?? "") : `执行失败：${res.error}`
        // content 一并落盘：事件日志是真相源，只记长度的话回放时无法还原上下文（TS-042）
        emit({
          type: "tool/result",
          step: steps,
          call: c.id,
          tool: c.name,
          ok: res.ok,
          chars: content.length,
          content,
          // 子代理轨迹（只有 delegate 会给）：界面那张卡的数据源，与后端同形
          subagent: res.subagent ?? null,
        })
        o.onTool?.(c.name, args, res, "")
        stopTool()
        // set_max_steps 是元控制调用，不算任务进展（否则模型卡在循环里反复扩上限也能重置 stalled）
        if (res.ok && c.name !== "set_max_steps") progressedThisStep = true // 进展 = 真做成了事，不只是"说了一段话"
        if (!res.ok) {
          failedTools += 1
          telemetry.count("tool.failed", 1, { tool: c.name })
        }

        // 模型主动抬高预算：上限是"预算"不是硬墙，只需把下一次提醒点推到新预算处
        if (!hardStepLimit && c.name === "set_max_steps" && res.ok) {
          const requested = Math.floor(Number(args.steps))
          if (Number.isFinite(requested) && requested >= 1) {
            const next = Math.min(requested, MAX_STEPS_HARD_CAP)
            if (next > maxSteps) {
              maxSteps = next
              nextBudgetNotice = Math.max(steps, maxSteps)
              const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : "模型申请扩展"
              emit({ type: "agent/status", status: "running", note: `本轮步数预算已扩展到 ${maxSteps}（${reason}）` })
            }
          }
        }
      }

      // 提醒要**进到模型能看到的地方**（工具结果里），否则它不知道自己在打转
      if (verdict.kind === "warn") content += `\n[循环卫生] ${verdict.reason}`
      // 长输出溢出到文件：不把几万字符塞回上下文（TS-031）
      const shown = maybeSpill(o.workspace, content.slice(0, MAX_TOOL_RESULT))
      messages.push({
        role: "tool",
        tool_call_id: c.id,
        name: c.name,
        content: shown.text,
      })
      // 工具执行结束
    }

    /* 单步超时也可能是在**工具执行**阶段到的（模型请求那一段已在上面对过）。
       放在 step/end 之前判，这一步才算如实收尾。 */
    if (stepTimedOut()) {
      stopReason = "timeout"
      note = `第 ${steps} 步超过单步时限 ${Math.round(guard.stepTimeoutMs / 1000)}s——卡在这一步，可继续`
      emit({ type: "step/timeout", step: steps, timeoutMs: guard.stepTimeoutMs })
      break
    }

    clearTimeout(stepTimer)
    stepSig.dispose()
    // 无进展计数：本步一个工具都没做成 → 空转 +1；做成了 → 归零
    if (progressedThisStep) stepsSinceProgress = 0
    else stepsSinceProgress += 1
    emit({ type: "step/end", step: steps })
  }

  telemetry.count(`turn.stop.${stopReason}`)
  stopTurn()
  emit({ type: "agent/turn-stopping", reason: stopReason, steps, note })
  emit({ type: "agent/status", status: stopReason === "completed" ? "done" : "stopped", note })
  emit({ type: "turn/end", steps, stop: stopReason, note, text: finalText, failedTools, maxSteps })
  return { text: finalText, steps, stopReason, note, failedTools }
}
