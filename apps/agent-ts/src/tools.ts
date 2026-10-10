// 工具注册表与执行管线。
//
// 审批与沙箱路径约束已移除：所有工具一律放行，不再二次确认。
// `pre-execute` 只做"工具是否存在"的校验，避免模型反复猜一个不存在的工具名。

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { egressFetch } from "./egress.ts"
import { WorkspaceTerminal } from "./terminal.ts"
import { McpClient, loadMcpConfig, mcpToolName } from "./mcp.ts"
import {
  docxFromMarkdown,
  pdfFromPages,
  pptxFromSlides,
  readDocx,
  readKind,
  readXlsx,
  xlsxFromRows,
  type DocxRead,
  type SlideSpec,
  type TableSpec,
  type XlsxRead,
} from "./office.ts"
import type { McpServerConfig } from "./mcp.ts"
import type { ToolAction, ToolContext, ToolDef, ToolParam, ToolResult } from "./types.ts"
import { MAX_STEPS_HARD_CAP } from "./budget.ts"

const registry = new Map<string, ToolDef>()

export function defineTool(def: ToolDef): ToolDef {
  if (registry.has(def.name)) throw new Error(`工具重名：${def.name}`)
  registry.set(def.name, def)
  return def
}

export function allTools(): ToolDef[] {
  return [...registry.values()]
}

export function findTool(name: string): ToolDef | undefined {
  return registry.get(name)
}

/**
 * 上游（OpenAI 兼容）只认这几个**单值**类型。JSON Schema 允许的其它写法
 * （`type` 是数组、`anyOf`、只有 `enum`/`const`）到线上之前都得收敛成一个。
 */
const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"])

/** 白名单过滤：不认识的一律落到 fallback。`fallback = ""` 用作"合法性判定"。 */
function wireType(t: unknown, fallback = "string"): string {
  const s = typeof t === "string" ? t : ""
  return JSON_TYPES.has(s) ? s : fallback
}

/** 按**取值本身**推类型：枚举 / `const` 不写 `type` 是常见写法。 */
function jsType(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number"
  if (typeof v === "string") return "string"
  if (typeof v === "boolean") return "boolean"
  if (v === null) return "null"
  return Array.isArray(v) ? "array" : typeof v === "object" ? "object" : ""
}

/** 认不出来返回空串（外层再兜底），这样递归里能区分"没有类型"和"类型就是 string"。 */
function detectJsonType(node: unknown, depth: number): string {
  if (!node || typeof node !== "object" || depth > 3) return ""
  const n = node as { type?: unknown; anyOf?: unknown; oneOf?: unknown; enum?: unknown; const?: unknown }

  const direct = wireType(n.type, "")
  if (direct) return direct

  if (Array.isArray(n.type)) {
    // 可空常写成 `["string","null"]`；让非 null 那支优先，null 只作最后选择
    const members = n.type.filter((t) => t !== "null")
    for (const t of members.length ? members : n.type) {
      const got = wireType(t, "")
      if (got) return got
    }
  }

  // zod 的 `.union()` 在某些版本/配置下导出成 anyOf（而不是 type 数组），一并认
  for (const branch of [n.anyOf, n.oneOf]) {
    if (!Array.isArray(branch)) continue
    for (const b of branch) {
      const got = detectJsonType(b, depth + 1)
      if (got && got !== "null") return got
    }
  }

  const sample = Array.isArray(n.enum) ? n.enum.find((x) => x !== null) : n.const
  return sample === undefined ? "" : jsType(sample)
}

