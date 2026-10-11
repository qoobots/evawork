// 系统提示词：按**分节**组装，而不是一大段字符串（TS-040）。
//
// 照 deepseek-harness 的 `core/system-prompt`：提示词是一组可增删替换的 section，
// 由运行时上下文（工作区、档位、工具清单）渲染出来。
//
// 为什么非要拆开——一条经验：把"环境信息 / 工具策略 / 汇报风格"全糊在
// 一段话里，改任何一条都要动整段文本，而且**没法按场景裁剪**。拆开之后：
//   - 换个场景只换掉其中几节；
//   - 某一节返回空就整节消失，不会出现"## 技能\n（无）"这种占位噪音；
//   - 调用方可以整节替换（比如产品想改汇报风格，只换 `output` 一节）。

import { renderRulesSection } from "./rules.ts"

export interface PromptContext {
  workspace: string
  /** 当前注册的工具名（含 MCP 外部工具） */
  tools: string[]
  platform?: string
  date?: string
}

export interface PromptSection {
  id: string
  render(ctx: PromptContext): string | null
}

const text = (s: string): PromptSection => ({ id: "_", render: () => s })

/** 把多段渲染结果拼起来，空段落整段丢弃。 */
function join(parts: (string | null)[]): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join("\n\n")
}

export const defaultSections: PromptSection[] = [
  {
    id: "identity",
    render: () =>
      join([
        "你是一个在用户工作区内干活的桌面智能体。",
        "原则：\n1. 用工具拿事实，不要凭印象回答；\n2. 只在需要时调用工具，拿到结果就自己判断够不够；\n3. 不确定就先查证，不做看起来合理的推测。",
      ]),
  },
  {
    id: "environment",
    render: (c) =>
      join([
        `工作区根：${c.workspace}`,
        `平台：${c.platform || process.platform}${c.date ? `　日期：${c.date}` : ""}`,
      ]),
  },
  {
    id: "rules",
    // 项目规则来自工作区里的 AGENTS.md（分层：用户级 < 项目级 < 目录级）。
    // **空 → 整节消失**（TS-040 的约定）：没有规则文件就不占提示词位置。
    render: (c) => renderRulesSection(c.workspace),
  },
  {
    id: "trash",
    // TS 精简：删除文件一律进回收站，不永久删除——误删可从回收站找回。
    render: () =>
      "删除文件时**务必送入回收站而非永久删除**（Windows 用 PowerShell：`Add-Type -AssemblyName Microsoft.VisualBasic; Get-ChildItem <路径> | ForEach-Object { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($_.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin') }`）；误删后从回收站还原也用 PowerShell（Shell.Application 的 Namespace(10)）。不要调用会绕过回收站的永久删除命令。",
  },
  {
    id: "context",
    // 这条最容易被忽略、代价也最大：上下文是**投影**，早期轮次在预算满时会被整段移出。
    render: () =>
      join([
        "上下文是**投影**，不是长期记忆：你批量采集的信息（读到的文件内容、搜索结果）在预算满后，早期轮次会被整段移出对话——之后你就看不到它们了，且不会有任何提示。",
        "所以扫描项目、批量阅读时，**每拿到关键结论就落盘**（如写到 .evawork/notes.md），后续推理基于这个文件而不是记忆；报告交付后可以清理掉。",
        "若看到「早期内容已从上下文中移除」，说明前文已被压缩：需要旧细节就重新读文件，**不要凭印象推测**。",
      ]),
  },
  {
    id: "tools",
    render: (c) =>
      join([
        `可用工具：${c.tools.join(", ")}`,
        c.tools.includes("terminal")
          ? "terminal 的当前目录会跨命令保持；run_command 每条都重置回工作区根。"
          : null,
        "工具返回失败时先读错误原因再决定下一步，盲目重试只会重复失败。", 
      ]),
  },
  {
    id: "output",
    render: () => "汇报：用中文，简洁说明做了什么、结果是什么、什么没做成（以及原因）。不要罗列工具调用过程。",
  },
]

export class SystemPrompt {
  private list: PromptSection[]

  constructor(sections: PromptSection[] = defaultSections) {
    this.list = sections.map((s) => ({ ...s }))
  }

  get ids(): string[] {
    return this.list.map((s) => s.id)
  }

  /** 整节替换（同 id 覆盖）。 */
  set(section: PromptSection): this {
    const i = this.list.findIndex((s) => s.id === section.id)
    if (i >= 0) this.list[i] = section
    else this.list.push(section)
    return this
  }

  /** 把某节换成一段固定文本。 */
  setText(id: string, body: string | null): this {
    return this.set({ id, render: () => body })
  }

  /** 插到某节之前（没有就追加到末尾）。 */
  insertBefore(id: string, section: PromptSection): this {
    const i = this.list.findIndex((s) => s.id === id)
    if (i >= 0) this.list.splice(i, 0, section)
    else this.list.push(section)
    return this
  }

  remove(id: string): this {
    this.list = this.list.filter((s) => s.id !== id)
    return this
  }

  build(ctx: PromptContext): string {
    return join(this.list.map((s) => (s.render(ctx) ?? "").trim() || null))
  }

  /** 各分节的渲染结果（**空节丢弃**，与 `build` 同一套规则）——供用量统计按节归类。 */
  parts(ctx: PromptContext): { id: string; text: string }[] {
    const out: { id: string; text: string }[] = []
    for (const s of this.list) {
      const text = (s.render(ctx) ?? "").trim()
      if (text) out.push({ id: s.id, text })
    }
    return out
  }
}

/** 一次组装的快捷方式（默认分节即可）。 */
export function buildSystemPrompt(ctx: PromptContext): string {
  return new SystemPrompt().build(ctx)
}

export { text }
