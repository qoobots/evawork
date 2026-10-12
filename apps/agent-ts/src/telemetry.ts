// 遥测（TS-053）：关键指标可观测。
//
// 要解决的问题很具体：agent 跑得"看着还行"，但**没有任何数字**——
// 一轮几步、哪类工具最慢、被拒了多少次、上下文压了几次，全靠猜。
// 排查时第一句永远是"最近是不是变慢了"，答不上来就只能靠体感。
//
// 三条边界：
//   1. **只记数字与名字，不记内容**：不落 prompt、不落工具参数、不落文件正文。
//      遥测最容易越界成"顺手把上下文也存了"，那它就变成了第二个、没人管的日志。
//   2. **绝不因为遥测失败而中断任务**：写盘失败就静默跳过（try/catch 包住所有 IO）。
//   3. **可以关**：`EVA_TS_TELEMETRY=0` 或启动清单 `modules.telemetry: false`。

import fs from "node:fs"
import path from "node:path"
import { homeDir } from "./session.ts"

export interface MetricSample {
  ts: number
  name: string
  /** 计数（默认 1） */
  n?: number
  /** 耗时毫秒 */
  ms?: number
  ok?: boolean
  tool?: string
  reason?: string
}

export interface MetricSummary {
  name: string
  count: number
  totalMs: number
  maxMs: number
  failures: number
}

function enabled(): boolean {
  const v = (process.env.EVA_TS_TELEMETRY || "").trim().toLowerCase()
  return v !== "0" && v !== "off" && v !== "false"
}

export class Telemetry {
  private file: string | null = null
  private counters = new Map<string, MetricSummary>()
  private on = enabled()

  constructor(file?: string) {
    this.file = file ?? null
  }

  /** 关掉：什么都不记，也不落盘。 */
  disable(): void {
    this.on = false
  }

  private path(): string {
    if (!this.file) this.file = path.join(homeDir(), "metrics.jsonl")
    return this.file
  }

  private write(s: MetricSample): void {
    if (!this.on) return
    const cur = this.counters.get(s.name) || { name: s.name, count: 0, totalMs: 0, maxMs: 0, failures: 0 }
    cur.count += s.n ?? 1
    if (typeof s.ms === "number") {
      cur.totalMs += s.ms
      cur.maxMs = Math.max(cur.maxMs, s.ms)
    }
    if (s.ok === false) cur.failures += 1
    this.counters.set(s.name, cur)
    // 落盘失败就算了：遥测不能反过来把任务搞挂
    try {
      fs.mkdirSync(path.dirname(this.path()), { recursive: true })
      fs.appendFileSync(this.path(), JSON.stringify(s) + "\n", "utf8")
    } catch {
      /* 忽略 */
    }
  }

  /** 记一次计数。 */
  count(name: string, n = 1, extra: Partial<MetricSample> = {}): void {
    this.write({ ts: Date.now(), name, n, ...extra })
  }

  /** 记一次耗时：调用方 `const stop = t.time('x'); …; stop()`。 */
  time(name: string, extra: Partial<MetricSample> = {}): () => void {
    const t0 = Date.now()
    return () => this.write({ ts: Date.now(), name, ms: Date.now() - t0, ...extra })
  }

  snapshot(): MetricSummary[] {
    return [...this.counters.values()].sort((a, b) => b.count - a.count)
  }

  reset(): void {
    this.counters.clear()
  }
}

/** 进程内共享；关掉用 `telemetry.disable()` 或环境变量。 */
export const telemetry = new Telemetry()

/** 给人看的一张表。 */
export function renderMetrics(list: MetricSummary[] = telemetry.snapshot()): string {
  if (!list.length) return "（没有指标）"
  const rows = list.map((m) => {
    const avg = m.count ? Math.round(m.totalMs / m.count) : 0
    const ms = m.totalMs ? ` 平均 ${avg}ms 最大 ${m.maxMs}ms` : ""
    const bad = m.failures ? ` 失败 ${m.failures}` : ""
    return `${m.name}: ${m.count} 次${ms}${bad}`
  })
  return rows.join("\n")
}