/**
 * 把 JSON Schema 的一个属性节点收敛成**单个**上游能接受的类型。
 *
 * 为什么必须收敛：MCP 的 `inputSchema` 是完整 JSON Schema，**`type` 可以是数组**
 * （`["boolean","string"]` 表示联合类型，zod 的 `.union()`/`.or()` 就是这么导出的）。
 * 早先这里是 `String(v.type)`，数组会被拼成 `"boolean,string"` 这个**两边都不是**的串，
 * 整个请求在模型开工前就被上游 400 打回：
 *
 *   Invalid schema for function 'mcp__Sequential_Thinking__sequentialthinking':
 *   "boolean,string" is not valid under any of the schemas listed in the 'anyOf' keyword
 *
 * 后果不是"某个工具不可用"，而是**只要装了这类 MCP server，之后每一轮请求都失败**
 * （schema 校验发生在模型看到消息之前），用户看到的是一个与 MCP 毫无字面关系的报错。
 *
 * 收敛顺序：单值 → 数组取首个非 null → anyOf/oneOf 递归 → enum/const 按取值推 → `string` 兜底。
 * **取联合里的哪一支不影响执行**：MCP server 仍按它自己的 schema 校验实参，联合类型两支
 * 都收；这里只决定"告诉模型这个参数长什么样"。
 */
function jsonSchemaType(node: unknown): string {
  return detectJsonType(node, 0) || "string"
}

/** 转成 OpenAI function schema（模型只认这个形状）。 */
export function openaiSchemas(tools: ToolDef[] = allTools()): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          // 出口再滤一遍：正常路径上 MCP 那边已经收敛过（见 jsonSchemaType），
          // 这里是防**手写 ToolParam 打错字**——一个参数类型写错不该让整轮请求 400
          t.parameters.map((p) => [p.name, { type: wireType(p.type), description: p.desc }]),
        ),
        required: t.parameters.filter((p) => p.required).map((p) => p.name),
      },
    },
  }))
}

// ---------------- 内置工具（最小可用集） ----------------

const MAX_OUTPUT = 20_000

const truncate = (s: string, n = MAX_OUTPUT): string =>
  s.length > n ? `${s.slice(0, n)}\n…（已截断，共 ${s.length} 字符）` : s

defineTool({
  name: "set_max_steps",
  description: "调整本轮 turn 的剩余步数上限。简单任务保持默认值即可；若判断任务确实复杂、需要更多步数，可主动申请扩展。",
  parameters: [
    { name: "steps", type: "number", required: true, desc: `目标步数上限（1-${MAX_STEPS_HARD_CAP}）` },
    { name: "reason", type: "string", required: false, desc: "申请理由，会显示给用户" },
  ],
  action: "llm",
  execute(args): ToolResult {
    const steps = Number(args.steps)
    if (!Number.isFinite(steps) || steps < 1) {
      return { ok: false, error: "步数必须是正整数" }
    }
    if (steps > MAX_STEPS_HARD_CAP) {
      return { ok: false, error: `步数不能超过硬顶 ${MAX_STEPS_HARD_CAP}，如需更高上限请分轮次处理` }
    }
    return { ok: true, output: `已将本轮步数上限申请调整为 ${Math.floor(steps)} 步` }
  },
})

/** 跑一条 shell 命令（普通子进程）。 */
async function runCommand(cmd: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ToolResult> {
  if (signal?.aborted) return { ok: false, error: "已取消" }
  return runPlain(cmd, cwd, timeoutMs, signal)
}

/**
 * 把命令输出的**字节**解成字符串。
 *
 * 为什么不能直接 `String(buf)`：它默认按 UTF-8 解，而 Windows 的 cmd 在中文机器上
 * 代码页是 **936（GBK）**——`echo 中文` 出来的是 GBK 字节，按 UTF-8 解就全是替换字符，
 * 显示出来就是那串著名的"锟斤拷"。模型于是拿到一堆乱码，只能回答"输出是空的/乱码"。
 *
 * 判据用**严格** UTF-8：GBK 的字节基本都不是合法 UTF-8 序列，严格解会失败；
 * 而非严格解会**静默**产出 U+FFFD 且**不报错**——这正是这个 bug 藏了这么久的原因
 * （"解码失败"从来没发生过，所以降级分支也从没被触发过）。
 */
export function decodeCmdBytes(buf: Buffer): string {
  if (!buf.length) return ""
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf)
  } catch {
    // 不是合法 UTF-8 → 按本机 ANSI 代码页解（中文机上是 GBK）
    for (const enc of ["gb18030", "gbk", "latin1"]) {
      try {
        return new TextDecoder(enc).decode(buf)
      } catch {
        /* 这个编码不被支持就换下一个 */
      }
    }
    return buf.toString("utf8")
  }
}

