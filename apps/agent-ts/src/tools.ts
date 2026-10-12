// 工具注册表与执行管线。
//
// 审批与沙箱路径约束已移除：所有工具一律放行，不再二次确认。
// `pre-execute` 只做"工具是否存在"的校验，避免模型反复猜一个不存在的工具名。

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { egressFetch } from "./egress.ts"
import { WorkspaceTerminal } from "./terminal.ts"
import type { TermResult } from "./terminal.ts"
import { McpClient, loadMcpConfig, mcpToolName } from "./mcp.ts"
import type { McpServerConfig } from "./mcp.ts"
import { builtinSkillList, loadSkillByName } from "./skills.ts"
import { classifyAction } from "./classifier.ts"
import { classifierOn } from "./settings.ts"
import type { LlmConfig, ToolAction, ToolContext, ToolDef, ToolParam, ToolResult } from "./types.ts"

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

/**
 * delegate 返回给主任务的**结论上限**（文档 19 P0-2[15]）。
 *
 * 子代理自己的工具输出各有限额，但结论本身此前没有——一个话多的子代理能把
 * 几万字直接灌进主上下文，"派个人去省上下文"就变成"派个人来撑爆上下文"。
 * 设得比 MAX_OUTPUT 大：结论是压缩过的要点，值得多留位置；截断时明说
 * "完整内容见子代理 trace"，别让模型以为结论就这么多。
 */
export const MAX_DELEGATE_OUTPUT = 30_000

/** 输出截断：工具返回过长时只保留前 N 字符，避免撑爆上下文。 */
export const truncate = (s: string, n = MAX_OUTPUT): string =>
  s.length > n ? `${s.slice(0, n)}\n…（已截断，共 ${s.length} 字符）` : s

/** 给展示用的相对路径（与 office-tools 同一口径：正斜杠，越界也只是相对化）。 */
function relPath(workspace: string, abs: string): string {
  const rel = path.relative(path.resolve(workspace), abs)
  return rel.replace(/\\/g, "/") || "."
}

/**
 * 写类工具的覆盖警示（文档 19 P0-2[17]）。
 *
 * 目标已存在时在 output 里追加一行"覆盖了已有文件"，让模型**知道刚刚发生了什么**——
 * 它不知道就会接着做"增量修改"的打算，实际文件已被整体替换。
 * 刻意**不阻断**：桌面端审批已移除，静默覆盖是既定语义，这里只做如实告知。
 * 后续若引入 per-turn read-set，可升级为"没读过就拒绝"的硬约束（风险 2 说的那一步）。
 */
export function overwriteWarning(abs: string, workspace: string): string {
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return `\n⚠ 覆盖了已有文件：${relPath(workspace, abs)}（内容已整体替换，不是追加）`
    }
  } catch {
    /* 状态读不出来就不声明覆盖与否，别把警示做成新的失败点 */
  }
  return ""
}

/**
 * 路径类参数的归一化（文档 19 P2-14）。
 *
 * Windows 上模型高频交出 `src\\components\\App.tsx`：`path.resolve` 其实吃反斜杠，
 * 真正栽的是 **glob / 展示 / 比较**那些按 `/` 分段的环节，以及模型下一轮拿到的
 * 回执路径与它给的路径写法不一致。统一在 executeTool 入口把路径类键转成正斜杠，
 * 工具层兜底，模型不必学转义。只动"看起来是路径"的键名，命令正文绝不碰
 * （PowerShell 里 `\` 有正则转义等别用）。
 */
