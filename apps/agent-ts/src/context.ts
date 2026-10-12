// 上下文：投影与压缩（TS-042）。
//
// 前提与 DSH 一致：**事件日志是真相源，上下文是它的投影**。
// 所以压缩可以随便丢——丢的是投影，不是事实；要回看，从事件日志重放即可。
//
// 两条硬约束（踩过就会知道）：
//   1. **tool 消息不能落单**。OpenAI 协议里 tool 结果必须挂在一条带 tool_calls 的
//      assistant 消息后面；只把 assistant 丢了，剩下的 tool 消息会让整轮请求直接报错。
//      → 压缩按**轮（assistant + 它的工具结果）**整体丢弃，不按条。
//   2. **第一层压缩不碰模型**（本文件做的全部事情）。理由很实际：压缩恰恰发生在
//      "上下文快满了"的时刻，那是最不该再发一次大请求的时候；而且没有模型时
//      （离线重放、自检）也必须能压。
//
// 但"只丢、只说丢了"有个真实的坑：模型不知道自己丢了什么，于是"收集了半天，
// 一压缩就白收集"。所以**第二层**（`withCompactSummary` + loop.ts 的 `summarizeDropped`）
// 会在真的丢了轮次之后，让模型把那些轮次归档成一份结论清单再贴回去。
// 两层的分工：**丢弃是无模型的、免费的、永远能做的；归档是可选的、会花钱的、失败可退回**。

import type { Message, SessionEvent } from "./types.ts"

export interface ContextBudget {
  /** 投影总**估算 token** 上限（不是字符：中文 1 字 ≈ 1 token，西文 4 字符 ≈ 1 token） */
  maxTokens?: number
  /** 至少保留最近多少轮（assistant + 工具结果算一轮） */
  keepLastTurns?: number
  /** 单条工具输出超过这个长度（字符）就掐头去尾 */
  maxToolChars?: number
}

export interface CompactResult {
  messages: Message[]
  /** 被整体丢弃的轮数 */
  droppedTurns: number
  /**
   * **被丢掉的那些消息本身**。压缩之后模型就看不见它们了，所以调用方要拿这个
   * 去生成一段摘要再补回上下文——否则"收集了半天，一压缩就白收集"，
   * 而模型连自己丢了什么都不知道。
   */
  droppedMessages: Message[]
  /** 被掐头去尾的工具输出条数 */
  truncated: number
  charsBefore: number
  charsAfter: number
  /** 估算 token：**预算就是按它判的**；上面两个字符数只是给事件留的可读量 */
  tokensBefore: number
  tokensAfter: number
}

/* 模型上下文窗口（token）。256K 是产品口径；换更大窗口的模型时用 `EVA_TS_CONTEXT_TOKENS`
   覆盖即可——与 Python 侧 `EVAWORK_MODEL_WINDOW` 同一套语义：窗口来自配置，**不猜**。 */
export const CONTEXT_WINDOW_TOKENS = Math.max(1_000, Number(process.env.EVA_TS_CONTEXT_TOKENS || 0) || 256_000)

/**
 * 压缩阈值比例：**留出余量再压**，而不是等撑爆窗口（对齐 dsh / Python 侧 compaction-basic）。
 *
 * 可用 `EVA_TS_COMPACT_RATIO`（0–1）覆盖。刻意**不做成界面上能实时拖的滑块**：
 * 这个值是子进程启动时读的，改它就得重启智能体进程——做成滑块是假的。
 */
const THRESHOLD_RATIO = (() => {
  const v = Number(process.env.EVA_TS_COMPACT_RATIO || "")
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.8
})()

/** 压缩阈值：上下文估算 token 到这儿才开始丢早期轮次。 */
export const COMPACT_AT_TOKENS = Math.floor(CONTEXT_WINDOW_TOKENS * THRESHOLD_RATIO)

const DEFAULTS = { maxTokens: COMPACT_AT_TOKENS, keepLastTurns: 4, maxToolChars: 4_000 }

/**
 * 粗估 token：**CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token**（与 Python 侧 `estimate_tokens` 同口径）。
 *
 * 不引 tokenizer：那要多一个依赖，而阈值判断只要"偏保守"就够——估多的代价是早压一点，
 * 估少的代价是撑爆窗口，两者不对称。中文按 1 字 1 token 记，天然偏保守。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) if (ch >= "\u2e80") cjk += 1
  return cjk + Math.max(0, Math.floor((text.length - cjk) / 4))
}

/** 一条消息的**结构开销**（role / name / tool_call_id 这些字段本身也吃 token）。 */
const MSG_OVERHEAD = 8

/** 整份消息列表的估算 token（含结构开销与 tool_calls）。 */
export function estimateMessages(messages: Message[]): number {
  let total = 0
  for (const m of messages || []) {
    total += estimateTokens(typeof m.content === "string" ? m.content : "") + MSG_OVERHEAD
    if (m.tool_calls && m.tool_calls.length) total += estimateTokens(JSON.stringify(m.tool_calls)) + MSG_OVERHEAD
  }
  return total
}

