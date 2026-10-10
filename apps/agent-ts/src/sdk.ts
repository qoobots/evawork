// JSON-RPC 2.0 over stdio（换行分隔）。
//
// 对齐 DSH 的 `sdk/protocol`，但**补上它缺的那几个方法**：DSH 只有
// `initialize` / `session/prompt` / `shutdown` 三个请求，没有 approve/deny、没有 cancel、
// 没有会话管理——审批链路因此走不通。我们这边必须补齐，否则"界面驱动 + 人工审批"是空话。
//
// 为什么是 stdio 而不是 HTTP/WS：进程边界最简单，桌面端拉起一个子进程即可，
// 不用管端口分配与跨进程鉴权（Electron 拉 Python 后端也是同一思路）。

import readline from "node:readline"
import path from "node:path"
import { SessionLog, newSessionId, rewindPoint } from "./session.ts"
import { loadContract } from "./contract.ts"
import { applyManifest, loadManifest } from "./boot.ts"
import {
  deleteSession, exportSession, listSessions, renameSession, searchSessions, sessionEvents,
} from "./query.ts"
import { renderMetrics, telemetry } from "./telemetry.ts"
import { allTools } from "./tools.ts"
import { compactMessages, projectEvents } from "./context.ts"
import type { ContextUsage } from "./context.ts"
import { computeContextUsage } from "./usage.ts"
import type { PromptContext } from "./prompt.ts"
import type { ExportFormat } from "./query.ts"
import { runTurn } from "./loop.ts"
import { llmConfigFromEnv } from "./llm.ts"
import { fetchModelCatalog, pickFeatured } from "./modelcatalog.ts"
import type { Message, SessionEvent } from "./types.ts"

const PROTOCOL = "eva-agent-ts/1"

type Id = number | string

interface RpcRequest {
  jsonrpc?: string
  id?: Id
  method: string
  params?: Record<string, unknown>
}

interface Session {
  id: string
  log: SessionLog
  controller: AbortController
  running: boolean
}

export interface ServeOptions {
  workspace: string
  maxSteps: number
  model?: string
}