const PATH_KEY = /(^|_)(path|file|file_path|filepath|dir|directory|cwd|root)$/i
export function normalizePathArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (process.platform !== "win32") return args
  let touched = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && PATH_KEY.test(k.toLowerCase()) && v.includes("\\")) {
      out[k] = v.replace(/\\/g, "/")
      touched = true
    } else {
      out[k] = v
    }
  }
  return touched ? out : args
}

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
  description:
    "执行一条 shell 命令（Windows 走 PowerShell，其它平台走 /bin/sh）。" +
    "不要用它读文件、搜文件名或找内容——read_file / glob_files / search_text 的输出格式稳定，" +
    "而 cat/find/grep 在不同平台语义不同、还撞编码问题。也不要用它起长时间任务（会白等到超时），慢活用 job_start 扔后台。" +
    "运行时注意：cwd 固定为工作区根，**每条命令都重置回去**（要跨命令保持目录用 terminal）；" +
    "超时硬顶 120000ms，超时或被取消只 kill 直接子进程、进程树孙进程可能残留；输出超 20000 字符截断。",
  parameters: [
    { name: "command", type: "string", required: true, desc: "要执行的命令" },
    { name: "timeout_ms", type: "number", required: false, desc: "超时毫秒：默认 30000，最小 1000，最大 120000" },
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
    "抓取一个 URL 的内容（走统一出口，受 EVA_EGRESS_ALLOWLIST 约束），返回纯文本摘要。" +
    "不适合：需要登录/认证的私有页（没有 cookie/token，拿到的多半是登录墙）。" +
    "HTML 只做极简去标签（script/style/标签移除），不做完整 DOM 解析——重脚本的 SPA 页拿不到渲染后的内容。" +
    "超大内容会被截断（max_chars 默认 8000，上限 50000）。",
  parameters: [
    { name: "url", type: "string", required: true, desc: "完整 URL（http/https）" },
    { name: "max_chars", type: "number", required: false, desc: "最多返回多少字符：默认 8000，上限 50000" },
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

// ---- 内置技能加载（对齐 Claude Code 的 Skill 工具）----
// 系统提示里只注入技能"名称 + 描述"，正文在模型判定命中后由本工具按需加载进本轮，
// 避免 15 个技能正文常驻吃掉上下文预算。

defineTool({
  name: "load_skill",
  description:
    "按名称加载一个技能的完整说明（SKILL.md 正文）。当任务与系统提示「可用技能」清单里的某项匹配时调用，加载后按它的指示执行。" +
    "同一技能本轮只加载一次：已加载过的再调只返回一句提示，不重复给正文（正文这时还在上下文里）。" +
    "skill 参数是清单里的名字原样；猜出来的名字会报错并列出全部可用技能，**不要凭印象造名字**。",
  parameters: [
    { name: "skill", type: "string", required: true, desc: "技能名（清单原样，不含斜杠/冒号），如 brainstorming、code-review" },
  ],
  action: "read",
  async execute(args, ctx): Promise<ToolResult> {
    const name = String(args.skill || "").trim()
    if (!name) return { ok: false, error: "缺少 skill 参数" }
    // 非法名**明确拒绝**（文档 19 P1-9[4]）：名字会被拼进目录路径，
    // 放过 `../x` 或带分隔符的输入就不是"查不到"的问题，是路径问题。
    // 作用域寻址（`apps/web:deploy`）暂未实现——技能目录是平铺的，冒号一律拒绝，
    // 错误信息里说清，别让模型以为换个写法就有了。
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      return {
        ok: false,
        error: `非法技能名：${name}（只允许字母数字开头、可含 . _ -，≤64 字符；不带斜杠/冒号——技能目录是平铺的，没有"路径:名字"寻址）`,
      }
    }
    // 幂等保护（P1-9[3]）：本轮加载过的直接回提示。正文是否"真的还在上下文"不保证
    // （可能已被压缩），但重加载的代价是整份正文再吃一次预算，宁可赌它还在。
    if (ctx.loadedSkills?.has(name)) {
      return { ok: true, output: `（${name} 本轮已加载过，正文在上下文里，不必重复加载；若确实找不回了——例如被压缩掉了——再调一次即可）` }
    }
    const body = loadSkillByName(name)
    if (!body) {
      const available = builtinSkillList().map((s) => s.name).join(", ")
      return { ok: false, error: `没有这个技能：${name}。可用：${available || "（空——当前没有任何技能目录可读）"}` }
    }
    ctx.loadedSkills?.add(name)
    return { ok: true, output: body }
  },
})

// ---- 持久终端（TS-034）----

const terminals = new Map<string, WorkspaceTerminal>()

/**
 * 取消包装（terminal 路径专用）：signal 触发而底层 Promise 还没跑完 → **不再等它**，
 * 当场返回取消结果。`WorkspaceTerminal.run` 不暴露子进程句柄，外面 kill 不掉，
 * 所以这里的取消语义是"主循环不等了"，进程自己按超时收尾——
 * 后果用 `note` 如实写进返回（与 run_command 的"只 kill 直接子进程"同一诚实口径）。
 */
function withCancel(run: Promise<TermResult>, signal: AbortSignal | undefined, note: string): Promise<TermResult> {
  if (!signal) return run
  const cancelled = (): TermResult => ({ ok: false, output: `已取消（${note}）`, cwd: "" })
  if (signal.aborted) return Promise.resolve(cancelled())
  return new Promise((resolve) => {
    const settle = (r: TermResult): void => {
      signal.removeEventListener("abort", onAbort)
      resolve(r)
    }
    const onAbort = (): void => settle(cancelled())
    signal.addEventListener("abort", onAbort, { once: true })
    // run() 的错误路径都是 resolve（不 reject）；reject 只可能来自实现漂移，兜住它别漏监听器
    run.then(settle, (e) => settle({ ok: false, output: `执行异常：${String(e)}`, cwd: "" }))
  })
}

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
    "在持久终端里执行命令：**当前目录跨命令保持**——这是它与 run_command 的全部区别" +
    "（run_command 每条都重置回工作区根；连续 cd 后跑一串命令用本工具，单次命令用 run_command）。" +
    "不支持交互式命令：没有 TTY，vim / REPL / 等输入的程序会挂到超时为止。" +
    "输出同样受 20000 字符截断；结果末尾附 [cwd] 告诉你下一次从哪开始。每个工作区一个终端实例。",
  parameters: [
    { name: "command", type: "string", required: true, desc: "要执行的命令" },
    { name: "timeout_ms", type: "number", required: false, desc: "超时毫秒：默认 30000，上限 120000" },
  ],
  action: "command",
  async execute(args, ctx): Promise<ToolResult> {
    const cmd = String(args.command || "").trim()
    if (!cmd) return { ok: false, error: "命令为空" }
    const ms = Math.min(Math.max(Number(args.timeout_ms) || 30_000, 1000), 120_000)
    const t = termFor(ctx.workspace)
    const r = await withCancel(t.run(cmd, ms), ctx.signal, "持久终端按其超时自行清理")
    // 把当前目录带回给模型：它要知道"下一次从哪开始"，否则只能靠猜。
    // 取消路径的 r.cwd 是空的，落回终端实例的真实目录——别报一个假"[cwd] "空串。
    const cwd = r.cwd || t.currentDir
    return r.ok
      ? { ok: true, output: `${r.output}\n[cwd] ${cwd}` }
      : { ok: false, error: `${r.output}\n[cwd] ${cwd}` }
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
  return Object.entries(props).map(([k, v]) => {
    const type = jsonSchemaType(v)
    const desc = String((v as any)?.description || k)
    // 参数说明里带上类型（P0-2[4]）：联合类型已被收敛成一枝（见 jsonSchemaType），
    // 模型看 schema 时未必对得上"我给的这个值到底算什么形"，文字里再说一遍最便宜。
    return { name: k, type, required: required.has(k), desc: `${desc}（类型：${type}）` }
  })
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
          // 前缀标来源（对齐 Claude Code 的 mcp__server__tool 展示），后缀一句使用说明：
          // 参数以服务端 schema 为准、失败原因原样回传——外部工具的"坑"我们替不了它说。
          description: `[MCP:${cfg.name}] ${t.description || t.name}。注意：这是外部 MCP 服务提供的工具，参数格式以服务端 schema 为准；调用失败时错误信息原样返回，重试前先读错误。`,
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

/**
 * 执行前的统一判定。
 *
 * 工具不存在也要**明确拒绝并把可用名字带回去**——静默放行或只回一句"工具不存在"，
 * 模型会继续猜，猜错的名字还会再错一轮。
 *
 * 审批与沙箱路径约束已移除：工具一律放行，不再二次确认（TS 精简）。
 * 唯一的例外是**动作安全分类器**（文档 19 P1-8）：默认关，开了才生效，
 * 且只看 `command` 类动作（命令是最宽的破坏面）——判定细节与 fail-closed 语义在 classifier.ts。
 *
 * `probe.cfg` 是分类通道：没给就别开分类（调用方多半是测试/离线路径，
 * 而不是"分类器判定为放行"——静默放行才是这里最坏的错法）。
 */
export async function preExecute(
  name: string,
  rawArgs: Record<string, unknown>,
  probe: { cfg?: LlmConfig; signal?: AbortSignal } = {},
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
  /* 分类器看的是**原始** args（路径归一化在 executeTool 入口，见 normalizePathArgs）：
     它判的是"这条命令要干什么"，与路径写法无关。 */
  if (tool.action === "command" && classifierOn()) {
    const v = await classifyAction(name, rawArgs, probe.cfg, probe.signal)
    if (v.block) {
      return { allowed: false, action: tool.action, reason: v.reason, tool, args: rawArgs }
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

// ---------------- 文件工具（读写 / 检索） ----------------
//
// 为什么必须补这一组（文档 19 P0-5 风险 1）：此前"写个文件"要靠 run_command 拼 shell——
// 引号转义、编码、换行符处处是坑，而记忆协议要求"每拿到关键结论就落盘"、
// 只读子代理要求"批量检索不碰环境"，两边都建立在**稳定**的读写之上。
// 读取统一走 decodeCmdBytes（UTF-8 严格失败才落 GBK——中文机器上不是 UTF-8 的源码是常态）。

/** 单文件整体读取的上限（字节）：再大的文件就该 offset/limit 或命令行分段处理。 */
const READ_FILE_MAX_BYTES = 4_000_000
/** 单次默认最多读多少行（与 Claude Code 同口径：2000 行读不够再 offset 续）。 */
const READ_FILE_MAX_LINES = 2_000
/** 检索类工具跳过的目录：它们动辄几十万文件，进去走一遍既慢又没意义。 */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "__pycache__",
  ".venv", "venv", ".next", "coverage", "target", ".svelte-kit",
])
/** 隐藏目录默认跳过，但工作区里"以点开头又该被搜到"的这几个例外。 */
const DOT_DIRS_KEPT = new Set([".evawork", ".claude", ".github", ".vscode"])
/** 文件数上限（glob / 搜索）：到顶就明说截断，静默少结果比没有结果更坏。 */
const WALK_FILE_CAP = 5_000
/** 单文件搜索读取上限（字节）：二进制与巨型文件在这里挡掉。 */
const SEARCH_FILE_MAX_BYTES = 2_000_000

/** 二进制粗判：前 8KB 出现 NUL 字节就不当文本处理（够挡住图片/压缩包/exe）。 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8_192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** 目录该不该跳过（检索类工具共用）。 */
function skipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || (name.startsWith(".") && !DOT_DIRS_KEPT.has(name))
}

/**
 * glob → 正则（够用主义，零依赖）。
 *
 * 支持 `**`（跨目录，含零段）、`*`（目录内）、`?`、`[...]` 字符类；
 * `{a,b}` 展开**不支持**（模型常写，落到字面量去——不支持的写法在描述里说了）。
 * 不含 `/` 的模式（如 `*.ts`）按"任意深度"匹配——模型的直觉是这个，
 * 而不是严格"仅根目录"（真只要根目录就写 `/*.ts` 前缀？不，写 `./`? 算了：
 * 精确形状交给带斜杠的模式）。
 */
function globToRegex(glob: string): RegExp | null {
  const s = String(glob || "").replace(/\\/g, "/").replace(/^\.\//, "")
  const src = s.includes("/") ? s : `**/${s}`
  let re = "^"
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === "*") {
      if (src[i + 1] === "*") {
        i++
        // `**/` → 任意个目录段（可为零）；孤悬的 `**` → 任意剩余
        if (src[i + 1] === "/") {
          i++
          re += "(?:[^/]+/)*"
        } else {
          re += ".*"
        }
      } else {
        re += "[^/]*"
      }
    } else if (c === "?") {
      re += "[^/]"
    } else if (c === "[") {
      // 有闭合就整段当字符类原样搬（[a-z0-9] 这类）；没有闭合就按字面量 [
      const close = src.indexOf("]", i + 1)
      if (close > i + 1) {
        re += src.slice(i, close + 1)
        i = close
      } else re += "\\["
    } else if (".+^$(){}|\\/".includes(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
  }
  re += "$"
  try {
    return new RegExp(re, process.platform === "win32" ? "i" : "")
  } catch {
    // 字符类内容撞了正则语法：整个模式退回**字面量**匹配，别抛
    try {
      return new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, process.platform === "win32" ? "i" : "")
    } catch {
      return null
    }
  }
}

/** 深度优先遍历 root 下的文件，回相对路径（正斜杠）。到上限就停并如实说截断。 */
function* walkFiles(root: string, cap: number): Generator<{ rel: string; abs: string }, void, unknown> {
  let n = 0
  const stack: string[] = [root]
  while (stack.length) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // 没权限 / 悬空符号链接：跳过，不让整个检索失败
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!skipDir(e.name) && stack.length < 512) stack.push(abs)
        continue
      }
      if (!e.isFile()) continue
      if (++n > cap) return
      yield { rel: path.relative(root, abs).replace(/\\/g, "/"), abs }
    }
  }
}

