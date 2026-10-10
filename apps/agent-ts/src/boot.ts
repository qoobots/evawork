// 启动装配清单（TS-050）：运行时由**一张清单**决定，换配置即换能力组合，不改代码。
//
// 为什么值得单独做一层：现在可选模块已经有六个（MCP、后台任务、计划、子代理、技能、
// 持久终端），每个都在 `cli.ts` / `sdk.ts` 里 `registerXxx()` 一遍，
// 两边随时会漂移成"命令行有、界面没有"。清单把它们收在一处：**两个入口读同一张清单**。
//
// 刻意不做成插件系统：没有动态 import 的白名单机制，就不假装支持任意第三方模块——
// 那只是把"能不能装"的问题换成"装了能不能信"的问题。

import fs from "node:fs"
import path from "node:path"
import { DEFAULT_MAX_STEPS } from "./budget.ts"
import { homeDir } from "./session.ts"
import { allTools, findTool, installMcpTools, stopMcp } from "./tools.ts"
import { registerDelegateTool } from "./subagent.ts"
import { registerJobTools } from "./jobs.ts"
import { registerOfficeTools } from "./office-tools.ts"
import { SystemPrompt } from "./prompt.ts"
import { telemetry } from "./telemetry.ts"

export const MANIFEST_VERSION = 1

export interface BootManifest {
  version: number
  /** 默认轮次上限 */
  maxSteps: number
  /** 从暴露给模型的工具里剔除的名字 */
  exclude: string[]
  modules: {
    /** 接外部 MCP 服务 */
    mcp: boolean
    /** 后台任务工具（job_*） */
    jobs: boolean
    /** 子代理委派（delegate） */
    subagent: boolean
    /** 遥测（只记数字与名字，不记内容） */
    telemetry: boolean
    /** 办公文档四件套（docx/xlsx/pptx/pdf 读写）：默认关，开后才注册这 5 个工具 */
    office: boolean
  }
  prompt: {
    /** 去掉这些分节 */
    remove: string[]
    /** 把这些分节换成指定文本 */
    set: Record<string, string>
  }
}

/** 一个 turn 的默认轮次上限。
 *  此前散成 7 处硬编码的 `12`（清单 / CLI 两处 / loop / guard / 主进程 core），
 *  改一次要动六个文件，漏一处就出现"界面改了、子进程没改"。
 *  12 太紧：真实任务经常在第 12 步被截断，用户只能点「继续」再发一轮。
 *
 *  现在默认 30：简单任务通常几步就完，不必硬跑满；复杂任务可由模型通过
 *  `set_max_steps` 主动申请扩展到硬顶 `MAX_STEPS_HARD_CAP`。 */
// 常量本体在 budget.ts（叶子模块）：boot ↔ tools 是循环依赖，常量放这里会被
// tools.ts 顶层读到未初始化的绑定，ts-agent 直接起不来。详见 budget.ts 注释。
export { DEFAULT_MAX_STEPS }
export { MAX_STEPS_HARD_CAP } from "./budget.ts"

export const DEFAULT_MANIFEST: BootManifest = {
  version: MANIFEST_VERSION,
  maxSteps: DEFAULT_MAX_STEPS,
  exclude: [],
  modules: { mcp: true, jobs: true, subagent: true, telemetry: true, office: false },
  prompt: { remove: [], set: {} },
}

/** 清单文件：`~/.evawork/ts-agent/boot.json`，可用 --boot 指定别处。 */
export function manifestPath(): string {
  return path.join(homeDir(), "boot.json")
}

/**
 * 读清单：文件里**只写差异**，缺的字段用默认值补。
 * 版本不对就整个退回默认——半新半旧地合并，比全用默认更危险。
 */
export function loadManifest(file?: string): BootManifest {
  const p = file || manifestPath()
  let raw: Partial<BootManifest> = {}
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<BootManifest>
  } catch {
    return { ...DEFAULT_MANIFEST }
  }
  if (raw.version !== undefined && raw.version !== MANIFEST_VERSION) {
    return { ...DEFAULT_MANIFEST }
  }
  return {
    ...DEFAULT_MANIFEST,
    ...raw,
    modules: { ...DEFAULT_MANIFEST.modules, ...(raw.modules || {}) },
    prompt: {
      remove: raw.prompt?.remove || [],
      set: raw.prompt?.set || {},
    },
    exclude: raw.exclude || [],
  }
}

export interface BootedRuntime {
  manifest: BootManifest
  prompt: SystemPrompt
  /** 真正暴露给模型的工具名（已剔除 exclude） */
  tools: string[]
  /** MCP 接上了几个工具 */
  mcpTools: number
  /** 收尾：关掉 MCP 子进程 */
  stop(): void
}

/** 每个可选模块带来的工具：模块关掉就**不暴露**（注册过也不给模型用）。 */
const MODULE_TOOLS: Record<string, string[]> = {
  jobs: ["job_start", "job_status", "job_wait", "job_cancel"],
  subagent: ["delegate"],
}

/** 可选模块只注册一次：重复注册会在 defineTool 处"工具重名"直接抛。 */
function once(name: string, fn: () => void): void {
  if (!findTool(name)) fn()
}

/** 按清单装配：注册可选模块、接 MCP、裁剪提示词、算出暴露的工具名单。 */
export async function applyManifest(m: BootManifest): Promise<BootedRuntime> {
  // 遥测可关：它是"可观测"，不是"必须有"；关掉不影响任何功能
  if (!m.modules.telemetry) telemetry.disable()
  if (m.modules.subagent) once("delegate", registerDelegateTool)
  if (m.modules.jobs) once("job_start", registerJobTools)
  if (m.modules.office) once("create_document", registerOfficeTools)

  const mcpTools = m.modules.mcp ? await installMcpTools() : 0

  const prompt = new SystemPrompt()
  for (const id of m.prompt.remove) prompt.remove(id)
  for (const [id, body] of Object.entries(m.prompt.set)) prompt.setText(id, body)

  const excluded = new Set(m.exclude)
  // 关掉的模块：它带来的工具一律不进暴露名单（注册过也不给模型用）
  for (const [mod, names] of Object.entries(MODULE_TOOLS)) {
    if (!m.modules[mod as keyof BootManifest["modules"]]) for (const n of names) excluded.add(n)
  }
  const tools = allTools().map((t) => t.name).filter((n) => !excluded.has(n))

  return {
    manifest: m,
    prompt,
    tools,
    mcpTools,
    stop: stopMcp,
  }
}

/** 一步到位：读清单 + 装配。命令行与 SDK 两个入口都走这里，避免能力组合漂移。 */
export async function boot(file?: string): Promise<BootedRuntime> {
  return applyManifest(loadManifest(file))
}
