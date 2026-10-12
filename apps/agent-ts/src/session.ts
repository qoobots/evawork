// 会话持久化：**append-only 事件日志**（JSONL）。
//
// 为什么用事件日志而不是一张可变状态表：
// 1. 事实只追加——不覆盖历史，"这一轮到底发生了什么"可以原样重放出来核对；
// 2. 多进程安全得多。Python 版 evawork 的主库是"单连接 + 一把 RLock"，
//    它自己的注释就写着 `check_same_thread=False` 只是关掉线程检查、不保证并发安全，
//    实测咬过人（并发读配置时有的读到真工作区、有的读到默认空目录）。
//    两套智能体并存时不能共用那种存储，所以 TS 侧走 JSONL + 独占目录锁。
//
// 存储位置与 evawork **完全分开**（`~/.evawork/ts-agent/`），不碰 evawork.db。

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import type { SessionEvent, SessionKind } from "./types.ts"

/** TS agent 的数据根。可被 EVA_TS_HOME 覆盖（测试/隔离用）。 */
export function homeDir(): string {
  const env = (process.env.EVA_TS_HOME || "").trim()
  return env || path.join(os.homedir(), ".evawork", "ts-agent")
}

function sessionDir(): string {
  const d = path.join(homeDir(), "sessions")
  fs.mkdirSync(d, { recursive: true })
  return d
}

/** 同步休眠（零依赖：不引 sleep 包）。 */
function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buf), 0, 0, ms)
}

/**
 * 独占目录锁。
 *
 * 用 `mkdir` 而不是 `.lock` 文件：创建目录在 Windows 与 POSIX 上都是**独占**的，
 * 而 `open 'wx'` 在某些网络盘/杀软下行为不一致。锁遗留（进程崩了没删）按
 * STALE_MS 兜底清除——否则一次崩溃会让整个会话永久写不进去。
 */
const STALE_MS = 15_000

/**
 * 锁**按会话隔离**（`key` 通常是会话 id）。
 *
 * 一开始整个 sessions 目录共用一把 `.lock`，后果比想象中严重：任何两个并发会话互相
 * 阻塞，只要有一个会话卡在锁里没释放（进程被杀、异常退出），**其它所有会话一起写不进去**
 * ——表现出来是"新建的会话莫名写不了日志"。日志是唯一的真相源，它一停，什么都查不了。
 */
function withLock<T>(dir: string, fn: () => T, key = "global"): T {
  const lockFile = path.join(dir, `.${key}.lock`)
  // 等待上限必须 **大于** STALE_MS，否则会出现"锁还在、但还没到陈旧阈值"的窗口：
  // 等 5s 就放弃，而锁要到 15s 才被判定为陈旧——明明再等一会儿就能清掉的遗留锁，
  // 直接把这一次写入判死（实测撞到过：会话锁等待超时）。
  const deadline = Date.now() + STALE_MS + 5000
  const stamp = (pid: number, ts: number) => JSON.stringify({ pid, ts })

  for (;;) {
    try {
      // 独占创建即拿到锁
      const fd = fs.openSync(lockFile, "wx")
      fs.writeSync(fd, stamp(process.pid, Date.now()))
      fs.closeSync(fd)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err

      // 已存在：看它是不是陈旧（或已被正常释放）
      let stale = false
      try {
        const s = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { ts?: number }
        if (!s.ts || Date.now() - s.ts > STALE_MS) stale = true
      } catch {
        stale = true
      }
      if (stale) {
        // 覆盖接管。**不删除**——见下面的说明
        try {
          fs.writeFileSync(lockFile, stamp(process.pid, Date.now()))
          break
        } catch { /* 抢不到，下一轮再试 */ }
      }
      if (Date.now() > deadline) {
        throw new Error(`会话锁等待超时：${lockFile}（陈旧阈值 ${Math.round(STALE_MS / 1000)}s）`)
      }
      sleepSync(20)
    }
  }
  try {
    return fn()
  } finally {
    /* 释放 = 把时间戳清零，**不删文件**。
       本机有删除保护（实测 `fs.rmSync` / `fs.unlinkSync` 会被
       `[safe-delete][SAFE_DELETE_BULK_GUARD_ERROR]` 拦下），依赖"删锁文件"的实现在
       这里会**永久遗留锁**：第一次拿到锁、删不掉，之后每一次写入都等到超时。
       改成写标记后，`ts=0` 会被下一个等待者立刻判定为已释放。 */
    try { fs.writeFileSync(lockFile, stamp(0, 0)) } catch { /* 释放失败不影响本次结果 */ }
  }
}

/**
 * 一次会话的事件日志。
 *
 * `seq` 单调递增、发出即不回收（编号稳定，引用它才不会指错）。
 */