defineTool({
  name: "read_file",
  description:
    `读文本文件，带行号（cat -n 式）。大文件用 offset/limit 分段读，一次最多 ${READ_FILE_MAX_LINES} 行、单文件超 4MB 直接拒读。` +
    "编码自动判定（UTF-8 失败落 GBK），中文乱码不该由你操心。二进制（图片/压缩包/exe）读不了；" +
    ".docx/.xlsx 用 read_document。不要用 run_command 跑 cat/head/tail 来读文件。",
  parameters: [
    { name: "path", type: "string", required: true, desc: "文件路径（相对工作区或绝对路径）" },
    { name: "offset", type: "number", required: false, desc: "起始行号（1 起），默认 1" },
    { name: "limit", type: "number", required: false, desc: `最多读多少行，默认 ${READ_FILE_MAX_LINES}` },
  ],
  action: "read",
  execute(args, ctx): ToolResult {
    const rel = String(args.path || "")
    if (!rel) return { ok: false, error: "缺少 path" }
    const abs = path.resolve(ctx.workspace, rel)
    if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在：${rel}（工作区根：${path.resolve(ctx.workspace)}；路径里的斜杠方向不用改，工具会归一）` }
    const st = fs.statSync(abs)
    if (st.isDirectory()) return { ok: false, error: `这是一个目录：${rel}。列目录用 list_dir` }
    if (st.size > READ_FILE_MAX_BYTES) return { ok: false, error: `文件过大（${st.size} 字节 > ${READ_FILE_MAX_BYTES}）：用 offset/limit 分段，或对大文本用 run_command 的流式命令` }
    const buf = fs.readFileSync(abs)
    if (looksBinary(buf)) return { ok: false, error: `看起来是二进制文件，不支持直接读：${rel}（.docx/.xlsx 用 read_document）` }
    const lines = decodeCmdBytes(buf).split(/\r?\n/)
    const start = Math.max(Number(args.offset) || 1, 1)
    const count = Math.min(Number(args.limit) || READ_FILE_MAX_LINES, READ_FILE_MAX_LINES)
    const end = Math.min(start + count - 1, lines.length)
    const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(6, " ")}\t${l}`).join("\n")
    const more = end < lines.length ? `\n…（读到第 ${end} 行，共 ${lines.length} 行；续读用 offset=${end + 1}）` : ""
    return { ok: true, output: truncate(body || "（该范围没有内容）") + more }
  },
})

