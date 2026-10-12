// 会话查询：浏览 / 搜索 / 导出（TS-051）。
//
// 事件日志保证了"事实都在"，但没有查询就等于**存了看不见的东西**：
// 出问题时第一句话永远是"刚才那轮到底发生了什么"，答不上来就是白记。
//
// 刻意的取舍：
//   1. **坏行跳过，不整份报废**：写着写着崩了的行会留下半条 JSON，
//      能救多少救多少——日志是事实，少一条也比全没了强（与 session.ts 同源策略）。
//   2. **摘要要读全文**，规模不大（本地桌面、单用户），简单直接；
//      哪天真的变慢了再上索引，现在加索引只是把复杂度提前。
//   3. 导出三种格式：jsonl（原文，可回放）、json（给程序）、md（给人看）。

import fs from "node:fs"
import path from "node:path"
import { SessionLog, homeDir } from "./session.ts"
import type { SessionEvent } from "./types.ts"

export interface SessionSummary {
  id: string
  file: string
  events: number
  bytes: number
  firstTs: number | null
  lastTs: number | null
  /** 首个 turn 的目标 */
  goal: string
  /** 最近一次 turn 的结束原因 */
  stop: string
  steps: number
  /** 会话标题：改过名就是改名后的，否则取首个 turn 的目标（截断） */
  title: string
  /** 父任务 id（根任务为 null）。来自 `session/meta`，旧会话按文件名 `-sub-<n>` 兜底 */
  parentId: string | null
  /** 层级种类：root / subtask / job（见 `SessionKind`） */
  kind: "root" | "subtask" | "job"
  /** 直接子任务数（仅根任务非零，用于侧栏聚合展示） */
  childCount: number
}

/** 会话 id 只许这些字符——它会被拼进文件路径，不校验就是路径穿越。 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(String(id || ""))
}

export interface SearchHit {
  id: string
  seq: number
  ts: number
  type: string
  /** 命中处的一段上下文，便于人一眼看懂 */
  snippet: string
}

export type ExportFormat = "jsonl" | "json" | "md"

export function sessionsDir(): string {
  const d = path.join(homeDir(), "sessions")
  fs.mkdirSync(d, { recursive: true })
  return d
}

function readEvents(file: string): SessionEvent[] {
  let text = ""
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return []
  }
  const out: SessionEvent[] = []
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as SessionEvent)
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

function summarize(id: string, file: string): SessionSummary {
  const events = readEvents(file)
  let bytes = 0
  try {
    bytes = fs.statSync(file).size
  } catch {
    bytes = 0
  }
  const tsList = events.map((e) => Number(e.ts) || 0).filter((n) => n > 0)
  const first = events.find((e) => e.type === "turn/start")
  const lastEnd = [...events].reverse().find((e) => e.type === "turn/end")
  const goal = first ? String(first.prompt ?? "") : ""
  /* 标题取**最后一条**改名记录：改名是"现在该叫什么"，不是"曾经叫过什么"。
     没改过名就用首个目标的第一行——侧栏要的是一眼能认出来的短句。 */
  const renamed = [...events].reverse().find((e) => e.type === "session/renamed")
  const title = renamed ? String(renamed.title ?? "") : goal.split("\n")[0]
  // 层级关系：优先读 `session/meta` 首行；旧会话没有则按文件名 `-sub-<n>` 兜底
  const meta = events.find((e) => e.type === "session/meta") as
    | { parentId?: string | null; kind?: string }
    | undefined
  let parentId: string | null = meta ? (meta.parentId ?? null) : null
  let kind: "root" | "subtask" | "job" = meta ? ((meta.kind as string) === "job" ? "job" : (meta.kind as string) === "subtask" ? "subtask" : "root") : "root"
  if (!parentId && /-sub-\d+$/.test(id)) {
    parentId = id.replace(/-sub-\d+$/, "")
    kind = "subtask"
  }
  return {
    id,
    file,
    events: events.length,
    bytes,
    firstTs: tsList.length ? Math.min(...tsList) : null,
    lastTs: tsList.length ? Math.max(...tsList) : null,
    goal,
    stop: lastEnd ? String(lastEnd.stop ?? "") : "",
    steps: lastEnd ? Number(lastEnd.steps ?? 0) : 0,
    title,
    parentId,
    kind,
    childCount: 0,
  }
}

/**
 * 给会话改名。**改名本身也是一条事件**，不另开 meta 文件：
 * 事件日志是 append-only 的真相源，标题属于"这个会话发生过什么"，
 * 重开、回放、导出之后都还认得（这和 rewind 记在日志里是同一个道理）。
 */
export function renameSession(id: string, title: string): boolean {
  if (!isSafeId(id)) return false
  const file = path.join(sessionsDir(), `${id}.jsonl`)
  if (!fs.existsSync(file)) return false
  fs.appendFileSync(file, `${JSON.stringify({ type: "session/renamed", title: String(title || ""), ts: Date.now() })}\n`)
  return true
}