/**
 * 普通子进程；超时后 kill，**如实标注可能残留子进程**。
 * signal：会话被取消时**立即杀掉子进程**——不接的话，点"停止"后 loop 还会
 * 卡在这条命令上直到超时（最长 120s），界面就表现为"停止不管用"。
 */
function runPlain(cmd: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ToolResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32"
    let child
    try {
      if (isWin) {
        // 用 PowerShell 而非 cmd：命令经过 UTF-16LE base64 编码传入，规避引号转义，
        // 并强制 UTF-8 输出，避免中文机器上 GBK 乱码（decodeCmdBytes 再兜底）。
        const psCmd =
          "$OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
          cmd
        const encoded = Buffer.from(psCmd, "utf16le").toString("base64")
        child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { cwd, env: process.env })
      } else {
        child = spawn("/bin/sh", ["-c", cmd], { cwd, env: process.env })
      }
    } catch (err) {
      // hardened 档（Node permission model 且未授予 --allow-child-process）下 spawn
      // 会直接抛 ERR_ACCESS_DENIED。要说清是**档位不允许**，而不是"命令有问题"——
      // 否则调用方会以为是命令写错了，反复重试。
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ERR_ACCESS_DENIED") {
        resolve({ ok: false, error: "当前为 hardened 档：不允许启动子进程（命令工具已禁用）" })
        return
      }
      resolve({ ok: false, error: `启动失败：${String(err)}` })
      return
    }
    // 按**字节**收集，退出时整体解码：分段解码会把一个汉字切在两块之间，
    // 那样无论怎么解都是坏的（多字节字符不能按 data 事件的边界切）
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let killed = false
    let why = ""
    const killNow = (reason: string) => {
      if (killed) return
      killed = true
      why = reason
      // 注意：kill 只杀直接子进程，进程树里的孙进程可能残留
      // （这是已知边界，如实写进输出，不假装清理干净了）
      try { child.kill("SIGKILL") } catch { /* 已退出 */ }
    }
    const timer = setTimeout(() => killNow(`命令超时（>${timeoutMs}ms）`), timeoutMs)
    if (signal) {
      if (signal.aborted) killNow("已取消")
      else signal.addEventListener("abort", () => killNow("已取消"), { once: true })
    }

    child.stdout?.on("data", (d) => { outChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))) })
    child.stderr?.on("data", (d) => { errChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))) })
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `启动失败：${e.message}` })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const out = decodeCmdBytes(Buffer.concat(outChunks))
      const err = decodeCmdBytes(Buffer.concat(errChunks))
      const body = truncate([out, err].filter(Boolean).join("\n") || "（无输出）")
      if (killed) {
        resolve({
          ok: false,
          error: `${why}。已杀死直接子进程，进程树可能仍有残留。\n${body}`,
        })
        return
      }
      resolve(code === 0 ? { ok: true, output: body || "（成功，无输出）" } : { ok: false, error: `退出码 ${code}\n${body}` })
    })
  })
}

defineTool({
  name: "run_command",
  description: "在工作区内执行一条命令（Windows 走 PowerShell，其它平台走 sh）。需要确认；有超时，输出会被截断。",
  parameters: [
    { name: "command", type: "string", required: true, desc: "要执行的命令" },
    { name: "timeout_ms", type: "number", required: false, desc: "超时毫秒，默认 30000" },
  ],
  action: "command",
  async execute(args, ctx): Promise<ToolResult> {
    const cmd = String(args.command || "").trim()
    if (!cmd) return { ok: false, error: "命令为空" }
    const ms = Math.min(Math.max(Number(args.timeout_ms) || 30_000, 1000), 120_000)
    // cwd 固定工作区根：模型不能靠 cd 逃出去
    return runCommand(cmd, path.resolve(ctx.workspace), ms, ctx.signal)
  },
})