const charsOf = (m: Message): number => (m.content ? m.content.length : 0) + JSON.stringify(m.tool_calls || []).length

/** 同一条消息的估算 token（与 `estimateMessages` 保持同一口径，别各算各的）。 */
const tokensOf = (m: Message): number =>
  estimateTokens(typeof m.content === "string" ? m.content : "") +
  (m.tool_calls && m.tool_calls.length ? estimateTokens(JSON.stringify(m.tool_calls)) : 0) +
  MSG_OVERHEAD

/**
 * 把事件日志投影成消息序列（续跑/回放用）。
 *
 * 注意它是**尽力还原**：事件里没有的东西（比如系统提示词原文）还原不出来——
 * 要精确就重新渲染提示词，不要把投影当成唯一真相。
 */
export function projectEvents(events: SessionEvent[]): Message[] {
  const out: Message[] = []
  let pending: string[] = []

  for (const e of events) {
    if (e.type === "turn/start") {
      out.push({ role: "user", content: String(e.prompt ?? "") })
      pending = []
      continue
    }
    if (e.type === "assistant/message") {
      const calls = Array.isArray(e.calls) ? (e.calls as { name: string; args: unknown }[]) : []
      const m: Message = { role: "assistant", content: e.text ? String(e.text) : null }
      if (calls.length) {
        m.tool_calls = calls.map((c, i) => ({
          id: `p${e.seq}-${i}`,
          name: String(c?.name ?? ""),
          arguments: typeof c?.args === "string" ? c.args : JSON.stringify(c?.args ?? {}),
        }))
        pending = m.tool_calls.map((c) => c.id)
      }
      out.push(m)
      continue
    }
    if (e.type === "tool/result" && pending.length) {
      const id = pending.shift() as string
      out.push({
        role: "tool",
        tool_call_id: id,
        name: String(e.tool ?? ""),
        content: String(e.content ?? ""),
      })
    }
  }
  return out
}

/** 掐头去尾：中间丢掉，但保留"这里被截了"的事实（否则模型会以为工具没输出）。 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head
  return `${text.slice(0, head)}\n…（中段省略 ${text.length - max} 字符）…\n${text.slice(text.length - tail)}`
}

/** 把消息流切成"轮"：一轮 = 一条 assistant（+ 紧跟它的 tool 结果）。 */
function toTurns(msgs: Message[]): Message[][] {
  const turns: Message[][] = []
  let cur: Message[] = []
  for (const m of msgs) {
    if (m.role === "tool" && cur.length) {
      cur.push(m)
      continue
    }
    if (cur.length) turns.push(cur)
    cur = [m]
  }
  if (cur.length) turns.push(cur)
  return turns
}

/**
 * 合成提示的前缀。**导出**是因为两层压缩的第二层要靠它认出"这条就是上次压缩留的"，
 * 以及把 LLM 归档嵌回同一条提示里（见 `withCompactSummary`）。
 */
export const COMPACT_NOTE = "[上下文压缩]"

/**
 * 压缩后插在原位的那条合成提示。
 *
 * `summary` 是**被丢那些轮次的 LLM 归档**（第二层压缩，见 `withCompactSummary`）。
 * 没有它，模型只知道"东西没了"，不知道"没了什么"——那正是用户质疑的
 * "收集了半天，一压缩就白收集"。
 */
function compactNote(droppedTurns: number, summary?: string): string {
  const base = `${COMPACT_NOTE} 早期 ${droppedTurns} 轮已从上下文中移除（投影可丢，事实仍在事件日志里）。`
  if (!summary) {
    return `${base}这些内容已不在上下文中——后续若还需要其中的细节，请重新用工具去取。`
  }
  return [
    `${base}以下是**你在那些被移除的轮次里已经确定的结论**，请当作已知事实继续使用，不要重复采集：`,
    "<归档>",
    summary,
    "</归档>",
  ].join("\n")
}

/**
 * 把压缩结果里那条合成提示换成**带 LLM 归档**的版本。
 *
 * 刻意做成纯函数、且不重跑压缩：第二层压缩（先无模型裁剪、仍超限才让模型写归档）
 * 必须等第一层跑完、拿到 `droppedMessages` 才知道该归档什么——
 * 所以顺序只能是「压 → 问模型 → 贴回去」，而不是让 `compactMessages` 自己回调模型。
 *
 * 纯函数的好处是可测：不用真的发一次模型请求就能验证"归档贴对位置了"。
 */
