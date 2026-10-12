// 后台任务（TS-044）。
//
// 干什么用：把"跑很久的那件事"挪出主循环——构建、全量测试、装依赖这类活，
// 模型没必要干等着。发起后立刻拿到 id，继续干别的，回头再 `job_status` 看结果。
//
// 三条刻意的边界：
//   1. **返回的是句柄不是结果**：发起即返回，`wait` 才阻塞。把两者混在一起，
//      "后台任务"就退化成"同步任务"，模型还是会干等。
//   2. **取消不能保证立刻生效**：能 kill 直接子进程（`kill` 不杀孙进程，进程树可能残留）；
//      通用 promise 任务更是只能标记状态、丢弃后来的结果。如实写进 status，不假装停干净了。
//   3. **输出照样截断**：后台跑不代表可以无限涨内存，上限与工具输出一致（2 万字符）。

import { spawn } from "node:child_process"
import { defineTool } from "./tools.ts"
import type { ToolResult } from "./types.ts"

export type JobStatus = "running" | "done" | "failed" | "cancelled"

export interface JobInfo {
  id: string
  /** 任务种类，如 `command` */
  kind: string
  status: JobStatus
  startedAt: number
  endedAt?: number
  output?: string
  error?: string
  exitCode?: number
}

const MAX_OUTPUT = 20_000
const KEEP_JOBS = 50