defineTool({
  name: "write_file",
  description:
    "写文本文件（UTF-8）。整文件写入：目标已存在会**直接覆盖**并在结果里警示——改已有文件优先用 edit_file 做定点替换，" +
    "确实要整体重写才用本工具。父目录自动创建，不要先 mkdir。持久记忆（.evawork/memory/ 下的文件）与索引就用本工具写。" +
    "追加模式传 append=1。",
  parameters: [
    { name: "path", type: "string", required: true, desc: "文件路径（相对工作区或绝对路径）" },
    { name: "content", type: "string", required: true, desc: "完整内容（UTF-8 写出）" },
    { name: "append", type: "number", required: false, desc: "非 0 = 追加到文件末尾而不是覆盖" },
  ],
  action: "write",
  execute(args, ctx): ToolResult {
    const rel = String(args.path || "")
    if (!rel) return { ok: false, error: "缺少 path" }
    if (typeof args.content !== "string") return { ok: false, error: "缺少 content（传空串表示写入空文件，这是明确意图）" }
    const abs = path.resolve(ctx.workspace, rel)
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      if (Number(args.append) > 0) {
        fs.appendFileSync(abs, args.content, "utf8")
        return { ok: true, output: `已追加 ${Buffer.byteLength(args.content, "utf8")} 字节 → ${relPath(ctx.workspace, abs)}` }
      }
      const warn = overwriteWarning(abs, ctx.workspace)
      fs.writeFileSync(abs, args.content, "utf8")
      return { ok: true, output: `已写入 ${relPath(ctx.workspace, abs)}（${Buffer.byteLength(args.content, "utf8")} 字节）${warn}` }
    } catch (err) {
      return { ok: false, error: `写入失败：${String((err as Error).message || err)}` }
    }
  },
})

