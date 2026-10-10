// CLI 入口：跑一个 turn。
//
//   node src/cli.ts --prompt "…" [--model qwen-plus] [--policy ask] [--interactive]
//
// 零依赖：不装 tsx，Node 22.18+ 直接跑 .ts（原生剥离类型）。
// 凭据走环境变量（EVA_AI_BASE_URL / EVA_AI_TOKEN），由启动方注入——
// TS agent 不去读 Python 版 evawork 的 SQLite 登录态，两套智能体存储各自独立。

import path from "node:path"
import os from "node:os"
import { spawn } from "node:child_process"
import { llmConfigFromEnv } from "./llm.ts"
import { SessionLog, homeDir, newSessionId } from "./session.ts"
import { applyManifest, loadManifest, DEFAULT_MAX_STEPS } from "./boot.ts"
import { exportSession, listSessions, searchSessions } from "./query.ts"
import type { ExportFormat } from "./query.ts"
import { renderMetrics } from "./telemetry.ts"
import { runTurn } from "./loop.ts"

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback
}
const has = (name: string): boolean => process.argv.includes(`--${name}`)

/** Node 的 permission model 路径匹配：必须**正斜杠 + 结尾斜杠**，
 *  写成 `D:\a\b` 时连它自己的子路径都会被拒（实测踩到）。 */
function toPosixDir(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/?$/, "/")
}

function permissionEnabled(): boolean {
  const p = (process as unknown as { permission?: { enabled?: boolean } }).permission
  return Boolean(p?.enabled)
}

/**
 * `--hardened`：用 Node 的 permission model 把**本进程**的写入锁在工作区 / 数据目录 / temp。
 *
 * 刻意**不授予** `--allow-child-process`——Node 官方警告它会让整个 permission model 失效
 * （子进程根本不受约束），所以 hardened 档下**命令工具不可用**。这是它的代价，也正是
 * 它的价值：真正被限制的是"agent 自己能往哪写"。
 *
 * 注意它**不等于** DSH 那种受限令牌 + ACL 的进程隔离：那条路要 CreateRestrictedToken /
 * Job Object / AppContainer，都得原生模块，零依赖做不到（见文档 TS-022 的阻塞说明）。
 */
async function runHardened(): Promise<never> {
  const ws = toPosixDir(arg("workspace") || process.cwd())
  const args = [
    "--permission",
    "--allow-fs-read=*",
    `--allow-fs-write=${ws}`,
    `--allow-fs-write=${toPosixDir(homeDir())}`,
    `--allow-fs-write=${toPosixDir(os.tmpdir())}`,
    path.resolve(process.argv[1]),
    ...process.argv.slice(2),
  ]
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    // 标记子进程，防止它再 re-exec 自己（无限套娃）
    env: { ...process.env, EVA_TS_HARDENED_CHILD: "1" },
  })
  // 信号必须转发给真正干活的那个进程，否则 stop 只能杀掉这层壳，子进程会残留
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      try { child.kill(sig) } catch { /* 已退出 */ }
    })
  }
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1))
  await new Promise(() => {}) // 活到子进程退出为止
  throw new Error("unreachable")
}

