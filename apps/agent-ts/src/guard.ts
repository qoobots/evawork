// 循环卫生（TS-024）。
//
// 管的是"循环别把自己绕死"：同一个工具同一组参数反复调用、单步耗时过长、
// 以及一个 turn 跑太久 / 长时间没有推进。
//
// 三条都是真实会发生的失败模式：
//   - 模型卡在同一个调用上重试（拿不到结果就再来一次），几十轮下去什么也没推进；
//   - 单步卡住（工具 hang）会拖死整个会话；
//   - 一直在跑却永远跑不完，会把上下文和预算都吃掉。
//
// **不再**按"跑了多少步"收口：步数该是多少由模型按任务复杂度自己定，
// 写死一个上限等于替它猜，且猜错就只能让用户点「继续」补救。

import type { StopReason } from "./types.ts"

export type GuardVerdict =
  | { kind: "ok" }
  | { kind: "warn"; reason: string }
  | { kind: "stop"; reason: string }

/* ---- 预算默认值（TS-066）----------------------------------------------------
   全部可从环境变量覆盖，理由与 `context.ts` 的窗口一致：**进程启动时读一次**，
   所以别做成界面上能实时拖的滑块——那会是假的。 */
function msFromEnv(name: string, fallback: number): number {
  const v = Number(process.env[name] || "")
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** 单个 step 的墙钟上限（模型请求 + 工具执行）。工具自己最长能跑 120s，留足余量。 */
export const DEFAULT_STEP_TIMEOUT_MS = msFromEnv("EVA_TS_STEP_TIMEOUT_MS", 300_000)
/** 一个 turn 的墙钟预算。步数没用完但跑太久也该停——用户不是把电脑借给我们了。 */
export const DEFAULT_DEADLINE_MS = msFromEnv("EVA_TS_TURN_DEADLINE_MS", 900_000)
/** 连续多少步**没有任何工具成功**就判定空转。0 = 不启用。 */
export const DEFAULT_STALL_STEPS = msFromEnv("EVA_TS_STALL_STEPS", 12)

export interface GuardOptions {
  /** 同一工具+同一参数重复多少次开始提醒 */
  repeatWarn?: number
  /** 重复多少次判定为死循环，直接停 */
  repeatStop?: number
  /** 单步超时（毫秒） */
  stepTimeoutMs?: number
}

/* ---- 结构化停止条件（TS-066）------------------------------------------------
   对标前沿：Vercel AI SDK 不把停止条件硬编码成"跑到第几步"，而是泛化成
   一组**可组合谓词**（`stopWhen: [stepCountIs(20), ...]`）。

   为什么要不止一个条件：只看一个维度时，**卡住的任务会一路空转到底**——
    每一步都在跑、每一步都没推进，用户只能干等，最后才知道白等了。
    所以这里同时看**墙钟**和**有没有进展**：
     - 墙钟  —— 防"一直在做但永远做不完"（哪怕每步都有进展）
     - 无进展 —— 防"在原地打转"（工具一直失败/被拒，时间却在走）
   两条都是纯函数：喂一个状态进去，返回停不停 + 为什么，不碰时钟也不碰 IO。

   不再有"步数上限"这一项：跑多少步由模型按任务复杂度自己决定，
   拿步数卡它等于替模型猜答案——重复调用有 `LoopGuard.record` 管，
   跑太久有墙钟管，两步夹起来才是真的失控信号。 */

export interface StopState {
  /** 已跑步数（从 1 开始计的那一步已计入） */
  steps: number
  /** 本轮开始时刻（ms） */
  startedAt: number
  /** 距上一次"有进展"已经过去多少步 */
  stepsSinceProgress: number
  /** 当前时刻（ms）：由调用方传进来，条件才是纯函数、可测 */
  now: number
}

export interface StopVerdict {
  reason: StopReason
  note: string
}

/** 一个停止条件：给状态，返回"该停了 + 为什么"，或 null（继续跑）。 */
export type StopCondition = (s: StopState) => StopVerdict | null

/** 墙钟预算：跑太久就停——该完成的事做不完，也不把用户的电脑借走。 */
export function deadlineIs(ms: number): StopCondition {
  return (s) => {
    const used = s.now - s.startedAt
    return used >= ms
      ? {
          reason: "deadline",
          note: `本轮已运行 ${Math.round(used / 1000)}s，达到时间预算 ${Math.round(ms / 1000)}s——已做的产出都还在，可继续`,
        }
      : null
  }
}

/**
 * 无进展：连续 N 步**没有任何工具成功执行**，再跑下去只是空转。
 *
 * 刻意用"有没有工具成功"而不是"有没有输出"来衡量：模型一直在说话也算有输出，
 * 但那不是进展。反过来，只要每步都真做成了事，就不算打转——不误杀正常长任务。
 */
export function noProgressFor(steps: number): StopCondition {
  return (s) =>
    steps > 0 && s.stepsSinceProgress >= steps
      ? {
          reason: "stalled",
          note: `连续 ${s.stepsSinceProgress} 步没有工具执行成功——像是在原地打转，先停下由你决定`,
        }
      : null
}

/** 按顺序求值，返回**第一个**要求停止的条件（数组顺序即优先级）。 */
export function firstStop(conds: StopCondition[], s: StopState): StopVerdict | null {
  for (const c of conds) {
    const v = c(s)
    if (v) return v
  }
  return null
}

/** 默认的一组停止条件（顺序即优先级：先撞哪个算哪个）。 */
export function defaultStopConditions(o: {
  deadlineMs?: number
  stallSteps?: number
}): StopCondition[] {
  return [deadlineIs(o.deadlineMs ?? DEFAULT_DEADLINE_MS), noProgressFor(o.stallSteps ?? DEFAULT_STALL_STEPS)]
}

interface RepeatKey {
  count: number
}

/**
 * 只做**判定**，不做动作——停不停由 loop 决定。
 *
 * 这样 guard 是可测的纯逻辑：喂一串调用记录进来，断言它给出什么结论，
 * 不用真的跑模型。
 */
export class LoopGuard {
  private repeats = new Map<string, RepeatKey>()
  private opts: Required<GuardOptions>

  constructor(opts: GuardOptions = {}) {
    this.opts = {
      repeatWarn: opts.repeatWarn ?? 3,
      repeatStop: opts.repeatStop ?? 5,
      // TS-066：从 120s 抬到 300s——单步 = 模型请求 + 工具执行，而工具本身
      // （run_command / 持久终端）最长就能跑 120s，120s 会把正常命令误杀
      stepTimeoutMs: opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    }
  }

  get stepTimeoutMs(): number {
    return this.opts.stepTimeoutMs
  }

  /**
   * 记录一次调用并判定。
   *
   * 只看"工具名 + 参数"这个组合：同一个工具换不同参数是正常的（在换着法试），
   * 完全一样的参数反复发才是卡住了。
   */
  record(tool: string, args: Record<string, unknown>): GuardVerdict {
    const key = `${tool}|${stableStringify(args)}`
    const cur = this.repeats.get(key) ?? { count: 0 }
    cur.count += 1
    this.repeats.set(key, cur)

    if (cur.count >= this.opts.repeatStop) {
      return {
        kind: "stop",
        reason: `${tool} 已用完全相同参数调用 ${cur.count} 次，判定为死循环，停止本轮`,
      }
    }
    if (cur.count >= this.opts.repeatWarn) {
      return {
        kind: "warn",
        reason: `${tool} 用相同参数重复调用 ${cur.count} 次——若未取得新信息，请换个做法`,
      }
    }
    return { kind: "ok" }
  }

  reset(): void {
    this.repeats.clear()
  }
}

/** 稳定的参数序列化：键序不影响结果，否则等价参数会被当成不同调用。 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`
}