defineTool({
  name: "edit_file",
  description:
    "对已有文件做定点替换：old_string 必须在文件里**唯一命中**（多处相同要么带上文扩大上下文、要么传 replace_all=1）。" +
    "改前先 read_file 看清实际内容——空白与缩进差异是最常见的不命中原因。找不到不猜、不写回，报错如实回给你。",
  parameters: [
    { name: "path", type: "string", required: true, desc: "文件路径" },
    { name: "old_string", type: "string", required: true, desc: "要替换的原文（含足够上下文保证唯一）" },
    { name: "new_string", type: "string", required: true, desc: "替换后的文本（空串 = 删除这段）" },
    { name: "replace_all", type: "number", required: false, desc: "非 0 = 替换所有命中（默认要求唯一命中）" },
  ],
  action: "write",
  execute(args, ctx): ToolResult {
    const rel = String(args.path || "")
    const oldS = String(args.old_string ?? "")
    const newS = String(args.new_string ?? "")
    if (!rel) return { ok: false, error: "缺少 path" }
    if (!oldS) return { ok: false, error: "old_string 为空——删除段请用带内容的上下文，整体清空请用 write_file" }
    const abs = path.resolve(ctx.workspace, rel)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, error: `文件不存在：${rel}（新建用 write_file）` }
    const buf = fs.readFileSync(abs)
    if (looksBinary(buf)) return { ok: false, error: `二进制文件不支持定点替换：${rel}` }
    let text = decodeCmdBytes(buf)
    const all = Number(args.replace_all) > 0
    const count = (s: string, needle: string): number => {
      let n = 0
      for (let at = s.indexOf(needle); at >= 0; at = s.indexOf(needle, at + needle.length)) n++
      return n
    }
    let from = oldS
    let to = newS
    let n = count(text, oldS)
    if (n === 0 && /\r\n/.test(text)) {
      // 文件是 CRLF 而模型给的多半是 LF：换行符对齐一次再找（这是高频假失败，不该让模型重试）
      const crlfOld = oldS.replace(/\n/g, "\r\n")
      const m = count(text, crlfOld)
      if (m > 0) {
        from = crlfOld
        to = newS.replace(/\n/g, "\r\n")
        n = m
      }
    }
    if (n === 0) return { ok: false, error: `old_string 在 ${rel} 里找不到。先 read_file 核对实际内容（空白/缩进/换行差异最常见），再重试` }
    if (n > 1 && !all) return { ok: false, error: `old_string 命中 ${n} 处，不唯一：给更长的上下文，或确定要全换就传 replace_all=1` }
    const out = all ? text.split(from).join(to) : text.replace(from, to)
    try {
      fs.writeFileSync(abs, out, "utf8")
      return { ok: true, output: `已替换 ${all ? n : 1} 处 → ${relPath(ctx.workspace, abs)}` }
    } catch (err) {
      return { ok: false, error: `写回失败：${String((err as Error).message || err)}` }
    }
  },
})