async function main(): Promise<void> {
  if (has("hardened") && !permissionEnabled() && !process.env.EVA_TS_HARDENED_CHILD) {
    await runHardened()
  }

  // --serve：进入 JSON-RPC over stdio 模式，供外部进程（桌面端/界面）驱动。
  // 此模式下 stdout 是协议通道，**不能有任何其他输出**（诊断走 stderr）。
  if (has("serve")) {
    const { serve } = await import("./sdk.ts")
    await serve({
      workspace: path.resolve(arg("workspace") || process.cwd()),
      maxSteps: Number(arg("max-steps", String(DEFAULT_MAX_STEPS))) || DEFAULT_MAX_STEPS,
      model: arg("model") || undefined,
    })
    return
  }

  /* 历史查询（TS-051）：不需要模型、不需要凭据，所以放在"要 prompt"之前——
     查历史是最常见的求助动作，不能因为没配凭据就查不了。 */
  // 遥测（TS-053）：关键指标可观测，同样不需要模型/凭据
  if (has("metrics")) {
    console.log(renderMetrics())
    process.exit(0)
  }

  if (has("sessions") || has("show") || has("search") || has("export")) {
    const fmt = (arg("format", "md") as ExportFormat) || "md"
    if (has("sessions")) {
      const all = listSessions()
      if (!all.length) console.log("（没有会话记录）")
      else for (const s of all) {
        console.log(`${s.id} | ${s.events} 事件 | ${s.steps} 步 | ${s.stop || "—"} | ${s.goal.slice(0, 60)}`)
      }
    } else if (has("show")) {
      console.log(exportSession(arg("show"), fmt))
    } else if (has("search")) {
      const hits = searchSessions(arg("search"))
      if (!hits.length) console.log("（没有命中）")
      else for (const h of hits) console.log(`${h.id}#${h.seq} ${h.type}: …${h.snippet}…`)
    } else {
      console.log(exportSession(arg("export"), fmt))
    }
    process.exit(0)
  }

  const prompt = arg("prompt")
  if (!prompt) {
    console.log(
      "用法: node src/cli.ts --prompt \"任务描述\" [选项]\n" +
        "必需环境变量: EVA_AI_BASE_URL（如 http://localhost:8080/api/ai/v1）、EVA_AI_TOKEN\n" +
        "选项:\n" +
        "  --model <id>        模型（**没有默认值**：由启动方注入 EVA_AI_MODEL，即后端裁决的结果）\n" +
        "  --workspace <dir>   工作区根，默认当前目录\n" +
        "  --hardened          加固档：用 Node permission model 锁住本进程写入范围，命令工具禁用\n" +
        `  --max-steps <n>     轮次上限，默认 ${DEFAULT_MAX_STEPS}\n` +
        "  --boot <file>       启动装配清单（默认 ~/.evawork/ts-agent/boot.json），可关模块/剔工具/改提示词\n" +
        "  --session <id>      复用会话 id（续跑）\n" +
        "  --json              只输出结构化结果\n" +
        "历史查询（TS-051，不需要模型）：\n" +
        "  --sessions                 列出全部会话\n" +
        "  --show <id> [--format md|json|jsonl]     导出一个会话\n" +
        "  --export <id> [--format …]  同上\n" +
        "  --search <term>            全文搜索历史",
    )
    process.exit(1)
  }

  const cfg = llmConfigFromEnv({ model: arg("model") || undefined })
  const workspace = path.resolve(arg("workspace") || process.cwd())
  const json = has("json")

  /* 启动清单（TS-050）：能力组合由一张清单决定。
     优先级：**命令行显式给的 > 清单 > 默认**，否则"改了清单不生效"会让人怀疑清单没被读。 */
  const manifest = loadManifest(arg("boot") || undefined)
  if (has("max-steps")) manifest.maxSteps = Number(arg("max-steps", String(DEFAULT_MAX_STEPS))) || DEFAULT_MAX_STEPS
  const booted = await applyManifest(manifest)

  const maxSteps = Math.max(1, booted.manifest.maxSteps)

  if (permissionEnabled()) {
    // 走 stderr：--serve 模式下 stdout 是协议通道，不能被污染
    console.error("[hardened] 已启用 Node permission model：本进程写入限于工作区/数据目录/temp，命令工具禁用")
  }

  if (booted.mcpTools && !json) console.log(`MCP: 已接入 ${booted.mcpTools} 个外部工具`)

  const log = new SessionLog(arg("session") || newSessionId())
  if (!json) console.log(`会话: ${log.id} | 模型: ${cfg.model} | 工作区: ${workspace}`)

  const controller = new AbortController()
  process.on("SIGINT", () => controller.abort())

  const t0 = Date.now()
  const res = await runTurn({
    prompt,
    cfg,
    workspace,
    log,
    systemPrompt: booted.prompt,
    tools: booted.tools,
    maxSteps,
    signal: controller.signal,
    onText: (s) => { if (!json) process.stdout.write(s) },
    onTool: (name, args, r) => {
      if (json) return
      console.log(`\n  [工具] ${name} ${JSON.stringify(args).slice(0, 160)} -> ${r?.ok ? "ok" : "失败"}`)
    },
  })

  if (json) {
    console.log(
      JSON.stringify(
        { session: log.id, steps: res.steps, stop: res.stopReason, note: res.note, text: res.text, ms: Date.now() - t0 },
        null,
        2,
      ),
    )
  } else {
    console.log(`\n--- ${res.stopReason} · ${res.steps} 步 · ${((Date.now() - t0) / 1000).toFixed(1)}s ---`)
    if (res.note) console.log(res.note)
  }
  booted.stop() // 不关的话 MCP 子进程会残留
  process.exit(res.stopReason === "completed" ? 0 : 2)
}

await main()