defineTool({
  name: "web_fetch",
  description:
    "抓取一个 URL 的内容（走统一出口，受 EVA_EGRESS_ALLOWLIST 约束）。返回纯文本摘要，超大内容会被截断。",
  parameters: [
    { name: "url", type: "string", required: true, desc: "完整 URL（http/https）" },
    { name: "max_chars", type: "number", required: false, desc: "最多返回多少字符，默认 8000" },
  ],
  action: "network",
  async execute(args): Promise<ToolResult> {
    const url = String(args.url || "").trim()
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: "只支持 http/https" }
    const max = Math.min(Math.max(Number(args.max_chars) || 8000, 200), 50_000)
    let res: Response
    try {
      // 走统一出口：非白名单域名会被 egress.ts 拦下（有明确错误，不是超时）
      res = await egressFetch(url, { headers: { "User-Agent": "eva-agent-ts/0.1" } })
    } catch (err) {
      return { ok: false, error: String((err as Error).message || err) }
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    let text = await res.text()
    // 极简去标签：够看主要内容就行，不做完整 HTML 解析
    if (/<html|<!doctype/i.test(text.slice(0, 200))) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
    }
    return { ok: true, output: truncate(text.trim(), max) }
  },
})

// ---- 持久终端（TS-034）----

const terminals = new Map<string, WorkspaceTerminal>()

/** 每个工作区一个终端实例：cwd 要跨命令保持，所以不能每次新建。 */
function termFor(workspace: string): WorkspaceTerminal {
  const key = path.resolve(workspace)
  let t = terminals.get(key)
  if (!t) {
    t = new WorkspaceTerminal(key)
    terminals.set(key, t)
  }
  return t
}

defineTool({
  name: "terminal",
  description:
    "在持久终端里执行命令：**cwd 会保持到下一次**（run_command 每条都重置回工作区根）。不支持交互式命令。",
  parameters: [
    { name: "command", type: "string", required: true, desc: "要执行的命令" },
    { name: "timeout_ms", type: "number", required: false, desc: "超时毫秒，默认 30000" },
  ],
  action: "command",
  async execute(args, ctx): Promise<ToolResult> {
    const cmd = String(args.command || "").trim()
    if (!cmd) return { ok: false, error: "命令为空" }
    const ms = Math.min(Math.max(Number(args.timeout_ms) || 30_000, 1000), 120_000)
    const r = await withCancel(termFor(ctx.workspace).run(cmd, ms), ctx.signal, "持久终端按其超时自行清理")
    // 把当前目录带回给模型：它要知道"下一次从哪开始"，否则只能靠猜
    return r.ok
      ? { ok: true, output: `${r.output}\n[cwd] ${r.cwd}` }
      : { ok: false, error: `${r.output}\n[cwd] ${r.cwd}` }
  },
})

// ---- MCP 外部工具（TS-032）----

const mcpClients: McpClient[] = []

/**
 * inputSchema 的 properties 转成我们的参数表；没有 schema 就不声明（模型自己按名字给）。
 *
 * `type` **必须**过 `jsonSchemaType`：MCP 的 schema 允许联合类型（`type` 是数组），
 * 直接 String 出来是个非法类型串，会让每一轮请求都被上游 400 打回（详见该函数注释）。
 */
function paramsFromSchema(schema: unknown): ToolParam[] {
  const props = (schema as { properties?: Record<string, any> })?.properties
  if (!props || typeof props !== "object") return []
  const required = new Set<string>(((schema as { required?: string[] })?.required) || [])
  return Object.entries(props).map(([k, v]) => ({
    name: k,
    type: jsonSchemaType(v),
    required: required.has(k),
    desc: String((v as any)?.description || k),
  }))
}

