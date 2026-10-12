// Agent 接口与默认实现（TS-041）。
//
// 把"跑一轮"从 `loop.ts` 里**抽出一个可替换的 driver 接口**：loop 现在是默认 driver
// （cli / sdk 仍在用），但不再是唯一形态。照 DSH 的做法，agent 对外暴露的是
// `agent/*` **活事件**——调用方订阅的是"它现在在干什么"，而不是轮询某个状态字段。
//
// 少了这一层会怎样：外部只能在 turn 结束后拿到结果，中途既不能插话也不能叫停，
// 于是"用户打断"只能靠杀进程——已跑出来的上下文全部丢掉。

import { runTurn } from "./loop.ts"
import type { StopReason, TurnOptions, TurnResult } from "./loop.ts"
import { newSessionId } from "./session.ts"
import type { InboxMessage, SessionEvent } from "./types.ts"

export type AgentStatus = "idle" | "running" | "stopping" | "done" | "stopped" | "error"

/** `agent/*` 活事件：驱动方订阅这些，就能看见 agent 的实时状态。 */
export type AgentEvent =
  | { type: "agent/status"; status: AgentStatus; note?: string }
  | { type: "agent/step"; step: number }
  | { type: "agent/inbox"; step: number; message: string; source?: "user" | "system" }
  | { type: "agent/request"; step: number; messages: number }
  | { type: "agent/continuation"; step: number; reason: string; tools?: string[] }
  | { type: "agent/turn-stopping"; reason: StopReason; steps: number; note: string }

export interface Agent {
  readonly id: string
  readonly status: AgentStatus
  /** 跑一个目标（一轮 turn）。 */
  run(goal: string): Promise<TurnResult>
  /**
   * 中途插话：消息在**下一个 step 边界**进入对话，不打断正在跑的那一步。
   * `source` 缺省 "user"；系统转发（后台任务通知等）必须显式给 "system"——
   * loop 会据此补"非用户输入"声明（文档 19 P0-4），界面也据此区分渲染。
   */
  inbox(message: string, source?: "user" | "system"): void
  /** 请求停止：协作式，走到当前 step 边界就停（已产出的正文保留）。 */
  stop(reason?: string): void
  /** 订阅活事件，返回取消订阅函数。 */
  on(fn: (e: AgentEvent) => void): () => void
}

export interface AgentOptions {
  /** 除 prompt / signal / inbox / onEvent 之外的 runTurn 参数。 */
  turn: Omit<TurnOptions, "prompt" | "signal" | "inbox" | "onEvent">
  id?: string
  onEvent?: (e: SessionEvent) => void
}

export class DefaultAgent implements Agent {
  readonly id: string
  private listeners = new Set<(e: AgentEvent) => void>()
  private queue: InboxMessage[] = []
  private controller = new AbortController()
  private st: AgentStatus = "idle"
  private opts: AgentOptions
  private outerEvent?: (e: SessionEvent) => void

  constructor(opts: AgentOptions) {
    this.opts = opts
    this.id = opts.id || newSessionId()
  }

  get status(): AgentStatus {
    return this.st
  }

  on(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  inbox(message: string, source: "user" | "system" = "user"): void {
    const m = String(message || "").trim()
    if (m) this.queue.push({ message: m, source })
  }

  stop(_reason?: string): void {
    if (this.st !== "running") return
    this.setStatus("stopping")
    // 协作式：只置 abort，等 loop 走到 step 边界自己停下（不杀进程、不丢已产出的正文）
    this.controller.abort()
  }

  async run(goal: string): Promise<TurnResult> {
    this.setStatus("running")
    try {
      const res = await runTurn({
        ...this.opts.turn,
        prompt: goal,
        signal: this.controller.signal,
        // 每个 step 边界取一次：queue 取完即清空，同一句话不会被注入两遍
        inbox: () => {
          const q = this.queue
          this.queue = []
          return q
        },
        onEvent: (e: SessionEvent) => {
          this.opts.onEvent?.(e)
          this.forward(e)
        },
      })
      this.setStatus(res.stopReason === "completed" ? "done" : "stopped", res.note)
      return res
    } catch (err) {
      this.setStatus("error", (err as Error).message || String(err))
      throw err
    }
  }

  /** 只把 `agent/*` 事件转给订阅者；其它事件（tool/call 等）走原始 onEvent。 */
  private forward(e: SessionEvent): void {
    if (!e.type.startsWith("agent/")) return
    const ev = e as unknown as AgentEvent
    // status 事件由本类统一发出（含 idle→running 这种 loop 看不到的转换），
    // 这里避免重复发一遍 running
    if (ev.type === "agent/status" && ev.status === "running") return
    this.dispatch(ev)
  }

  private setStatus(status: AgentStatus, note?: string): void {
    this.st = status
    this.dispatch({ type: "agent/status", status, note })
  }

  private dispatch(e: AgentEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e)
      } catch {
        /* 订阅者出错不能影响 agent 本身 */
      }
    }
  }
}

/** 便捷构造。 */
export function createAgent(opts: AgentOptions): DefaultAgent {
  return new DefaultAgent(opts)
}