defineTool({
  name: "list_dir",
  description:
    "列一个目录（单层，不递归）：目录带 /、文件给字节数。隐藏项**原样列出**（.evawork / .gitignore 这类要看得到）；" +
    "按名字模式找文件用 glob_files，翻多层结构用 glob_files 的 ** 模式。",
  parameters: [
    { name: "path", type: "string", required: false, desc: "目录路径，默认工作区根" },
  ],
  action: "read",
  execute(args, ctx): ToolResult {
    const abs = path.resolve(ctx.workspace, String(args.path || "."))
    if (!fs.existsSync(abs)) return { ok: false, error: `目录不存在：${relPath(ctx.workspace, abs)}` }
    if (!fs.statSync(abs).isDirectory()) return { ok: false, error: `不是目录：${relPath(ctx.workspace, abs)}（读文件用 read_file）` }
    let entries
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch (err) {
      return { ok: false, error: `列目录失败：${String((err as Error).message || err)}` }
    }
    const sorted = [...entries].sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    const CAP = 500
    const lines = sorted.slice(0, CAP).map((e) => {
      if (e.isDirectory()) return `${e.name}/`
      let size = ""
      try {
        size = ` (${fs.statSync(path.join(abs, e.name)).size} B)`
      } catch {
        /* 悬空链接之类：不带大小 */
      }
      return `${e.name}${size}`
    })
    const more = sorted.length > CAP ? `\n…（共 ${sorted.length} 项，只显示前 ${CAP}）` : ""
    return { ok: true, output: truncate(lines.join("\n") || "（空目录）") + more }
  },
})