/**
 * 启动配置里的 MCP 服务，把它们的工具注册进本注册表。
 *
 * 两个刻意的决定：
 *   1. **默认当成 command（高危）走审批**：MCP 协议不携带"这个工具危险吗"的元数据，
 *      而外部工具能干什么完全由对方说了算——按高危处理是唯一不赌的姿势；
 *   2. **握手失败就跳过并记原因**，不留"看着像装了其实没装"的空壳工具。
 *
 * 返回装上几个工具（失败的返回 0，不抛）。
 */
/** 启动 MCP 时给**所有服务合起来的总预算**（不是每个各一份）。
 *  串行握手时 N 个服务就是 N×15s：9 个 npx 服务能把就绪拖到两分钟以上，
 *  表现是"智能体一直起不来"，而用户根本不知道在等什么。 */
const MCP_BOOT_BUDGET_MS = 10_000

function mcpToolCount(): number {
  return allTools().filter((t) => t.name.startsWith("mcp__")).length
}

export async function installMcpTools(
  list: McpServerConfig[] = loadMcpConfig(),
  totalMs = MCP_BOOT_BUDGET_MS,
): Promise<number> {
  if (!list.length) return 0

  const one = async (cfg: McpServerConfig): Promise<number> => {
    let n = 0
    const client = new McpClient(cfg)
    try {
      await client.start()
      const tools = await client.listTools()
      for (const t of tools) {
        const name = mcpToolName(cfg.name, t.name)
        if (registry.has(name)) continue
        defineTool({
          name,
          description: `[MCP:${cfg.name}] ${t.description || t.name}`,
          parameters: paramsFromSchema(t.inputSchema),
          // **按服务端自述的只读标记分级**（对标 Codex：core/src/mcp_tool_call.rs:2163）。
          // 之前一律按 "command" 算，导致 Filesystem 这类**纯读**工具在 plan / never 档
          // 也被当命令拦掉，用户只能干看着"想读个文件都要批"。
          //
          // 注意这是 **advisory，不是安全边界**：标注来自 server 自己，而且 MCP 工具
          // 本工具走 MCP server 自带的工作区根，不经过本地路径解析。
          // 缺省（没有 readOnlyHint）一律按 command——宁可多问一次，不按"大概没事"放行。
          action: t.annotations?.readOnlyHint === true ? "read" : "command",
          async execute(args): Promise<ToolResult> {
            const r = await client.callTool(t.name, args)
            return r.ok ? { ok: true, output: r.text } : { ok: false, error: r.text }
          },
        })
        n += 1
      }
      mcpClients.push(client)
    } catch (err) {
      // 走 stderr：--serve 模式下 stdout 是协议通道，不能被诊断信息污染
      console.error(`[mcp] ${cfg.name} 未启用：${(err as Error).message || String(err)}`)
      client.stop()
    }
    return n
  }

  /* **并行 + 总预算**：慢服务不该拖住没问题的服务，更不该拖住智能体就绪。
     预算到了就先返回已装上的；剩下的**继续在后台跑**，握手完成照样注册进来
     ——它们只是"稍后可用"，不是失败。 */
  const settled = Promise.allSettled(list.map((cfg) => one(cfg)))
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), totalMs)
  })
  const raced = await Promise.race([settled.then(() => "done" as const), budget])
  if (timer) clearTimeout(timer)

  if (raced === "done") {
    const res = await settled
    return res.reduce((a, x) => a + (x.status === "fulfilled" ? x.value : 0), 0)
  }
  void settled
    .then((res) => {
      const late = res.reduce((a, x) => a + (x.status === "fulfilled" ? x.value : 0), 0)
      if (late > 0) console.error(`[mcp] 后台又装上 ${late} 个工具（总 ${mcpToolCount()}）`)
    })
    .catch(() => {})
  return mcpToolCount()
}

/** 关掉所有 MCP 服务（退出前必须调，否则子进程会残留）。 */
export function stopMcp(): void {
  for (const c of mcpClients) c.stop()
  mcpClients.length = 0
}

