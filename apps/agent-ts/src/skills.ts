// 内置技能：随应用分发、每段对话默认注入"可用清单"；命中时由 `load_skill` 按需加载正文。
//
// 设计对齐 Claude Code（见 .docs/16）：系统提示里只列"名称 + 一句话描述"，
// 正文在模型判定命中时才加载进本轮，避免 15 个技能正文常驻吃掉上下文预算。
//
// 目录：开发态 apps/built-in-skill；打包态 resources/built-in-skill。

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * 本文件所在目录。ESM（"type": "module"）下没有 `__dirname`，只能从 import.meta 反推——
 * 直接写 __dirname 会抛 `ReferenceError: __dirname is not defined`，会话直接起不来。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 资源根：子进程是被**外部 Node** 拉起的普通进程，拿不到 Electron 的 `process.resourcesPath`，
 * 主进程因此把同一路径经 `EVA_TS_RESOURCES` 递进来（见 desktop-node/src/tsAgentCore.js）。
 * 只认 resourcesPath 的话，打包态与开发态都会落到下面的仓库布局兜底。
 */
function resourcesRoot(): string {
  return String(process.env.EVA_TS_RESOURCES || process.resourcesPath || "").trim()
}

/** 内置技能目录（调试可用 EVA_BUILTIN_SKILL_DIR 覆盖）。 */
export function builtinSkillDir(): string {
  const explicit = String(process.env.EVA_BUILTIN_SKILL_DIR || "").trim()
  if (explicit && fs.existsSync(explicit)) return explicit
  const root = resourcesRoot()
  if (root) {
    const p = path.join(root, "built-in-skill")
    if (fs.existsSync(p)) return p
  }
  return path.resolve(HERE, "..", "..", "built-in-skill")
}

/** 通用技能库目录（开发态 apps/skills / 打包态 resources/skills）：其余技能正文也能加载。 */
function bundleSkillDir(): string {
  const explicit = String(process.env.EVA_SKILL_BUNDLE || "").trim()
  if (explicit && fs.existsSync(explicit)) return explicit
  const root = resourcesRoot()
  if (root) {
    const p = path.join(root, "skills")
    if (fs.existsSync(p)) return p
  }
  return path.resolve(HERE, "..", "..", "skills")
}

/** 读一个根目录下所有子目录名（技能以目录形式存放：foo/ 或 foo/SKILL.md）。 */
function readDir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

export interface SkillMeta {
  name: string
  description: string
  /**
   * 触发词（frontmatter `trigger:`，文档 19 P1-9[0]）：逗号分隔的关键词，
   * 帮模型判"这个技能跟当前任务沾不沾边"。没有就只靠 description 判断。
   */
  trigger?: string
}

/**
 * 从一个技能目录取正文与描述（目录名即技能名，与 catalog.js / desktop-node 一致）。
 * front-matter 的 `description` 优先；没有则取首段纯文本。
 */
function readSkill(rootDir: string, name: string): { body: string; description: string; trigger?: string } | null {
  const file = path.join(rootDir, name, "SKILL.md")
  if (!fs.existsSync(file)) return null
  let raw = ""
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
  const fm = raw.match(/^---[^\n]*\n([\s\S]*?)\n---[^\n]*\n?/)
  const meta = fm ? fm[1] : ""
  const rest = fm ? raw.slice(fm[0].length) : raw
  let description = ""
  const d = /^[ \t]*description[ \t]*:[ \t]*(.+)$/m.exec(meta)
  if (d) description = d[1].trim().replace(/\s+/g, " ").replace(/^["']|["']$/g, "")
  if (!description) {
    const first = rest
      .replace(/^#[ \t]+.*$/m, "")
      .trim()
      .split(/\r?\n\s*\r?\n/)
      .find((p) => p.trim())
    description = (first || "").replace(/\s+/g, " ").trim().slice(0, 120)
  }
  let trigger: string | undefined
  const t = /^[ \t]*trigger[ \t]*:[ \t]*(.+)$/m.exec(meta)
  if (t) trigger = t[1].trim().replace(/\s+/g, " ").replace(/^["']|["']$/g, "") || undefined
  return { body: raw, description, trigger }
}

/**
 * 可注入清单（内置 + 通用技能库，按名去重、内置优先）。
 *
 * 此前清单只列内置目录，`bundleSkillDir()` 只在 loadSkillByName 里当 fallback——
 * 结果模型**不知道**技能库里还有什么，永远不会主动去 load（P1-9[5]）。
 * 现在两个目录都列；真膨胀到上百条时再做按项目过滤，现在先让存在被看见。
 */
export function builtinSkillList(): SkillMeta[] {
  const out: SkillMeta[] = []
  const seen = new Set<string>()
  for (const dir of [builtinSkillDir(), bundleSkillDir()]) {
    for (const name of readDir(dir)) {
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      const s = readSkill(dir, name)
      if (!s) continue
      seen.add(key)
      out.push({ name, description: s.description || "（无描述）", trigger: s.trigger })
    }
  }
  return out
}

/**
 * 系统提示节：列出可用技能，并告诉模型用 load_skill 加载正文。无技能时返回 null（整节消失）。
 *
 * 用 `<system-reminder>` 包裹（对齐 Claude Code，P1-9[1]）：这是"运行时注入的可变清单"，
 * 不是提示词的固定语义——标签让模型把它和"指令本身"区分开，清单增删也只动这一小节。
 * （完整消息级注入要重排消息组装管线，收益不抵改动风险，这一节仍留在系统提示词内渲染，
 * 但每轮本来就在重建，缓存影响面与消息级等价。）
 */
export function builtinSkillsSection(): string | null {
  const list = builtinSkillList()
  if (!list.length) return null
  return [
    "<system-reminder>",
    "以下技能默认可用（内置 + 技能库，无需安装）。任务与某个技能匹配（看描述或触发词）时，调用 load_skill 把它的完整说明加载进本轮，再按其指示执行；同一技能本轮只加载一次。",
    ...list.map((s) => `- ${s.name}：${s.description}${s.trigger ? `（触发词：${s.trigger}）` : ""}`),
    "</system-reminder>",
  ].join("\n")
}

/** 按名加载技能正文（先查内置目录，再查通用技能库）。找不到返回 null。 */
export function loadSkillByName(name: string): string | null {
  const want = String(name || "").trim().toLowerCase()
  if (!want) return null
  for (const dir of [builtinSkillDir(), bundleSkillDir()]) {
    for (const n of readDir(dir)) {
      if (n.toLowerCase() === want) {
        const s = readSkill(dir, n)
        if (s) return s.body
      }
    }
  }
  return null
}
