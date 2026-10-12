/**
 * Windows 上把「用户配置的命令」解析成**能直接 spawn**的形式。
 *
 * 根因：npm 装在 PATH 上的 `npx` 是 `npx.cmd`——一个批处理垫片。Node 的 `spawn`
 * 不带 shell 时既找不到无扩展名的 shim（`ENOENT`），也执行不了 `.cmd`（`EINVAL`）。
 * 表现就是：界面上装好的 npm 类 MCP 服务，在 Windows 上**一条都起不来**。
 *
 * 为什么不用 `shell: true`：它能跑，但 Node 会明确告警 `DEP0190`——参数不做转义
 * 只做拼接。MCP 的参数来自配置文件，交给命令行再解析一遍等于凭空开一个注入面。
 * 同理也不用 `cmd.exe /c` 当万能方案，只在**确实只能由 cmd 执行**时才用。
 *
 * 解析顺序：
 *  1. 能直接跑的 `.exe`（含绝对路径）→ 原样返回
 *  2. node 系垫片（npx / npm / pnpm / yarn / corepack）→ 换成 `node <bin>/xxx-cli.js`
 *     ——这正是 `.cmd` 内部做的事，绕开 shell
 *  3. 其它 `.cmd` / `.bat` → 才交给 `cmd.exe /d /s /c`，命令行按 Windows 规则加引号
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type SpawnOptions } from "node:child_process"

/**
 * MCP 服务打包目录的 node_modules 在哪。
 *
 * 目录里那 7 个 `npx -y <pkg>` 服务（真相源：`desktop-node/data/catalog.json` 的
 * plugins[].spec）被装进独立的 `apps/mcp-bundle`（不污染 agent-ts 的
 * "零依赖" 定位），随应用分发。运行时直接跑这里的本地副本，免去启动时的 npm 下载
 * （首启几十秒、网络差的机器更久，且每次启动都白等）。
 *
 * 布局：agent-ts 与 mcp-bundle 是**同级**（dev 在 `apps/`，打包在 `resources/`），
 * 所以 `agent-ts 目录的父级 / mcp-bundle / node_modules` 在两种环境下都成立。
 * 也可用 `EVA_MCP_BUNDLE` 显式指定一个 node_modules 目录（调试/自定义布局用）。
 */
function mcpBundleNodeModules(): string {
  const explicit = process.env.EVA_MCP_BUNDLE
  if (explicit && fs.existsSync(explicit)) return explicit
  const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  /* dev 态要用 **materialize 的实体化产物**（apps/desktop-node/.mcp-bundle/node_modules，
     由 pnpm pack/dist 前的 materialize_deps.mjs 生成，与打包后的 resources/mcp-bundle 同构）。
     不能指向 apps/mcp-bundle/node_modules：那是 pnpm 的**符号链接布局**，顶层只有
     @evawork/* 薄包，第三方包（@playwright/mcp 等）全在 .pnpm 里——tryLocalNpx
     按顶层路径找永远落空，于是退化成 npx 走网络，冷启几十秒，把 MCP 启动预算
     全部吃光。打包态 resources/ 下没有 desktop-node，自然回退到同级 mcp-bundle。 */
  const dev = path.join(path.dirname(agentDir), "desktop-node", ".mcp-bundle", "node_modules")
  if (fs.existsSync(dev)) return dev
  return path.join(path.dirname(agentDir), "mcp-bundle", "node_modules")
}

/** 把 `npx -y <pkg>` 解析成本地已分发包的入口；不是这种形态或本地没有就返回 null。 */
function tryLocalNpx(argv: string[]): { file: string; argv: string[] } | null {
  // 只处理 `npx -y <pkg> [rest]` / `npx --yes <pkg> [rest]`（MCP 服务最常见形态）。
  // `npx -p <pkg> -c "cmd"`（跑任意命令）那种不本地化，退回普通 npx。
  let i = 0
  if (argv[0] === "-y" || argv[0] === "--yes") i += 1
  else return null
  const pkg = argv[i]
  if (!pkg) return null
  if (argv[i + 1] === "-c" || argv[i + 1] === "--call") return null // 不是直接跑这个包
  const rest = argv.slice(i + 1)

  const pkgDir = path.join(mcpBundleNodeModules(), pkg)
  if (!fs.existsSync(pkgDir)) return null
  const bin = resolvePkgBin(pkgDir, pkg)
  if (!bin) return null
  // 用应用自带的 node 跑，保证和 agent 同一运行时
  return { file: process.execPath, argv: [bin, ...rest] }
}