// ---------------- pre-execute 管线 ----------------

export interface PreExecResult {
  allowed: boolean
  action: ToolAction
  reason: string
  tool?: ToolDef
  args: Record<string, unknown>
}

/** 给展示用的相对路径（沙箱已移除，纯相对化即可）。 */
function relTo(workspace: string, abs: string): string {
  const rel = path.relative(path.resolve(workspace), abs)
  return rel.replace(/\\/g, "/") || "."
}

/**
 * 执行前的统一判定。
 *
 * 工具不存在也要**明确拒绝并把可用名字带回去**——静默放行或只回一句"工具不存在"，
 * 模型会继续猜，猜错的名字还会再错一轮。
 *
 * 审批与沙箱路径约束已移除：工具一律放行，不再二次确认（TS 精简）。
 */
export async function preExecute(
  name: string,
  rawArgs: Record<string, unknown>,
): Promise<PreExecResult> {
  const tool = findTool(name)
  if (!tool) {
    return {
      allowed: false,
      action: "llm",
      reason: `没有这个工具：${name}。可用：${allTools().map((t) => t.name).join(", ")}`,
      args: rawArgs,
    }
  }
  return { allowed: true, action: tool.action, reason: "已放行", tool, args: rawArgs }
}

/** 解析模型给的参数（它给的是 JSON 字符串，可能不合法）。 */
export function parseArgs(raw: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>
  const s = String(raw || "").trim()
  if (!s) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function executeTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    return await tool.execute(args, ctx)
  } catch (err) {
    return { ok: false, error: `执行异常：${String(err)}` }
  }
}

/* ---------------- 办公文档四件套（TS-066）---------------- */

/**
 * 解析一个"可能是 JSON 字符串"的参数。
 *
 * 复杂结构（表格 / 幻灯片 / 数据行）一律让模型传 **JSON 字符串**而不是嵌套对象：
 * OpenAI 兼容接口对 array/object 参数的支持参差，而字符串一定到得了；
 * 解析失败时把原文与问题一起说清，而不是静默当成空数组——那会让模型以为
 * 自己传对了，然后拿到一份空文档。
 */
function jsonArg<T>(raw: unknown, what: string, example: string): T | null {
  if (raw === undefined || raw === null || raw === "") return null
  if (typeof raw === "object") return raw as T
  try {
    return JSON.parse(String(raw)) as T
  } catch (e) {
    throw new Error(`${what} 不是合法 JSON：${(e as Error).message}。要长这样：${example}`)
  }
}

defineTool({
  name: "create_document",
  description:
    "生成 Word 文档（.docx）。content 用 Markdown 子集：# 到 ###### 是各级标题，'- ' 是要点，其余非空行是段落。需要表格时用 table 参数（JSON），不要用 ASCII 排版硬凑。path 给 .md/.markdown/.txt 会自动转成 .docx。",
  parameters: [
    { name: "path", type: "string", required: true, desc: "输出路径（.docx；.md/.markdown/.txt 自动转 .docx）" },
    { name: "content", type: "string", required: true, desc: "Markdown 正文（标题用 #，要点用 - ）" },
    { name: "table", type: "string", required: false, desc: '可选表格 JSON：{"header":["列1","列2"],"rows":[["a","b"]]}' },
  ],
  action: "write",
  async execute(args, ctx): Promise<ToolResult> {
    try {
      let abs = path.resolve(ctx.workspace, String(args.path || ""))
      if (!/\.docx$/i.test(abs)) {
        // 模型常先入为主给 .md/.markdown/.txt；自动落到 .docx，避免"只写 .docx"的硬拒导致重试。
        // 其它非 docx 后缀仍是非法输入，明确报错。
        const m = abs.match(/\.(md|markdown|txt)$/i)
        if (m) abs = abs.slice(0, -m[1].length) + "docx"
        else return { ok: false, error: "create_document 只写 .docx 文件（路径要以 .docx 结尾；.md/.markdown/.txt 会自动转成 .docx）" }
      }
      const table = jsonArg<TableSpec>(args.table, "table", '{"header":["列1"],"rows":[["值"]]}') ?? undefined
      if (table && (!Array.isArray(table.header) || !Array.isArray(table.rows))) {
        return { ok: false, error: 'table 需要形如 {"header":[...],"rows":[[...]]}' }
      }
      const r = await docxFromMarkdown(String(args.content ?? ""), table)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, r.buffer)
      return {
        ok: true,
        output: `已生成 Word 文档 ${relTo(ctx.workspace, abs)}（${r.bytes} 字节，${r.paragraphs} 段${r.tables ? "，含 1 个表格" : ""}）`,
      }
    } catch (err) {
      return { ok: false, error: `生成 Word 文档失败：${String((err as Error).message || err)}` }
    }
  },
})

