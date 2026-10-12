// MCP 客户端（TS-032）：把外部 MCP 服务的工具接进来。
//
// 协议本身很简单——**一行一个 JSON** 说 stdio，所以不依赖任何 MCP SDK
// （本机可能装不上包，与 Python 侧 mcp.py 同样的理由）。
//
// 三个从 Python 侧踩坑经验里直接搬过来的点：
//   1. **stderr 必须独立成管**：真实 npm server 启动时会往 stderr 打日志，混进 stdout
//      就污染 JSON-RPC 帧 → initialize 永远等不到合法响应 → 表现为"调用超时";
//   2. 请求要编号，用条件变量等配对响应（通知没有 id，不能当响应）;
//   3. 握手失败就不算装上，别留"看着像装了其实没装"的空壳。

import fs from "node:fs"
import path from "node:path"
import { spawnResolved } from "./spawn.ts"
import { homeDir } from "./session.ts"

export interface McpServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpToolInfo {
  server: string
  name: string
  description: string
  inputSchema?: unknown
  /**
   * MCP 规范的服务端自述（ToolAnnotations）。**这是 server 自己声明的，不是我们验证过的**——
   * 所以它只能用来"决定要不要多问一次"，绝不能当成安全边界。缺��默认值要按危险处理。
   */
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

const PROTOCOL_VERSION = "2024-11-05"

export class McpClient {
  private proc: ReturnType<typeof spawn> | null = null
  private seq = 0
  private buf = ""
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private serverInfo: unknown = null
  private tools: McpToolInfo[] = []
  /** 启动失败的成句原因（命令找不到 / 没权限…）。请求进来先看它，别干等超时。 */
  private spawnError: Error | null = null

  // 注意：strip-only 模式不支持 constructor(readonly x) 这种参数属性，只能显式赋值
  readonly cfg: McpServerConfig

  constructor(cfg: McpServerConfig) {
    this.cfg = cfg
  }

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null
  }

  get toolList(): McpToolInfo[] {
    return this.tools
  }

  private onData(chunk: string): void {
    this.buf += chunk
    const lines = this.buf.split("\n")
    this.buf = lines.pop() || ""
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      let msg: any
      try {
        msg = JSON.parse(t)
      } catch {
        continue // 坏帧跳过：stdout 被污染时也不能把整个连接打死
      }
      if (msg.id === undefined) continue // 通知，不是响应
      const p = this.pending.get(msg.id)
      if (!p) continue
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else p.resolve(msg.result)
    }
  }

  private request(method: string, params?: unknown, timeoutMs = 15_000): Promise<any> {
    if (!this.proc || !this.proc.stdin) throw new Error(`MCP 服务未启动：${this.cfg.name}`)
    // 已经起不来就立刻失败：否则要干等超时，报的还是"请求超时"这种错方向的提示
    if (this.spawnError) throw this.spawnError
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时：${method}（${this.cfg.name}）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }

  /** 启动 + 握手。失败就抛，不留半成品。
   *
   *  `timeoutMs` 覆盖的是"进程拉起 + 握手完成"的总时间。**`npx -y xxx` 这类服务，
   *  冷启动要先从 npm 下载包**——本机实测单个包冷下载就要几十秒，15s 必然超时。
   *  所以这里给到 90s：首次冷启能撑住，包进缓存后实际秒级完成，不影响后续。
   *  （installMcpTools 另有 10s 总预算保证 agent 就绪不被拖，慢服务后台继续。） */
  async start(timeoutMs = 90_000): Promise<void> {
    /* 走 resolveCommand 而不是裸 spawn：Windows 上 npm 类服务（npx -y …）的
       命令是 .cmd 垫片，裸 spawn 必然 ENOENT/EINVAL —— 装好了却一条都起不来。 */
    this.proc = spawnResolved(this.cfg.command, this.cfg.args || [], {
      env: { ...process.env, ...(this.cfg.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.proc.stdout?.on("data", (d) => this.onData(String(d)))
    this.proc.stderr?.on("data", () => {
      /* 故意忽略：server 的启动日志在这里，混进 stdout 才会出事 */
    })
    this.proc.on("exit", () => {
      for (const [, p] of this.pending) p.reject(new Error(`MCP 服务退出：${this.cfg.name}`))
      this.pending.clear()
    })
    /* **必须接住 error 事件**：命令不存在（ENOENT）、没权限、路径不对都走这里，
       而 Node 的 ChildProcess 没接 'error' 就是 unhandled → **整个智能体进程崩溃**。
       后果是配置里有一条装不上的服务，所有能力一起陪葬——调用方那句
       "握手失败就跳过"根本没机会执行。接住后它才真的只是跳过。 */
    this.proc.on("error", (err: NodeJS.ErrnoException) => {
      const why =
        err?.code === "ENOENT"
          ? `找不到命令：${this.cfg.command}`
          : err?.code === "EACCES"
            ? `没有执行权限：${this.cfg.command}`
            : `MCP 服务出错：${err?.message || err}`
      this.spawnError = new Error(why)
      for (const [, p] of this.pending) p.reject(this.spawnError)
      this.pending.clear()
    })

    this.serverInfo = await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "eva-agent-ts", version: "0.1.0" },
      },
      timeoutMs,
    )
    // 通知没有 id，不等响应
    this.proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
  }

  async listTools(): Promise<McpToolInfo[]> {
    const r = await this.request("tools/list", {})
    this.tools = ((r?.tools as any[]) || []).map((t) => ({
      server: this.cfg.name,
      name: String(t.name),
      description: String(t.description || ""),
      inputSchema: t.inputSchema,
      // 只取用得上的四个 hint，其余字段（如 title）不关我们的事。
      //服务端可能给 null，整体原样带过来由调用方按"缺省=危险"处理。
      annotations: (t.annotations && typeof t.annotations === "object" ? t.annotations : undefined) as
        | McpToolInfo["annotations"]
        | undefined,
    }))
    return this.tools
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<{ ok: boolean; text: string }> {
    const r = await this.request("tools/call", { name, arguments: args }, timeoutMs)
    const content = (r?.content as any[]) || []
    const text = content
      .map((c) => (c && typeof c.text === "string" ? c.text : JSON.stringify(c)))
      .join("\n")
    return { ok: !r?.isError, text: text || "（无输出）" }
  }

  stop(): void {
    try {
      this.proc?.kill()
    } catch {
      /* 已退出 */
    }
    this.proc = null
  }
}

/** 配置文件：`~/.evawork/ts-agent/mcp.json`（与 Python 侧的插件存储分开）。 */
export function loadMcpConfig(): McpServerConfig[] {
  const p = path.join(homeDir(), "mcp.json")
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { servers?: McpServerConfig[] }
    return (raw.servers || []).filter((s) => s && s.name && s.command)
  } catch {
    return []
  }
}

/** 工具名：`mcp__<server>__<tool>`——冒号在 OpenAI 函数名里非法，用双下划线分隔。 */
export function mcpToolName(server: string, tool: string): string {
  const safe = (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_")
  return `mcp__${safe(server)}__${safe(tool)}`
}