defineTool({
  name: "glob_files",
  description:
    "按 glob 模式找文件：`**/*.ts`、`src/**/*.tsx`、`*.py`（不含 / 的模式按任意深度）。支持 * ? ** 与 [字符类]，不支持 {a,b} 展开。" +
    "跳过 node_modules/.git/dist 这类大目录。返回相对路径（正斜杠）。找**文件名**用它，找**内容**用 search_text。",
  parameters: [
    { name: "pattern", type: "string", required: true, desc: "glob 模式，如 **/*.md" },
    { name: "path", type: "string", required: false, desc: "搜索根目录，默认工作区根" },
  ],
  action: "read",
  execute(args, ctx): ToolResult {
    const rx = globToRegex(String(args.pattern || ""))
    if (!rx) return { ok: false, error: `glob 模式解析失败：${String(args.pattern || "")}` }
    const root = path.resolve(ctx.workspace, String(args.path || "."))
    if (!fs.existsSync(root)) return { ok: false, error: `目录不存在：${relPath(ctx.workspace, root)}` }
    const hits: string[] = []
    let capped = false
    for (const f of walkFiles(root, WALK_FILE_CAP + 1)) {
      if (rx.test(f.rel)) hits.push(f.rel)
      if (hits.length > 1_000) {
        capped = true
        break
      }
    }
    if (!hits.length) return { ok: true, output: `（没有匹配：${String(args.pattern || "")}）` }
    hits.sort()
    return {
      ok: true,
      output: truncate(hits.join("\n")) + (capped ? "\n…（结果超 1000 条已截断，缩小模式或换子目录）" : ""),
    }
  },
})