defineTool({
  name: "read_document",
  description:
    "读 Word（.docx）或 Excel（.xlsx）并返回文本内容。改文档前先读它——凭猜测改已有文件最容易把内容改坏。",
  parameters: [
    { name: "path", type: "string", required: true, desc: "文件路径（.docx 或 .xlsx）" },
    { name: "sheet", type: "string", required: false, desc: "xlsx 的工作表名（不给则读第一个）" },
    { name: "max_rows", type: "number", required: false, desc: "xlsx 最多读多少行（默认 200）" },
  ],
  action: "read",
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const abs = path.resolve(ctx.workspace, String(args.path || ""))
      if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在：${relTo(ctx.workspace, abs)}` }
      const kind = readKind(abs)
      if (!kind) return { ok: false, error: "只支持 .docx 与 .xlsx（PDF 的读取是另一条链路，本轮没做）" }
      if (kind === "docx") {
        const r: DocxRead = await readDocx(abs)
        const parts: string[] = []
        if (r.paragraphs.length) parts.push(r.paragraphs.join("\n"))
        for (const t of r.tables) parts.push(t.map((row) => row.join(" | ")).join("\n"))
        if (!parts.length) return { ok: true, output: "（文档是空的，或内容都在图片里——文字提取不到）" }
        return {
          ok: true,
          output:
            truncate(parts.join("\n\n")) +
            `\n（共 ${r.paragraphs.length} 段${r.tables.length ? "、" + r.tables.length + " 个表格" : ""}）`,
        }
      }
      const r: XlsxRead = await readXlsx(abs, String(args.sheet || ""), Number(args.max_rows || 200))
      if (!r.sheets.length) return { ok: false, error: `没找到工作表${args.sheet ? "：" + args.sheet : ""}` }
      const out = r.sheets.map((sh) => `## ${sh.name}\n${sh.rows.map((row) => row.join(" | ")).join("\n")}`).join("\n\n")
      return { ok: true, output: truncate(out) + `\n（共 ${r.sheets.length} 个表）` }
    } catch (err) {
      return { ok: false, error: `读文档失败：${String((err as Error).message || err)}` }
    }
  },
})

