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
import { builtinSkillsSection } from "./skills.ts"

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
        "读写文件走专用工具：read_file（带行号）、write_file、edit_file（定点替换，old_string 要唯一）；" +
          "找文件名用 glob_files、搜内容用 search_text——**不要用 run_command 跑 cat/grep/find**，编码与转义的坑工具层已经替你背了。",
        c.tools.includes("terminal")
          ? "terminal 的当前目录会跨命令保持；run_command 每条都重置回工作区根。"
          : null,
        "多个**互相独立**的调用放在同一轮发出（一次请求里带多个 tool_calls），独立读取会并行执行；有先后依赖的才分开轮次。",
        "工具返回失败时先读错误原因再决定下一步，盲目重试只会重复失败。",
      ]),
  },
  {
    // 内置技能清单：每段对话都注入"名称 + 一句话描述"（正文按需由 load_skill 加载）。
    // 空 → 整节消失（TS-040 约定）。
    id: "skills",
    render: () => builtinSkillsSection(),
  },
  {
    // 持久记忆协议（文档 19 P0-5）：目录 + 格式 + 索引 + 排除清单 + 触发时机。
    // 索引本身**不在这里渲染**——它每轮从磁盘现读、由 loop 作为一条独立 system 消息注入
    // （可变清单塞进固定前缀会让缓存前缀天天失效）；本节给的是**协议**，不随轮次变。
    id: "memory",
    render: (c) => {
      const dir = `${c.workspace.replace(/\\/g, "/")}/.evawork/memory`
      return [
        "# 持久记忆",
        `你有跨会话的持久记忆，目录 \`${dir}\`（已存在，直接用 write_file 写，不要 mkdir、不要先检查目录）。`,
        "一条记忆一个文件、只装一条事实，文件名 kebab-case（如 `user-role.md`），frontmatter 形状：",
        "```",
        "---",
        "name: 短-kebab-标识",
        "description: 一行摘要（召回时靠它判断相关性）",
        "metadata:",
        "  type: user | feedback | project | reference",
        "---",
        "正文；feedback / project 类型必须紧跟 **Why:** 与 **How to apply:** 两行；相关记忆用 [[name]] 互链。",
        "```",
        `写完（或改完）在 \`${dir}/MEMORY.md\` 维护一行索引：\`- [标题](文件名.md) — 一句钩子\`。`,
        "**索引里只有这一行**：正文绝不进索引，MEMORY.md 也没有 frontmatter。",
        "什么时候写：用户明说「记住…」；用户纠正了你的做法（记下来别再犯）；确认了某个从代码里看不出来的取舍；发现会反复踩的坑（环境、工具、约定）。",
        "什么时候**不**写：代码结构、文件清单、git 里本来就有的历史、上一轮修了什么 bug、只对本次对话有意义的临时状态——这些repo 自己就记录了。",
        "与 `.evawork/notes.md`（本轮任务草稿，交付后可删）的分工：notes 记的是**这件事**，memory 记的是**跨会话仍然成立的事实**。",
        "召回：对话开头若有 `<memory-index>` 清单，那就是全部记忆。看到相关的条目，先用 read_file 读正文再决定用不用；",
        "记忆反映的是**写下当时**的事实——若它提到某个文件/开关/流程，先核实它还存在，别按旧图走新路。",
        "记忆坏了就删（write_file 空内容 + 移除索引行），过期就改，别堆。",
      ].join("\n")
    },
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