/** 读包的 bin / main，定位真正可执行的入口绝对路径。 */
function resolvePkgBin(pkgDir: string, pkg: string): string | null {
  let meta: any
  try {
    meta = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"))
  } catch {
    return null
  }
  const pick = (bin: unknown): string | undefined => {
    if (typeof bin === "string") return bin
    if (bin && typeof bin === "object") {
      const scope = pkg.startsWith("@") ? pkg.split("/")[1] : pkg
      return (bin as Record<string, string>)[scope] || Object.values(bin as Record<string, string>)[0]
    }
    return undefined
  }
  for (const b of [pick(meta.bin), meta.main]) {
    if (typeof b === "string") {
      const abs = path.join(pkgDir, b)
      if (fs.existsSync(abs)) return abs
    }
  }
  return null
}

/** 这些命令在 Windows 上是 node 脚本的 `.cmd` 垫片，可以用 node 直接跑真实入口。 */
const NODE_SHIMS: Record<string, string> = {
  npx: "npx-cli.js",
  npm: "npm-cli.js",
  npx_cmd: "npx-cli.js",
}

/** 在 PATH 里找命令，返回能跑的那个绝对路径（找不到返回空串）。
 *
 *  **先按 PATHEXT 找，而不是先看无扩展名的同名文件**：npm 会在 PATH 上放一个
 *  没有扩展名的 `npx`（给 Unix shell 用的脚本），它在 Windows 上根本执行不了，
 *  被它先命中就是 `ENOENT`。真正的入口是 `npx.cmd` / `npx.exe`。
 */
function which(cmd: string): string {
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
  const hasSep = cmd.includes("/") || cmd.includes("\\")
  const dirs = hasSep ? [""] : (process.env.PATH || "").split(path.delimiter).filter(Boolean)
  const isFile = (p: string) => {
    try {
      return fs.existsSync(p) && !fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  for (const d of dirs) {
    const base = hasSep ? cmd : path.join(d, cmd)
    for (const e of exts) {
      const p = base + e
      if (isFile(p)) return p
    }
    // 只有在**自带扩展名**时才接受原样（如用户写的 foo.exe / 绝对路径）
    if (path.extname(base) && isFile(base)) return base
  }
  return ""
}

/** Windows 命令行引号规则：含空白或特殊字符才包引号，内部 `"` 用 `\"`。 */
function quoteArg(a: string): string {
  const s = String(a ?? "")
  if (!s) return '""'
  if (!/[\s"^&|<>();,]/.test(s)) return s
  return `"${s.replace(/"/g, '\\"')}"`
}

/** 把 `(cmd, args)` 变成真正可 spawn 的 `(file, argv)`。 */
export function resolveCommand(cmd: string, args: string[] = []): { file: string; argv: string[] } {
  const command = String(cmd || "").trim()
  const argv = (args || []).map(String)

  // 本地已分发的 MCP 服务：npx -y <pkg> 直接跑 node_modules 里的本地副本，免去下载。
  // 本地没有（比如用户自配了个没打包的包）就退回下面的普通解析（仍可能去 npm 下载）。
  if (command === "npx") {
    const local = tryLocalNpx(argv)
    if (local) return local
  }

  if (process.platform !== "win32") return { file: command, argv }

  const found = which(command)
  // 1) 找到且不是批处理 → 直接跑
  if (found && !/\.(cmd|bat)$/i.test(found)) return { file: found, argv }

  // 2) node 系垫片：换成 `node <cli.js>`；找不到入口就继续往下走
  const stem = path.basename(command).toLowerCase().replace(/\.(cmd|bat|exe)$/i, "")
  const cli = NODE_SHIMS[stem]
  if (cli) {
    const nodeDir = path.dirname(process.execPath)
    const entry = path.join(nodeDir, "node_modules", "npm", "bin", cli)
    if (fs.existsSync(entry)) return { file: process.execPath, argv: [entry, ...argv] }
  }

  // 3) 确实是 .cmd/.bat（或压根没找到，交给 cmd 去报"不是内部命令"，比 ENOENT 清楚）
  const line = [found ? quoteArg(found) : quoteArg(command), ...argv.map(quoteArg)].join(" ")
  return { file: "cmd.exe", argv: ["/d", "/s", "/c", line] }
}

/** 替代直接 `spawn()`：先解析命令再起进程，签名与 `spawn` 一致。 */
export function spawnResolved(
  cmd: string,
  args: string[] = [],
  opts: SpawnOptions = {},
) {
  const { file, argv } = resolveCommand(cmd, args)
  return spawn(file, argv, opts)
}