const truncate = (s: string): string => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（已截断，共 ${s.length} 字符）` : s)

export class JobRegistry {
  private jobs: JobInfo[] = []
  private procs = new Map<string, ReturnType<typeof spawn>>()
  private seq = 0

  private alloc(kind: string): JobInfo {
    const info: JobInfo = { id: `j${++this.seq}`, kind, status: "running", startedAt: Date.now() }
    this.jobs.push(info)
    this.prune()
    return info
  }

  /** 发起一个任务：**立刻返回句柄**，不等它跑完。 */
  start(kind: string, runner: () => Promise<{ output?: string; error?: string; exitCode?: number }>): JobInfo {
    const info = this.alloc(kind)
    void runner()
      .then((r) => {
        // 期间被取消了：后来的结果丢弃，状态保持 cancelled
        if (info.status === "cancelled") return
        info.status = r.error ? "failed" : "done"
        info.output = r.output ? truncate(r.output) : undefined
        info.error = r.error ? truncate(r.error) : undefined
        info.exitCode = r.exitCode
        info.endedAt = Date.now()
      })
      .catch((err) => {
        if (info.status === "cancelled") return
        info.status = "failed"
        info.error = truncate(String((err as Error).message || err))
        info.endedAt = Date.now()
      })
      .finally(() => {
        this.procs.delete(info.id)
        this.prune()
      })
    return { ...info }
  }

  /** 后台跑一条命令（与 run_command 同一套沙箱/时限约束）。 */
  startCommand(command: string, cwd: string, timeoutMs = 120_000): JobInfo {
    const cmd = String(command || "").trim()
    if (!cmd) throw new Error("命令为空")
    const ms = Math.min(Math.max(Number(timeoutMs) || 120_000, 1000), 600_000)
    // 先拿 id（句柄）再发起：没有句柄就没法取消
    const info = this.alloc("command")

    let child: ReturnType<typeof spawn>
    try {
      const isWin = process.platform === "win32"
      child = spawn(isWin ? "cmd.exe" : "/bin/sh", isWin ? ["/c", cmd] : ["-c", cmd], { cwd })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const msg =
        code === "ERR_ACCESS_DENIED"
          ? "当前为 hardened 档：不允许启动子进程（后台命令已禁用）"
          : `启动失败：${String(err)}`
      this.fail(info.id, msg)
      return this.get(info.id) as JobInfo
    }
    this.procs.set(info.id, child)

    let out = ""
    let err = ""
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try { child.kill("SIGKILL") } catch { /* 已退出 */ }
    }, ms)
    child.stdout?.on("data", (d) => { out += String(d) })
    child.stderr?.on("data", (d) => { err += String(d) })
    child.on("error", (e) => {
      clearTimeout(timer)
      this.finish(info.id, "", `启动失败：${e.message}`, undefined)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const body = [out, err].filter(Boolean).join("\n")
      if (killed) {
        this.finish(info.id, body, `超时（>${ms}ms）。已杀死直接子进程，进程树可能仍有残留。`, code ?? undefined)
        return
      }
      if (code === 0) {
        this.finish(info.id, body || "（成功，无输出）", "", 0)
        return
      }
      this.finish(info.id, body, `退出码 ${code}`, code ?? undefined)
    })

    return this.get(info.id) as JobInfo
  }

  get(id: string): JobInfo | undefined {
    const j = this.jobs.find((x) => x.id === id)
    return j ? { ...j } : undefined
  }

  list(): JobInfo[] {
    return this.jobs.map((j) => ({ ...j }))
  }

  /** 等到结束（或超时）。超时**照实返回 running**，不假装已经结束。 */
  async wait(id: string, timeoutMs = 30_000): Promise<JobInfo | undefined> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 600_000)
    for (;;) {
      const j = this.get(id)
      if (!j || j.status !== "running") return j
      if (Date.now() >= deadline) return j
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /**
   * 取消。能 kill 的只有直接子进程——孙进程可能残留；通用任务更是只能标记状态。
   * 返回值说明"有没有找到这个任务"，**不代表一定停干净了**。
   */
  cancel(id: string): boolean {
    const j = this.jobs.find((x) => x.id === id)
    if (!j) return false
    if (j.status === "running") {
      j.status = "cancelled"
      j.endedAt = Date.now()
      j.error = "已取消（只保证 kill 直接子进程，进程树可能仍有残留）"
      const p = this.procs.get(id)
      if (p) {
        try { p.kill("SIGKILL") } catch { /* 已退出 */ }
        this.procs.delete(id)
      }
    }
    return true
  }

  private finish(id: string, output: string, error: string, exitCode?: number): void {
    const j = this.jobs.find((x) => x.id === id)
    if (!j || j.status !== "running") return
    j.status = error ? "failed" : "done"
    j.output = output ? truncate(output) : undefined
    j.error = error ? truncate(error) : undefined
    j.exitCode = exitCode
    j.endedAt = Date.now()
    this.prune()
  }

  private fail(id: string, error: string): void {
    this.finish(id, "", error, undefined)
  }

  /** 只留最近 KEEP_JOBS 条：后台任务列表本身也会涨，但没必要无限留。 */
  private prune(): void {
    if (this.jobs.length <= KEEP_JOBS) return
    const running = this.jobs.filter((j) => j.status === "running")
    const done = this.jobs.filter((j) => j.status !== "running")
    this.jobs = [...running, ...done.slice(-KEEP_JOBS)]
  }
}

/** 进程内共享一个注册表：工具与调用方看到的是同一批任务。 */
export const jobs = new JobRegistry()

/** 给模型看的一行摘要。 */
export function jobLine(j: JobInfo): string {
  const ms = j.endedAt ? ` ${((j.endedAt - j.startedAt) / 1000).toFixed(1)}s` : ""
  const head = `${j.id} [${j.status}] ${j.kind}${ms}`
  if (j.status === "done") return `${head}\n${j.output || "（无输出）"}`
  if (j.status === "failed") return `${head}\n失败：${j.error || "（无原因）"}`
  if (j.status === "cancelled") return `${head}\n${j.error || ""}`
  return `${head}（仍在跑）`
}

/** 把后台任务注册成工具。 */
export function registerJobTools(): void {
  defineTool({
    name: "job_start",
    description:
      "把一条命令放到**后台**跑（构建/测试这类慢活用）：立刻返回任务 id，不要干等。用 job_status 看结果。需要确认。",
    parameters: [
      { name: "command", type: "string", required: true, desc: "要执行的命令" },
      { name: "timeout_ms", type: "number", required: false, desc: "超时毫秒，默认 120000" },
    ],
    action: "command",
    execute(args, ctx): ToolResult {
      const cmd = String(args.command || "").trim()
      if (!cmd) return { ok: false, error: "命令为空" }
      try {
        const j = jobs.startCommand(cmd, ctx.workspace, Number(args.timeout_ms) || 120_000)
        // 只回 id：回结果就变成同步调用，模型还是会等
        return { ok: true, output: `已发起后台任务 ${j.id}（${j.kind}）。用 job_status 查看，job_cancel 取消。` }
      } catch (err) {
        return { ok: false, error: String((err as Error).message || err) }
      }
    },
  })

  defineTool({
    name: "job_status",
    description: "看后台任务的状态与输出。传 id 看一个；不传就列全部（含仍在跑的）。",
    parameters: [{ name: "id", type: "string", required: false, desc: "任务 id，不填=列出全部" }],
    action: "read",
    async execute(args): Promise<ToolResult> {
      const id = String(args.id || "").trim()
      if (!id) {
        const all = jobs.list()
        if (!all.length) return { ok: true, output: "（没有后台任务）" }
        return { ok: true, output: all.map((j) => `${j.id} [${j.status}] ${j.kind}`).join("\n") }
      }
      const j = await jobs.wait(id, 0)
      if (!j) return { ok: false, error: `没有这个任务：${id}（用过：${jobs.list().map((x) => x.id).join(", ") || "无"}）` }
      return { ok: true, output: jobLine(j) }
    },
  })

  defineTool({
    name: "job_wait",
    description: "等一个后台任务结束（最多等 timeout_ms）。超时就照实说还在跑，不假装结束。",
    parameters: [
      { name: "id", type: "string", required: true, desc: "任务 id" },
      { name: "timeout_ms", type: "number", required: false, desc: "最多等多久，默认 30000" },
    ],
    action: "read",
    async execute(args): Promise<ToolResult> {
      const j = await jobs.wait(String(args.id || ""), Number(args.timeout_ms) || 30_000)
      if (!j) return { ok: false, error: `没有这个任务：${String(args.id || "")}` }
      // 还在跑不是失败：如实返回，让模型决定继续等还是先干别的
      return { ok: j.status !== "failed", output: jobLine(j) }
    },
  })

  defineTool({
    name: "job_cancel",
    description: "取消一个后台任务。只保证 kill 直接子进程，进程树可能仍有残留。",
    parameters: [{ name: "id", type: "string", required: true, desc: "任务 id" }],
    // 改的是 agent 自己的状态，不碰用户工作区 → 按 memory_write（非高危）
    action: "memory_write",
    execute(args): ToolResult {
      const id = String(args.id || "").trim()
      const ok = jobs.cancel(id)
      return ok
        ? { ok: true, output: `已请求取消 ${id}（不保证进程树已清空）` }
        : { ok: false, error: `没有这个任务：${id}` }
    },
  })
}