/**
 * 新建会话时写入的元信息（决定层级关系，见 `SessionMetaEvent`）。
 * 只在文件**尚不存在**时落盘——已有会话（续跑/回放）不重写，避免覆盖历史。
 */
export interface SessionMetaInput {
  parentId?: string | null
  kind?: SessionKind
  goal?: string
  workDir?: string
  model?: string
}

export class SessionLog {
  readonly file: string
  readonly id: string
  private seq = 0

  // 不用参数属性（`constructor(readonly id: string)`）：
  // Node 的 strip-only 模式只**删除**类型、不做代码转换，参数属性需要生成赋值语句，
  // 因此不被支持（ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）。老老实实在构造体里赋值。
  constructor(id: string, meta?: SessionMetaInput) {
    this.id = id
    this.file = path.join(sessionDir(), `${id}.jsonl`)
    // 新建会话：把层级关系作为首行落盘（`24` 号方案 G1）。
    // 仅当文件不存在时写——续跑/重开不重写；旧会话没有这一行，列表查询按文件名兜底。
    if (meta && !fs.existsSync(this.file)) {
      this.append({
        type: "session/meta",
        id,
        parentId: meta.parentId ?? null,
        kind: meta.kind ?? "root",
        goal: meta.goal ?? "",
        workDir: meta.workDir ?? "",
        model: meta.model ?? "",
        createdAt: Date.now(),
      })
    }
    // 续跑/重开：从已有日志把 seq 接上，否则新事件会和旧事件撞号
    for (const e of this.events()) this.seq = Math.max(this.seq, Number(e.seq) || 0)
  }

  append(ev: Omit<SessionEvent, "seq" | "ts">): SessionEvent {
    const dir = path.dirname(this.file)
    const full: SessionEvent = { ...ev, seq: ++this.seq, ts: Date.now() }
    withLock(
      dir,
      () => {
        fs.appendFileSync(this.file, JSON.stringify(full) + "\n", "utf8")
      },
      this.id,
    )
    return full
  }

  events(): SessionEvent[] {
    if (!fs.existsSync(this.file)) return []
    // 坏行（写到一半崩了）跳过而不是整份报废：日志是事实，能救多少救多少
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as SessionEvent]
        } catch {
          return []
        }
      })
  }
}

/** 生成会话 id（与 evawork 的 task-<hex> 风格一致，加 ts 前缀区分来源）。 */
export function newSessionId(): string {
  return `ts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 子会话命名：`<parentId>-sub-<n>`。
 *
 * `n` 取目录内**同父**已存在的最大序号 +1，而不是模块级 `let seq`——
 * 后者在子进程重启后会归零，容易与旧子会话重名、互相覆盖。
 * 命名与旧逻辑保持一致，因此无 `session/meta` 的旧子会话也能被列表查询正确归并到父任务。
 */
export function nextSubId(parentId: string): string {
  const dir = sessionDir()
  const prefix = `${parentId}-sub-`
  let max = 0
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.startsWith(prefix) || !n.endsWith(".jsonl")) continue
      const m = n.slice(prefix.length, -".jsonl".length).match(/^\d+$/)
      if (m) max = Math.max(max, Number(m[0]))
    }
  } catch {
    // 目录还没建（首次写）无所谓，max 保持 0
  }
  return `${prefix}${max + 1}`
}

/* ---------- TS-063 撤销对话（rewind）---------- */

/**
 * 会话当前的回退点（seq）：0 = 没退过。
 *
 * **为什么记在事件日志里而不是内存/配置**：回退是"这个会话走到了哪"的事实，
 * 和"它说过什么"是同一类东西。存进日志，重开、回放、子进程重启之后都还认得。
 */
export function rewindPoint(log: SessionLog): number {
  let to = 0
  for (const e of log.events()) {
    if (e.type === "session/rewound") to = Number(e.toSeq) || 0
  }
  return to
}

/** 第 n 轮（1 起）那一轮的起始 seq；超出轮数返回 0（调用方据此说"没有这一轮"）。 */
export function turnStartSeq(log: SessionLog, turn: number): number {
  let n = 0
  for (const e of log.events()) {
    if (e.type !== "turn/start") continue
    n += 1
    if (n === turn) return Number(e.seq) || 0
  }
  return 0
}

/** 会话一共多少轮（界面给"回到第几轮"用）。 */
export function turnCount(log: SessionLog): number {
  let n = 0
  for (const e of log.events()) if (e.type === "turn/start") n += 1
  return n
}

/**
 * 记一次回退。**只记事实，不删事件**——日志是 append-only 的，
 * 退掉的那些轮次仍然留在文件里（可查、可导出），只是不再进入后续上下文。
 */
export function recordRewind(log: SessionLog, toSeq: number, toTurn: number): SessionEvent {
  return log.append({ type: "session/rewound", toSeq, toTurn } as Omit<SessionEvent, "seq" | "ts">)
}