defineTool({
  name: "search_text",
  description:
    "在文件内容里搜文本（默认字面量、忽略大小写；正则要显式传 use_regex=1）。输出 `文件:行号: 内容`，跳过二进制、超 2MB 的文件与" +
    "node_modules/.git 这类目录。找内容用它，不要用 run_command 跑 grep/Select-String——编码与转义坑都在工具层背了。",
  parameters: [
    { name: "pattern", type: "string", required: true, desc: "要搜的文本（use_regex=1 时是正则）" },
    { name: "path", type: "string", required: false, desc: "搜索根目录，默认工作区根" },
    { name: "glob", type: "string", required: false, desc: "只看匹配此 glob 的文件，如 **/*.ts" },
    { name: "use_regex", type: "number", required: false, desc: "非 0 = pattern 按正则" },
    { name: "case_sensitive", type: "number", required: false, desc: "非 0 = 区分大小写" },
    { name: "max_results", type: "number", required: false, desc: "最多回多少条命中，默认 100" },
  ],
  action: "read",
  execute(args, ctx): ToolResult {
    const raw = String(args.pattern || "")
    if (!raw) return { ok: false, error: "缺少 pattern" }
    let needle: string | RegExp
    if (Number(args.use_regex) > 0) {
      try {
        needle = new RegExp(raw, args.case_sensitive ? "" : "i")
      } catch (err) {
        return { ok: false, error: `正则不合法：${String((err as Error).message || err)}` }
      }
    } else {
      needle = raw.toLowerCase()
    }
    const filterRx = args.glob ? globToRegex(String(args.glob)) : null
    const root = path.resolve(ctx.workspace, String(args.path || "."))
    if (!fs.existsSync(root)) return { ok: false, error: `目录不存在：${relPath(ctx.workspace, root)}` }
    const max = Math.min(Math.max(Number(args.max_results) || 100, 1), 500)
    const hits: string[] = []
    let filesScanned = 0
    let skipped = 0
    for (const f of walkFiles(root, WALK_FILE_CAP + 1)) {
      if (filterRx && !filterRx.test(f.rel)) continue
      let st
      try {
        st = fs.statSync(f.abs)
      } catch {
        continue
      }
      if (st.size > SEARCH_FILE_MAX_BYTES) {
        skipped++
        continue
      }
      const buf = fs.readFileSync(f.abs)
      if (looksBinary(buf)) {
        skipped++
        continue
      }
      filesScanned++
      const lines = decodeCmdBytes(buf).split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const okHit =
          typeof needle === "string" ? line.toLowerCase().includes(needle) : needle.test(line)
        if (!okHit) continue
        hits.push(`${f.rel}:${i + 1}: ${line.trim().slice(0, 200)}`)
        if (hits.length >= max) {
          return {
            ok: true,
            output: `${truncate(hits.join("\n"), 20_000)}\n…（命中已达上限 ${max}，用 glob 缩小文件范围或加 max_results）`,
          }
        }
      }
    }
    if (!hits.length) {
      return { ok: true, output: `（没有命中：${raw}；扫了 ${filesScanned} 个文本文件${skipped ? `，跳过 ${skipped} 个超大/二进制` : ""}）` }
    }
    return { ok: true, output: truncate(hits.join("\n")) }
  },
})

export async function executeTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    // 路径归一化只在这一处入口做（见 normalizePathArgs）；分类器与审批看的都是**原始** args
    return await tool.execute(normalizePathArgs(args), ctx)
  } catch (err) {
    return { ok: false, error: `执行异常：${String(err)}` }
  }
}