/** 删掉一个会话（连同它的事件日志）。正在跑的会话由调用方先停。 */
export function deleteSession(id: string): boolean {
  if (!isSafeId(id)) return false
  const file = path.join(sessionsDir(), `${id}.jsonl`)
  try {
    fs.unlinkSync(file)
    return true
  } catch (e) {
    // 已经不在了 = 目的达成，幂等返回成功（否则删过的会话永远报"删不掉"）
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return true
    return false // 被占用等：如实告诉调用方没删成
  }
}

/** 列出全部会话（按最后一次事件时间倒序，最近用的在最前）。 */
export function listSessions(): SessionSummary[] {
  const dir = sessionsDir()
  let names: string[] = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"))
  } catch {
    return []
  }
  const all = names.map((n) => summarize(n.replace(/\.jsonl$/, ""), path.join(dir, n)))
  // 统计每个父任务的子任务数（侧栏聚合展示用）
  const childOf = new Map<string, number>()
  for (const s of all) {
    if (s.parentId) childOf.set(s.parentId, (childOf.get(s.parentId) || 0) + 1)
  }
  for (const s of all) s.childCount = childOf.get(s.id) || 0
  return all.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
}

export function sessionEvents(id: string): SessionEvent[] {
  return new SessionLog(id).events()
}

/** 全文搜索（大小写不敏感）。命中按会话内 seq 排序返回。 */
export function searchSessions(term: string, opts: { limit?: number; sessionId?: string } = {}): SearchHit[] {
  const q = String(term || "").trim().toLowerCase()
  if (!q) return []
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 500)
  const ids = opts.sessionId ? [opts.sessionId] : listSessions().map((s) => s.id)
  const hits: SearchHit[] = []
  for (const id of ids) {
    for (const e of sessionEvents(id)) {
      const text = JSON.stringify(e)
      const at = text.toLowerCase().indexOf(q)
      if (at < 0) continue
      hits.push({
        id,
        seq: Number(e.seq) || 0,
        ts: Number(e.ts) || 0,
        type: String(e.type || ""),
        snippet: text.slice(Math.max(0, at - 60), at + q.length + 120),
      })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}

/** 把事件流渲染成人能读的纪要。 */
export function renderMarkdown(id: string, events: SessionEvent[]): string {
  const lines: string[] = [`# 会话 ${id}`, ""]
  if (!events.length) lines.push("（没有事件）")
  for (const e of events) {
    const t = new Date(Number(e.ts) || Date.now()).toISOString()
    switch (e.type) {
      case "turn/start":
        lines.push(`## turn/start — ${t}`, "", `目标：${String(e.prompt ?? "")}`, "")
        break
      case "assistant/message":
        if (e.text) lines.push(`**模型**：${String(e.text)}`, "")
        break
      case "tool/call":
        lines.push(
          `- 工具 ${String(e.tool ?? "")} ${e.allowed === false ? `（拒绝：${String(e.reason ?? "")}）` : "（放行）"}`,
        )
        break
      case "tool/result": {
        const body = String(e.content ?? "").replace(/\s+/g, " ").slice(0, 300)
        lines.push(`  - 结果 ${e.ok ? "ok" : "失败"}：${body}`)
        break
      }
      case "plan/update": {
        const s = e.state as { goal?: string; items?: { content: string; status: string }[] } | undefined
        if (s?.goal) lines.push(`- 目标更新：${s.goal}`)
        for (const it of s?.items || []) lines.push(`  - [${it.status}] ${it.content}`)
        break
      }
      case "context/compact":
        lines.push(`- 上下文压缩：丢 ${String(e.droppedTurns ?? 0)} 轮，截断 ${String(e.truncated ?? 0)} 条`)
        break
      case "subagent/result":
        lines.push(`- 子代理 ${String(e.session ?? "")}：${String(e.stop ?? "")}，${String(e.steps ?? "")} 步`)
        break
      case "turn/end":
        lines.push("", `## turn/end — ${String(e.stop ?? "")}（${String(e.steps ?? 0)} 步）`, "")
        break
      default:
        // 未知事件也留个痕：以后加了新事件类型，纪要里至少能看到它发生过
        lines.push(`- ${String(e.type)}`)
    }
  }
  return lines.join("\n")
}

/** 导出：jsonl（原文可回放）/ json（给程序）/ md（给人看）。 */
export function exportSession(id: string, format: ExportFormat = "md"): string {
  const file = new SessionLog(id).file
  if (format === "jsonl") {
    try {
      return fs.readFileSync(file, "utf8")
    } catch {
      return ""
    }
  }
  const events = sessionEvents(id)
  if (format === "json") return JSON.stringify(events, null, 2)
  return renderMarkdown(id, events)
}
