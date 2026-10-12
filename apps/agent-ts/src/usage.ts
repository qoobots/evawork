// 上下文用量（TS-065）：把"这次请求到底占了多少上下文"按**分类**算出来，供界面监控。
//
// 为什么要它：压缩阈值以前是黑箱——界面只收到一条"已压缩"的提示，用户不知道
// "还能塞多少、是被什么吃掉的"。这里把分类摊开，与界面那张面板一一对应：
//   系统提示词 / 工具及子智能体 / 对话消息 / 连接器及MCP / 技能
//
// token 一律**估算**（见 context.ts 的 `estimateTokens`）。宁可标"估算"，也不假装
// 拿到了模型回传的精确 usage——模型没回传时还标精确，那是在骗人。

import { allTools, openaiSchemas } from "./tools.ts"
import { contextUsage, estimateMessages, estimateTokens } from "./context.ts"
import type { ContextUsage } from "./context.ts"
import type { PromptContext, SystemPrompt } from "./prompt.ts"
import type { Message, ToolDef } from "./types.ts"

/** MCP 外部工具的名字前缀（见 mcp.ts 的 `mcpToolName`）。 */
const MCP_PREFIX = "mcp__"

export interface UsageInput {
  /** 系统提示词构造器：`skills` 一节单列，其余归"系统提示词" */
  system?: SystemPrompt
  promptCtx?: PromptContext
  /** 这次**真正发给模型**的工具集（不填 = 全部）。MCP 外部工具按名字前缀单列 */
  tools?: ToolDef[]
  /** 完整消息列表：**第 0 条若是 system，视为系统提示词**，不计入"对话消息" */
  messages?: Message[]
  windowTokens?: number
}

/**
 * 算一份上下文用量快照。
 *
 * 口径刻意与"真正发出去的那次请求"对齐（同一份 system、同一套 tool schema、
 * 同一段 messages），否则面板上的数字会与实际占用对不上——那比不显示更糟。
 */
export function computeContextUsage(o: UsageInput): ContextUsage {
  const tools = o.tools ?? allTools()
  const messages = o.messages ?? []

  // 工具 schema：模型看到的就是这段 JSON，所以按 JSON 文本量算
  let toolTokens = 0
  let mcpTokens = 0
  for (const t of tools) {
    const n = estimateTokens(JSON.stringify(openaiSchemas([t])))
    if (String(t.name).startsWith(MCP_PREFIX)) mcpTokens += n
    else toolTokens += n
  }

  // 系统提示词按分节拆：skills 单列（它与工具一样是"可增删的清单"），其余合并
  let systemText = ""
  let skillsText = ""
  if (o.system && o.promptCtx) {
    for (const s of o.system.parts(o.promptCtx)) {
      if (s.id === "skills") skillsText += s.text
      else systemText += s.text
    }
  }

  // 对话消息 = 除"第 0 条 system（系统提示词）"之外的全部（含 tool 结果与注入的清单）
  const convo = messages[0] && messages[0].role === "system" ? messages.slice(1) : messages

  return contextUsage({
    windowTokens: o.windowTokens,
    parts: [
      { id: "system", label: "系统提示词", tokens: estimateTokens(systemText) },
      { id: "tools", label: "工具及子智能体", tokens: toolTokens },
      { id: "conversation", label: "对话消息", tokens: estimateMessages(convo) },
      { id: "mcp", label: "连接器及MCP", tokens: mcpTokens },
      { id: "skills", label: "技能", tokens: estimateTokens(skillsText) },
    ],
  })
}
