// 循环卫生（TS-024）。
//
// 管的是"循环别把自己绕死"：同一个工具同一组参数反复调用——
// 拿不到结果就原样再来一次，几十轮下去什么也没推进，这才是真的绕不出来。
//
// **不再**按"跑了多少步 / 单步跑了多久 / 整轮跑了多久"收口：步数与快慢由模型
// 按任务复杂度自己定，写死上限等于替它猜，且猜错就只能让用户点「继续」补救。

export type GuardVerdict =
  | { kind: "ok" }
  | { kind: "warn"; reason: string }
  | { kind: "stop"; reason: string }

/* ---- 不再有墙钟/无进展停止条件 --------------------------------------------
   以前这里有一组"可组合谓词"：`deadlineIs`（整轮墙钟 15min）与
   `noProgressFor`（连续 12 步没有工具成功）。实测两者都是**替模型猜**：
     · 墙钟——长任务（子代理、长文档生成）跑满 15min 很正常，撞线时它没坏，
       只是被截停，用户还得点「继续」；"跑多久"由任务定，不该由常量定。
     · 无进展——"有没有工具成功"是个错口径：读文件、搜索、列表这些做成不算成功调用？
       算；但一大段任务里连续十几步都能被判成空转，于是又被截停一次。
   判"在原地打转"只留一条硬证据：**同一工具 + 完全相同参数**反复调用
   （下面 `LoopGuard.record`），那才是真的绕不出来。其余交给用户点停止。 */

export interface GuardOptions {
  /** 同一工具+同一参数重复多少次开始提醒 */
  repeatWarn?: number
  /** 重复多少次判定为死循环，直接停 */
  repeatStop?: number
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
    }
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