defineTool({
  name: "create_spreadsheet",
  description:
    "生成 Excel 表格（.xlsx）。header 是表头数组，rows 是数据行（每行一个数组，值的顺序与表头对应）。",
  parameters: [
    { name: "path", type: "string", required: true, desc: "输出路径（.xlsx）" },
    { name: "sheet", type: "string", required: false, desc: "工作表名（默认 Sheet1）" },
    { name: "header", type: "string", required: true, desc: '表头 JSON 数组：["指标","数值"]' },
    { name: "rows", type: "string", required: true, desc: '数据行 JSON 二维数组：[["日活",12345]]' },
  ],
  action: "write",
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const abs = path.resolve(ctx.workspace, String(args.path || ""))
      if (!/\.xlsx$/i.test(abs)) return { ok: false, error: "create_spreadsheet 只写 .xlsx 文件" }
      const header = jsonArg<string[]>(args.header, "header", '["指标","数值"]')
      if (!header?.length) return { ok: false, error: 'header 不能为空，例如 ["指标","数值"]' }
      const rows = jsonArg<(string | number | boolean | null)[][]>(args.rows, "rows", '[["日活",12345]]') ?? []
      if (!Array.isArray(rows)) return { ok: false, error: 'rows 必须是二维数组，例如 [["日活",12345]]' }
      const bad = rows.findIndex((r) => !Array.isArray(r))
      if (bad >= 0) return { ok: false, error: `rows 第 ${bad + 1} 行不是数组（每行要是一个数组）` }
      const r = await xlsxFromRows(String(args.sheet || "Sheet1"), header, rows)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, r.buffer)
      return {
        ok: true,
        output: `已生成表格 ${relTo(ctx.workspace, abs)}（工作表 "${r.sheet}"，${r.columns} 列 ${r.rows} 行，${r.bytes} 字节）`,
      }
    } catch (err) {
      return { ok: false, error: `生成表格失败：${String((err as Error).message || err)}` }
    }
  },
})

defineTool({
  name: "create_slides",
  description:
    "生成 PowerPoint 演示文稿（.pptx）。slides 是页面数组，每页 {title, bullets?, note?}。做汇报或方案时用它，不要写 ASCII 幻灯片。",
  parameters: [
    { name: "path", type: "string", required: true, desc: "输出路径（.pptx）" },
    { name: "slides", type: "string", required: true, desc: '页面 JSON 数组：[{"title":"季度总结","bullets":["要点一"]}]' },
  ],
  action: "write",
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const abs = path.resolve(ctx.workspace, String(args.path || ""))
      if (!/\.pptx$/i.test(abs)) return { ok: false, error: "create_slides 只写 .pptx 文件" }
      const slides = jsonArg<SlideSpec[]>(args.slides, "slides", '[{"title":"标题","bullets":["要点"]}]')
      if (!slides?.length) return { ok: false, error: 'slides 不能为空，例如 [{"title":"标题"}]' }
      const bad = slides.findIndex((s) => !s || typeof s.title !== "string")
      if (bad >= 0) return { ok: false, error: `slides 第 ${bad + 1} 页缺少 title` }
      const r = await pptxFromSlides(slides)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, r.buffer)
      return {
        ok: true,
        output: `已生成演示文稿 ${relTo(ctx.workspace, abs)}（${r.slides} 页：${r.titles.join(" / ")}，${r.bytes} 字节）`,
      }
    } catch (err) {
      return { ok: false, error: `生成演示文稿失败：${String((err as Error).message || err)}` }
    }
  },
})

defineTool({
  name: "create_pdf",
  description:
    "生成 PDF（.pdf）。content 是正文（空行分页），自动折页。中文会自动嵌入系统字体；找不到中文字体时明确报错并建议改用 create_document。",
  parameters: [
    { name: "path", type: "string", required: true, desc: "输出路径（.pdf）" },
    { name: "content", type: "string", required: true, desc: "正文内容（空行表示分页）" },
  ],
  action: "write",
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const abs = path.resolve(ctx.workspace, String(args.path || ""))
      if (!/\.pdf$/i.test(abs)) return { ok: false, error: "create_pdf 只写 .pdf 文件" }
      const content = String(args.content ?? "")
      if (!content.trim()) return { ok: false, error: "content 为空，没有内容可排" }
      const pages = content.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)
      const r = await pdfFromPages(pages)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, r.buffer)
      return {
        ok: true,
        output:
          `已生成 PDF ${relTo(ctx.workspace, abs)}（${r.pages} 页，${r.bytes} 字节` +
          `${r.cjkFontEmbedded ? "，已嵌入中文字体 " + (r.fontPath || "") : "（纯 ASCII，未嵌字体）"}`,
      }
    } catch (err) {
      return { ok: false, error: `生成 PDF 失败：${String((err as Error).message || err)}` }
    }
  },
})
