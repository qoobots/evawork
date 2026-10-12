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
}

/**
 * 从一个技能目录取正文与描述（目录名即技能名，与 catalog.js / desktop-node 一致）。
 * front-matter 的 `description` 优先；没有则取首段纯文本。
 */
function readSkill(rootDir: string, name: string): { body: string; description: string } | null {
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
  return { body: raw, description }
}

/** 内置技能的"名称 + 一句话描述"清单（供系统提示注入）。 */
export function builtinSkillList(): SkillMeta[] {
  const dir = builtinSkillDir()
  const out: SkillMeta[] = []
  for (const name of readDir(dir)) {
    const s = readSkill(dir, name)
    if (s) out.push({ name, description: s.description || "（无描述）" })
  }
  return out
}

/** 系统提示节：列出可用内置技能，并告诉模型用 load_skill 加载正文。无技能时返回 null（整节消失）。 */
export function builtinSkillsSection(): string | null {
  const list = builtinSkillList()
  if (!list.length) return null
  return [
    "## 可用技能（内置，无需安装）",
    "以下技能随应用内置、每段对话默认可用。当任务与某个技能匹配时，调用 load_skill 把它的完整说明加载进本轮，再按其指示执行：",
    ...list.map((s) => `- ${s.name}：${s.description}`),
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