export function withCompactSummary(result: CompactResult, summary: string): CompactResult {
  const s = summary.trim()
  if (!s || !result.droppedTurns) return result
  const idx = result.messages.findIndex(
    (m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith(COMPACT_NOTE),
  )
  // 找不到就**原样返回**：宁可不加归档，也不能凭空插一条孤儿 system 破坏位置假设
  if (idx < 0) return result
  const messages = result.messages.slice()
  messages[idx] = { role: "system", content: compactNote(result.droppedTurns, s) }
  return { ...result, messages }
}

export function compactMessages(messages: Message[], budget: ContextBudget = {}): CompactResult {
  const b = { ...DEFAULTS, ...budget }
  const charsBefore = messages.reduce((n, m) => n + charsOf(m), 0)
  const tokensBefore = messages.reduce((n, m) => n + tokensOf(m), 0)

  // 先剥掉上一次压缩留下的合成提示（[上下文压缩]…）。否则每 step 重压一次就堆一条，
  // 它们会被收进 head 永久保留、既吃预算又重复——所以压缩必须幂等。
  const clean = messages.filter(
    (m) => !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(COMPACT_NOTE)),
  )

  // 前面的 system（提示词）永远保留：丢了它，档位/边界/审批语义就一起没了
  const head: Message[] = []
  let i = 0
  while (i < clean.length && clean[i].role === "system") head.push(clean[i++])
  const rest = clean.slice(i)

  let truncated = 0
  const clipped = rest.map((m) =>
    m.role === "tool" && m.content && m.content.length > b.maxToolChars
      ? (truncated++, { ...m, content: clipText(m.content, b.maxToolChars) })
      : m,
  )

  const turnsAll = toTurns(clipped)
  // 一轮 = 一条 assistant；user 消息也算一轮，保证"问-答"成对
  const turns = turnsAll.filter((t) => t.some((m) => m.role === "assistant" || m.role === "user"))
  const orphanTools = turnsAll.filter((t) => t.every((m) => m.role === "tool")).flat()

  let keep = turns
  let droppedTurns = 0
  const droppedMessages: Message[] = []
  const tokensOfTurns = (ts: Message[][]): number => ts.reduce((n, t) => n + t.reduce((k, m) => k + tokensOf(m), 0), 0)
  const total = (): number => tokensOfTurns(keep) + tokensOfTurns(orphanTools.map((m) => [m])) + head.reduce((n, m) => n + tokensOf(m), 0)

  // 只要还超预算（估算 token）就丢**最前面的一整轮**（含它的工具结果，绝不拆散）
  while (total() > b.maxTokens && keep.length > b.keepLastTurns) {
    droppedMessages.push(...keep[0])
    keep = keep.slice(1)
    droppedTurns += 1
    if (droppedTurns > 500) break // 保险丝，别把正确性问题变成死循环
  }

  const out: Message[] = [...head]
  if (droppedTurns > 0) {
    // 明说"这里少了东西"：静默丢会让模型以为对话本来就这么短
    out.push({ role: "system", content: compactNote(droppedTurns) })
  }
  for (const t of keep) out.push(...t)
  // 落单的 tool 结果（理论上不该有）宁可带上也不留下协议错误
  out.push(...orphanTools)

  return {
    messages: out,
    droppedTurns,
    droppedMessages,
    truncated,
    charsBefore,
    charsAfter: out.reduce((n, m) => n + charsOf(m), 0),
    tokensBefore,
    tokensAfter: out.reduce((n, m) => n + tokensOf(m), 0),
  }
}

/* ---- 上下文用量（TS-065）：界面「上下文用量」面板的数据形状 ---- */

/** 用量面板里的一行（一个分类）。 */
export interface UsagePart {
  id: string
  label: string
  tokens: number
}

/**
 * 一份用量快照。
 *
 * **token 是估算的**（见 `estimateTokens`），窗口来自配置——所以界面要标"估算"，
 * 不能假装这是模型回传的精确 usage。给它的用途只有一个：让用户看见
 * "还能塞多少、被什么吃掉了"，而不是等撞上压缩才知道。
 */
export interface ContextUsage {
  windowTokens: number
  /** 压缩阈值：到这儿就开始丢早期轮次（`windowTokens × 0.8`） */
  thresholdTokens: number
  usedTokens: number
  /** 已用占窗口的百分比（0–100，一位小数） */
  percent: number
  parts: UsagePart[]
}

/** 把已经算好的分类折成一份快照（纯函数：分类由调用方给，这里只汇总）。 */
export function contextUsage(input: { parts: UsagePart[]; windowTokens?: number }): ContextUsage {
  const windowTokens = Math.max(1, input.windowTokens || CONTEXT_WINDOW_TOKENS)
  const parts = (input.parts || []).map((p) => ({ ...p, tokens: Math.max(0, Math.round(p.tokens || 0)) }))
  const usedTokens = parts.reduce((n, p) => n + p.tokens, 0)
  const percent = Math.round((usedTokens / windowTokens) * 1000) / 10
  return { windowTokens, thresholdTokens: Math.floor(windowTokens * THRESHOLD_RATIO), usedTokens, percent, parts }
}
