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
import { decodeCmdBytes, defineTool } from "./tools.ts"
import { systemNotice } from "./context.ts"
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
  /**
   * 发起任务所在会话的 id（job_start 从 ToolContext.log 里带出来）。
   * 完成通知要**按它路由**回正确会话的 inbox——后台任务是全局的，会话是各自的，
   * 没有这个字段就只能广播或丢弃，两者都错。
   */
  owner?: string
}

const MAX_OUTPUT = 20_000
const KEEP_JOBS = 50

const truncate = (s: string): string => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（已截断，共 ${s.length} 字符）` : s)

/**
 * 任务终态的通知文本（P1-7）。**必须走 systemNotice 包装**：
 * 它是"注入对话的自动事件"，不带声明就会被模型读成用户发言/授权。
 * `<task-notification>` 块与 Claude Code 同形；note 说"可能通知多次"，
 * 因为续跑/重复终态都可能再来一条，收到通知 ≠ 见到终态。
 */
export function jobNotification(j: JobInfo): string {
  const zh = j.status === "done" ? "完成" : j.status === "failed" ? "失败" : "已取消"
  return systemNotice(
    "后台任务",
    [
      "<task-notification>",
      `<task-id>${j.id}</task-id>`,
      `<status>${j.status}</status>`,
      `<summary>后台任务 ${j.id}（${j.kind}）${zh}</summary>`,
      j.status === "done" ? `<result>${(j.output || "（无输出）").slice(0, 500)}</result>` : "",
      j.status === "failed" ? `<error>${(j.error || "（无原因）").slice(0, 500)}</error>` : "",
      "<note>用 job_status 查完整输出；同一 task-id 可能通知多次，收到通知不等于任务已是终态。</note>",
      "</task-notification>",
    ]
      .filter(Boolean)
      .join("\n"),
  )
}

export class JobRegistry {
  private jobs: JobInfo[] = []
  private procs = new Map<string, ReturnType<typeof spawn>>()
  private seq = 0
  /**
   * 完成回调（由装配方接线，见 sdk.ts）：任务到终态时被调一次，
   * 携带完整 JobInfo + 通知文本。注册表自己**不碰**会话/inbox——
   * 路由是调用方的事（谁的会话发的任务，通知回谁）。
   */
  private onComplete?: (job: JobInfo, notification: string) => void

  setOnComplete(cb: (job: JobInfo, notification: string) => void): void {
    this.onComplete = cb
  }

  private alloc(kind: string): JobInfo {
    const info: JobInfo = { id: `j${++this.seq}`, kind, status: "running", startedAt: Date.now() }
    this.jobs.push(info)
    this.prune()
    return info
  }

  /** 终态出口统一入口：落状态 + 触发通知（cancelled 在 cancel() 里单独发）。 */
  private announce(info: JobInfo): void {
    try {
      this.onComplete?.({ ...info }, jobNotification(info))
    } catch {
      /* 通知失败不影响任务本身：结果已经在 info 里，job_status 永远查得到 */
    }
  }

  /** 发起一个任务：**立刻返回句柄**，不等它跑完。 */
  start(kind: string, runner: () => Promise<{ output?: string; error?: string; exitCode?: number }>): JobInfo {
    const info = this.alloc(kind)
    void runner()
      .then((r) => {
        // 期间被取消了：后来的结果丢弃，状态保持 cancelled（取消通知已在 cancel() 发过）
        if (info.status === "cancelled") return
        info.status = r.error ? "failed" : "done"
        info.output = r.output ? truncate(r.output) : undefined
        info.error = r.error ? truncate(r.error) : undefined
        info.exitCode = r.exitCode
        info.endedAt = Date.now()
        this.announce(info)
      })
      .catch((err) => {
        if (info.status === "cancelled") return
        info.status = "failed"
        info.error = truncate(String((err as Error).message || err))
        info.endedAt = Date.now()
        this.announce(info)
      })
      .finally(() => {
        this.procs.delete(info.id)
        this.prune()
      })
    return { ...info }
  }

  /**
   * 后台跑一条命令。owner = 发起会话 id（完成通知路由用），由 job_start 从
   * ToolContext.log 里带进来。
   *
   * 输出**按字节收集、退出时整体解码**（decodeCmdBytes）：与 run_command 同一个坑——
   * `String(buffer)` 默认按 UTF-8 解，中文机上 cmd/PowerShell 的 GBK 输出会变成锟斤拷。
   * 这里以前正是 String(d) 分段拼接：一个汉字被 data 事件切两半时无解，整体 UTF-8
   * 强解又把 GBK 变乱码——同一个 bug 的第二现场，一并修掉。
   */
  startCommand(command: string, cwd: string, timeoutMs = 120_000, owner?: string): JobInfo {
    const cmd = String(command || "").trim()
    if (!cmd) throw new Error("命令为空")
    const ms = Math.min(Math.max(Number(timeoutMs) || 120_000, 1000), 600_000)
    // 先拿 id（句柄）再发起：没有句柄就没法取消
    const info = this.alloc("command")
    info.owner = owner

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

    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try { child.kill("SIGKILL") } catch { /* 已退出 */ }
    }, ms)
    child.stdout?.on("data", (d) => { outChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))) })
    child.stderr?.on("data", (d) => { errChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))) })
    child.on("error", (e) => {
      clearTimeout(timer)
      this.finish(info.id, "", `启动失败：${e.message}`, undefined)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const body = [decodeCmdBytes(Buffer.concat(outChunks)), decodeCmdBytes(Buffer.concat(errChunks))].filter(Boolean).join("\n")
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
      // 取消也是终态：主循环可能正等着它（通知文本里 status=cancelled 已如实写明）
      this.announce(j)
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
    this.announce(j)
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
      "把一条命令放到**后台**跑：立刻返回任务 id 而不是结果，主循环继续干别的。" +
      "适合构建/全量测试/装依赖这类分钟级慢活；**几秒内能完的命令别扔后台**——" +
      "后台结果要另一次 job_status 才拿得到，快命令反而多绕一圈。" +
      "任务完成后会有系统通知自动注入对话（通知≠你发的指令）；等它用 job_wait，查它用 job_status，撤销用 job_cancel。",
    parameters: [
      { name: "command", type: "string", required: true, desc: "要后台执行的命令" },
      { name: "timeout_ms", type: "number", required: false, desc: "超时毫秒：默认 120000，上限 600000" },
    ],
    action: "command",
    execute(args, ctx): ToolResult {
      const cmd = String(args.command || "").trim()
      if (!cmd) return { ok: false, error: "命令为空" }
      try {
        // owner = 当前会话 id：完成通知按它路由回**这个**会话的 inbox（多会话不串门）
        const owner = String((ctx.log as { id?: string } | undefined)?.id || "") || undefined
        const j = jobs.startCommand(cmd, ctx.workspace, Number(args.timeout_ms) || 120_000, owner)
        // 只回 id：回结果就变成同步调用，模型还是会等
        return { ok: true, output: `已发起后台任务 ${j.id}（${j.kind}）。用 job_status 查看，job_wait 等待，job_cancel 取消。` }
      } catch (err) {
        return { ok: false, error: String((err as Error).message || err) }
      }
    },
  })

  defineTool({
    name: "job_status",
    description:
      "看后台任务的状态与输出。返回格式：id [状态] 种类 [耗时]；done 附带（可能被截断的）输出。" +
      "传 id 看一个；不传列全部摘要（不含详细输出）。任务终态本会由系统通知自动推给你，" +
      "不必轮询——但通知可能漏不碍事，job_status 永远查得到事实。",
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
    description:
      "等一个后台任务结束（最多等 timeout_ms，默认 30000）。**超时不等于失败**：" +
      "到点还在跑会如实返回 running，不报错——由你决定继续等还是先干别的。",
    parameters: [
      { name: "id", type: "string", required: true, desc: "任务 id" },
      { name: "timeout_ms", type: "number", required: false, desc: "最多等多久，默认 30000，上限 600000" },
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
    description:
      "取消一个后台任务。只 kill 直接子进程，**进程树孙进程可能残留**（结果同样如实写进通知）。" +
      "已取消的任务再查 job_status 仍是 cancelled，不会复活。",
    parameters: [{ name: "id", type: "string", required: true, desc: "任务 id" }],
    // 改的是 agent 自己的状态，不碰用户工作区 → 按 memory_write（非高危，可并行）
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
