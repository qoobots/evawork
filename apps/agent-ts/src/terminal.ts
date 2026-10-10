// 持久终端（TS-034）：跨命令保持 cwd 与环境变量。
//
// 为什么需要它：`run_command` 每次都是**新进程**，`cd` 只在那一次生效，下一句又回到
// 工作区根——模型会反复 `cd`，或者干脆用绝对路径，两种都很难看且容易出错。
//
// 实现方式与 DSH 的 ptc-runtime 不同（那是真 PTY）：这里用"每条命令一个 shell 进程，
// 但记住上一条结束时的 cwd"来近似。代价是不支持需要交互/会话状态的命令
// （如 `ssh`、需要确认的交互提示），这点必须对模型说清楚——否则它会以为自己在用真终端。

import path from "node:path"
import { spawn } from "node:child_process"

export interface TermResult {
  ok: boolean
  output: string
  cwd: string
}

export class WorkspaceTerminal {
  private cwd: string
  private workspace: string

  // 同 session.ts：不用参数属性（`constructor(private workspace: string)`），
  // Node 的 strip-only 模式只删类型、不做代码转换，参数属性需要生成赋值语句，不被支持。
  constructor(workspace: string) {
    this.workspace = workspace
    this.cwd = path.resolve(workspace)
  }

  get currentDir(): string {
    return this.cwd
  }

  /**
   * 执行一条命令，并把结束时的 cwd 记下来。
   *
   * 不支持交互：命令需要输入时会一直等到超时。这是"每条命令一个进程"的固有代价，
   * 结果里会明确写出来，不让调用方误以为卡住了。
   */
  run(cmd: string, timeoutMs = 30_000): Promise<TermResult> {
    const command = String(cmd || "").trim()
    if (!command) return Promise.resolve({ ok: false, output: "命令为空", cwd: this.cwd })

    return new Promise((resolve) => {
      const isWin = process.platform === "win32"
      // 收尾时用一个**显式标记**带出 cwd，再取标记后面那一行。
      // 直接取输出最后一行不可靠：命令本身可能留空行、打印提示符，或有别的尾随输出。
      const marker = "__EVA_CWD__"
      const wrapped = isWin
        ? `$OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}; Write-Output "${marker}"; (Get-Location).Path`
        : `${command}; echo ${marker}; pwd`
      let child
      try {
        if (isWin) {
          // 经 UTF-16LE base64 传入，规避引号转义；强制 UTF-8 输出避免中文乱码。
          const encoded = Buffer.from(wrapped, "utf16le").toString("base64")
          child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
            cwd: this.cwd,
            env: process.env,
          })
        } else {
          child = spawn("/bin/sh", ["-c", wrapped], { cwd: this.cwd, env: process.env })
        }
      } catch (err) {
        resolve({ ok: false, output: `启动失败：${String(err)}`, cwd: this.cwd })
        return
      }

      let out = ""
      let err = ""
      let killed = false
      const timer = setTimeout(() => {
        killed = true
        try { child.kill("SIGKILL") } catch { /* 已退出 */ }
      }, timeoutMs)

      child.stdout?.on("data", (d) => { out += String(d) })
      child.stderr?.on("data", (d) => { err += String(d) })
      child.on("error", (e) => {
        clearTimeout(timer)
        resolve({ ok: false, output: `启动失败：${e.message}`, cwd: this.cwd })
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        const body = [out, err].filter(Boolean).join("\n").trim()
        if (killed) {
          resolve({ ok: false, output: `超时（>${timeoutMs}ms）；已杀死直接子进程，进程树可能残留。\n${body}`, cwd: this.cwd })
          return
        }
        // 必须**滤掉空行**：cmd 的输出里常有尾随空行，marker 后面那一行若是个空行，
        // 取到的 cwd 就是空 → cwd 永远不更新（实测 cwd 一直停在根目录）
        const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        const idx = lines.lastIndexOf(marker)
        const cmdOut = (idx >= 0 ? lines.slice(0, idx) : lines).filter(Boolean).join("\n").trim()
        let nextCwd = this.cwd
        // marker 之后取**首个非空行**当 cwd：PowerShell 可能在标记与路径之间插空行，
        // 死取"下一行"会读到空串，导致 cd 成功却停在原目录。
        let reported = ""
        if (idx >= 0) {
          for (let k = idx + 1; k < lines.length; k++) {
            const t = (lines[k] || "").trim()
            if (t) {
              reported = t
              break
            }
          }
        }

        if (reported) {
          // 路径约束已移除：cd 到任意位置都跟随（不再限制在工作区内）
          nextCwd = path.resolve(this.cwd, reported)
        }
        this.cwd = nextCwd
        const text = cmdOut || "（无输出）"
        resolve({ ok: code === 0, output: code === 0 ? text : `退出码 ${code}\n${text}`, cwd: this.cwd })
      })
    })
  }

  reset(): void {
    this.cwd = path.resolve(this.workspace)
  }
}