export async function serve(opts: ServeOptions): Promise<void> {
  const sessions = new Map<string, Session>()

  // 启动清单（TS-050）：能力组合由一张清单决定，与 cli 同源，避免两边漂移
  const manifest = loadManifest()
  const booted = await applyManifest(manifest)
  if (booted.mcpTools > 0) process.stderr.write(`[mcp] 已接入 ${booted.mcpTools} 个外部工具\n`)

  // 凭据**不在这里取**：没配凭据也应该能 initialize / new session，
  // 缺凭据要在真正调用模型时才报（见 runPrompt），否则进程一启动就崩，
  // 调用方连"为什么起不来"都问不到。

  // 唯一可写的通道就是 stdout；任何 console.log 都会污染协议帧，
  // 所以诊断一律走 stderr（子进程继承父进程的 stderr，桌面端能看到）。
  const send = (msg: unknown): void => {
    process.stdout.write(JSON.stringify(msg) + "\n")
  }
  const notify = (method: string, params: unknown): void => {
    send({ jsonrpc: "2.0", method, params })
  }
  const ok = (id: Id, result: unknown): void => send({ jsonrpc: "2.0", id, result })
  const err = (id: Id, code: number, message: string): void =>
    send({ jsonrpc: "2.0", id, error: { code, message } })

  const sessionsFor = (id: string): Session | undefined => sessions.get(id)

  /**
   * 跑一个 turn，事件边产生边推；不阻塞命令循环。
   */
  async function runPrompt(
    s: Session,
    prompt: string,
    modelOverride: unknown = "",
    route: { baseUrl?: string; token?: string } = {},
  ): Promise<void> {
    s.running = true
    s.controller = new AbortController()
    notify("session.status", { sessionId: s.id, status: "running" })

    const workspace = opts.workspace

    try {
      /* 模型选择必须能**逐轮**生效：界面上「自动选择模型」是默认值，用户换成一个具体
         模型后，这一轮就该用那个。此前这里只认 `opts.model`（子进程启动参数），
         于是下拉选什么都没用——界面写着换了模型，实际跑的还是启动时那一个。
         `auto` 交给降级链裁决，不当作模型名发出去。 */
      const wantModel = String(modelOverride || "").trim()
      const cfg = llmConfigFromEnv({
        model: wantModel && wantModel !== "auto" ? wantModel : opts.model,
        /* S-25：自带通道（BYOK）。地址与 Key 由主进程在**这一轮**注入，子进程不留
           副本、不落盘——它与 EVA 通道是两条互不影响的凭据来源。 */
        ...(route.baseUrl ? { baseUrl: route.baseUrl, token: route.token ?? "" } : {}),
      })

      const res = await runTurn({
        prompt,
        cfg,
        workspace,
        log: s.log,
        systemPrompt: booted.prompt,
        tools: booted.tools,
        maxSteps: opts.maxSteps,
        signal: s.controller.signal,
        onEvent: (e: SessionEvent) => notify("session.event", { sessionId: s.id, event: e }),
        /* 流式正文**不落事件日志**：一条一个 token，落盘会把日志撑爆，
           而它本来也不是"事实"（完整正文在 turn/end 与 session.status 里都有）。
           只作为通知推出去——任务页要的就是这个"在打字"的感觉。 */
        onText: (t: string) => notify("session.text", { sessionId: s.id, text: t }),
        /* 上下文用量（TS-065）：派生值、**不落盘**，只推给界面做监控条——
           每一步都推一次，面板才跟着涨；落盘的话会把会话日志撑大且没有真相价值。 */
        onUsage: (u) => notify("context/usage", { sessionId: s.id, usage: u }),
      })
      notify("session.status", {
        sessionId: s.id,
        status: "idle",
        stop: res.stopReason,
        steps: res.steps,
        note: res.note,
        text: res.text,
        /* "completed"只说明模型停止了调用：有几个调用没做成要如实带出去，
           否则界面上三个命令全失败还挂着绿色"已完成"（用户实测撞到过）。 */
        failed: res.failedTools,
      })
    } catch (e) {
      notify("session.status", { sessionId: s.id, status: "error", error: String(e) })
    } finally {
      s.running = false
    }
  }

  function newSession(): Session {
    const id = newSessionId()
    const log = new SessionLog(id)
    const s: Session = { id, log, controller: new AbortController(), running: false }
    sessions.set(id, s)
    return s
  }

  /**
   * 这条 determinism 请求该用哪个工作区。优先级：**会话自己用过的** > 显式参数 > 启动时的。
   *
   * 为什么要绕这圈：影子仓库与隔离副本都**按工作区分目录**，而 SDK 启动时那个
   * `--workspace` 只是个默认值。TS-060 界面实测就是栽在这里（列表永远是空的、
   * 撤销毫无反应、而且没有报错）。隔离不能再踩一遍。
   */
  function resolveWorkspace(p: Record<string, unknown>): [string, string] {
    const sid = String(p.sessionId || "").trim()
    if (sid) {
      const fromSession = sessionWorkspaces(sid)
      if (fromSession.length) return [fromSession[fromSession.length - 1]!, "session"]
    }
    const w = String(p.workspace || "").trim()
    if (w) return [path.resolve(w), "param"]
    return [opts.workspace, "startup"]
  }

  /**
   * 算一个会话当前的上下文用量（TS-065）。
   *
   * 为什么走**日志重投影**而不是读内存里的那个会话：界面在"没在跑"时也要能看
   * （回放旧会话、刚打开任务页），那时 sessions 里根本没有这个会话——而事件日志
   * 是落盘的真相源，重投影出来的历史与真实请求里那一份同源。
   */
  function usageForSession(sid: string): ContextUsage {
    const ctx: PromptContext = {
      workspace: opts.workspace,
      tools: allTools().map((t) => t.name),
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
    }
    const log = new SessionLog(sid)
    const rp = rewindPoint(log)
    const past = log.events().filter((e) => !rp || Number(e.seq) < rp)
    const history = projectEvents(past)
    const messages: Message[] = [{ role: "system", content: booted.prompt.build(ctx) }]
    if (history.length) messages.push(...compactMessages(history).messages)
    // 与 loop 用同一份"真正暴露出去的工具"（清单里关掉的模块不该算进用量）
    const visible = allTools().filter((t) => booted.tools.includes(t.name))
    return computeContextUsage({ system: booted.prompt, promptCtx: ctx, tools: visible, messages })
  }

  async function dispatch(req: RpcRequest): Promise<void> {
    const id = req.id
    const p = req.params || {}
    const isReq = id !== undefined
    const fail = (code: number, message: string) => (isReq ? err(id as Id, code, message) : undefined)

    switch (req.method) {
      case "initialize":
        return isReq
          ? ok(id as Id, {
              protocolVersion: PROTOCOL,
              serverInfo: { name: "eva-agent-ts", version: "0.1.0" },
              capabilities: {
                methods: [
                  "initialize",
                  "session/new",
                  "session/prompt",
                  "session/cancel",
                  "session/list",
                  "session/rename",
                  "session/delete",
                  "session/events",
                  "session/search",
                  "session/export",
                  "context/usage",
                  "telemetry/summary",
                  "models/list",
                  "shutdown",
                ],
                /* 契约来源**必须可问**：打包漏拷 `contract/agent-contract.json` 时系统会
                   **静默**退化到内置兜底——能跑，但动作风险分类与 Python 侧
                   各判各的（漂移查不出来）。把它摆进 capabilities，任何客户端都能
                   一眼看出"现在用的是哪份契约"，而不是等用户撞上档位失灵。
                   TS-060 打包验证就是靠它发现这个既有静默错的。 */
                contract: loadContract().source,
                notifications: [
                  "session.event",
                  "session.status",
                  "session.text",
                  "context/usage",
                ],
              },
              workspace: opts.workspace,
            })
          : undefined

      case "session/new": {
        const s = newSession()
        return isReq ? ok(id as Id, { sessionId: s.id }) : undefined
      }

      case "session/prompt": {
        const sid = String(p.sessionId || "")
        const prompt = String(p.prompt || "")
        if (!prompt) return fail(-32602, "缺少 prompt")
        const s = sessionsFor(sid) || newSession()
        if (s.running) return fail(-32002, `会话 ${s.id} 正在执行，先 cancel 或另开会话`)
        // 立即应答，事件通过通知流出——否则长任务会一直占着这条请求不回
        if (isReq) ok(id as Id, { sessionId: s.id, accepted: true })
        void runPrompt(s, prompt, p.model, {
          baseUrl: p.baseUrl ? String(p.baseUrl) : undefined,
          token: p.token === undefined || p.token === null ? undefined : String(p.token),
        })
        return
      }

      case "session/cancel": {
        const s = sessionsFor(String(p.sessionId || ""))
        if (!s) return fail(-32001, `会话不存在：${String(p.sessionId)}`)
        s.controller.abort()
        return isReq ? ok(id as Id, { cancelled: true, sessionId: s.id }) : undefined
      }

      /* ---- 上下文用量（TS-065）：界面在**没在跑**时也要能看（回放旧会话、刚打开任务页）。
         不需要凭据、不要求会话在跑——它是从落盘日志重投影算出来的，与请求同源。

         **空 sessionId 不是错误**："新建任务"页就是还没有会话，可此刻已经有一份真实占用
         ——系统提示词加工具/MCP 的 schema 马上就要发出去，算出来的正是这次请求的基线。
         早先这里直接回 `缺少 sessionId`，界面就没有 id 可传，于是**永远画不出那个圆环**，
         看起来像"用量图标时有时无"。没有历史的会话与不存在的会话本就走同一条路
         （`SessionLog` 只读、不建文件），所以不必另写一套。 */
      case "context/usage": {
        const sid = String(p.sessionId || "")
        return isReq ? ok(id as Id, usageForSession(sid)) : undefined
      }

      // ---- 遥测（TS-053）：只回数字与名字，不回任何内容
      case "telemetry/summary":
        return isReq
          ? ok(id as Id, { metrics: telemetry.snapshot(), text: renderMetrics() })
          : undefined

      /* ---- 模型清单（模型广场同步）----
         要凭据（真发请求到平台），但不需要会话在跑——
         界面打开输入框就该能看见可选模型，而不是先跑一个任务才有。
         `force` 绕过 6h 缓存，供界面手动刷新。 */
      case "models/list": {
        let cfg: ReturnType<typeof llmConfigFromEnv> | null = null
        try {
          cfg = llmConfigFromEnv()
        } catch (e) {
          return fail(-32004, `没有模型凭据：${String((e as Error).message)}`)
        }
        const cat = await fetchModelCatalog(cfg, { force: Boolean(p.force) })
        /* 界面上只给**精选**的那 20 个：平台 llm/multimodal 有 344 条，
           绝大多数是视频/3D 模型、重复写法与日期快照，下拉没法翻。
           `allModels` 带上总数，让界面能说明"从多少条里挑的"。 */
        const featured = pickFeatured(cat.models, Number(p.limit) || 20)
        return isReq
          ? ok(id as Id, { ...cat, models: featured, allCount: cat.models.length })
          : undefined
      }

      // ---- 历史查询（TS-051）：界面要能翻旧账，不然事件日志等于存了看不见的东西 ----
      case "session/list":
        return isReq ? ok(id as Id, { sessions: listSessions() }) : undefined

      /* 侧栏的改名/删除。后端废弃后侧栏的真相源就是这份会话目录，
         所以这两个操作必须落到 agent-ts，不能只在前端内存里改——
         那样刷新一下就没了，用户会以为删掉的任务又活了。 */
      case "session/rename": {
        const sid = String(p.sessionId || "")
        const title = String(p.title || "").trim()
        if (!sid) return fail(-32602, "缺少 sessionId")
        if (!title) return fail(-32602, "标题不能为空")
        if (!renameSession(sid, title)) return fail(-32001, `会话不存在：${sid}`)
        return isReq ? ok(id as Id, { sessionId: sid, title }) : undefined
      }

      case "session/delete": {
        const sid = String(p.sessionId || "")
        if (!sid) return fail(-32602, "缺少 sessionId")
        if (!deleteSession(sid)) return fail(-32001, `会话不存在或删不掉：${sid}`)
        return isReq ? ok(id as Id, { sessionId: sid, deleted: true }) : undefined
      }

      case "session/events": {
        const sid = String(p.sessionId || "")
        if (!sid) return fail(-32602, "缺少 sessionId")
        return isReq ? ok(id as Id, { sessionId: sid, events: sessionEvents(sid) }) : undefined
      }

      case "session/search": {
        const term = String(p.term || "")
        if (!term) return fail(-32602, "缺少 term")
        return isReq
          ? ok(id as Id, { hits: searchSessions(term, { limit: Number(p.limit) || 50, sessionId: p.sessionId ? String(p.sessionId) : undefined }) })
          : undefined
      }

      case "session/export": {
        const sid = String(p.sessionId || "")
        if (!sid) return fail(-32602, "缺少 sessionId")
        const fmt = String(p.format || "md") as ExportFormat
        if (fmt !== "md" && fmt !== "json" && fmt !== "jsonl") return fail(-32602, `format 只支持 md/json/jsonl：${fmt}`)
        return isReq ? ok(id as Id, { sessionId: sid, format: fmt, text: exportSession(sid, fmt) }) : undefined
      }

      case "shutdown":
        if (isReq) ok(id as Id, { ok: true })
        booted.stop() // 不关的话 MCP 子进程会残留成孤儿
        process.exit(0)
        return

      default:
        return fail(-32601, `未知方法：${req.method}`)
    }
  }

  /* ---- 退出兜底（TS-066）----------------------------------------------------
     进程被杀（taskkill、父进程退出、未捕获异常）时，正在跑的那一轮**永远写不出
     turn/end**，而界面只在收到 turn/end 时才收尾——于是任务卡在"执行中"。
     更糟的是回放：日志里没有终态事件，回放同样的会话会一路"执行中"到底。

     所以在三个退出点补一条终态。能同步做是因为 `SessionLog.append` 走
     `appendFileSync`（事件日志是真相源，宁可同步写也不冒写一半的风险），
     `process.on("exit")` 里仍然来得及。

     这里**不**发通知：管道随时可能已经断了，硬发只会把退出流程再拖一次。 */
  let closing = false
  const closeRunningSessions = (why: string): void => {
    if (closing) return
    closing = true
    for (const s of sessions.values()) {
      if (!s.running) continue
      try {
        s.controller.abort()
      } catch {
        /* 已 abort */
      }
      // 步数只能从日志回推：runTurn 的内部计数拿不到，而日志里 step/start 是事实
      let steps = 0
      try {
        for (const e of s.log.events()) if (e.type === "step/start") steps = Math.max(steps, Number(e.step) || 0)
      } catch {
        /* 读不出来就如实记 0，不猜 */
      }
      s.log.append({ type: "agent/turn-stopping", reason: "killed", steps, note: why })
      s.log.append({ type: "agent/status", status: "stopped", note: why })
      s.log.append({ type: "turn/end", steps, stop: "killed", note: why, text: "", failedTools: 0 })
      s.running = false
    }
  }

  // 优雅退出：收到信号就补终态，然后自己退出（不依赖父进程来收尸）
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      closeRunningSessions(`TS 智能体进程收到 ${sig}，本轮未跑完`)
      process.exit(0)
    })
  }
  // 硬退出：崩溃 / 父进程断开 / `shutdown` 里的 process.exit(0)
  process.on("exit", () => closeRunningSessions("TS 智能体进程退出，本轮未跑完"))

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    const t = line.trim()
    if (!t) continue
    let req: RpcRequest
    try {
      req = JSON.parse(t) as RpcRequest
    } catch {
      err(0, -32700, "解析失败：不是合法 JSON")
      continue
    }
    if (!req.method) {
      err((req.id ?? 0) as Id, -32600, "缺少 method")
      continue
    }
    // 串行处理：一次只跑一个 turn 的派发，避免两个 prompt 抢同一个 gate
    await dispatch(req).catch((e) => {
      if (req.id !== undefined) err(req.id, -32603, `处理失败：${String(e)}`)
    })
  }
}
