// 持久记忆协议（文档 19 P0-5）：跨会话的"事实卡片"，带索引。
//
// 对齐 Claude Code 的记忆设计：**一文件一事实 + frontmatter + MEMORY.md 只做索引**。
// 正文绝不进索引，索引每轮都注入（很小），正文由模型按 description 判断相关性后
// 用 read_file 自己去读。少了这一层，"用户纠正过的做法"每一轮都要重新纠正一遍。
//
// 落点选在 `<workspace>/.evawork/memory/` 而不是用户主目录：记忆跟着工作区走
// ——A 项目的构建约定不该出现在 B 项目的上下文里。
//
// 刻意的不做：不猜语义、不做自动写入、不做召回排序——本模块只管目录与索引，
// "什么时候写、写什么"由提示词里的协议（prompt.ts 的 memory 节）约束模型。

import fs from "node:fs"
import path from "node:path"

/** 记忆目录（相对工作区）：与会话投影 notes 的 `.evawork/` 同居一处，不再多开顶层目录。 */
export const MEMORY_DIR_REL = ".evawork/memory"
/** 索引文件名：一行一条，指向同目录下的记忆文件。 */
export const MEMORY_INDEX = "MEMORY.md"

export function memoryDir(workspace: string): string {
  return path.join(path.resolve(workspace), MEMORY_DIR_REL)
}

/**
 * 确保记忆目录存在。**幂等**：每轮启动/每 turn 开始都可以放心调，
 * mkdirSync(recursive) 对已存在目录是 no-op。
 */
export function ensureMemoryDir(workspace: string): void {
  try {
    fs.mkdirSync(memoryDir(workspace), { recursive: true })
  } catch {
    /* 只读介质 / 权限问题：记忆是增强项，拿不到目录就整体退化为"无记忆"，绝不拦下主流程 */
  }
}

export function memoryIndexPath(workspace: string): string {
  return path.join(memoryDir(workspace), MEMORY_INDEX)
}

/**
 * 读索引行（只认 `- [` 开头的条目行）。
 *
 * **只回索引，不回正文**——注入上下文的是这张小清单，不是全部记忆文件。
 * 文件不存在/读失败返回空数组（首轮本来就没有记忆，这不是错误）。
 */
export function loadIndex(workspace: string): string[] {
  try {
    return fs
      .readFileSync(memoryIndexPath(workspace), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- ["))
  } catch {
    return []
  }
}

/**
 * 把索引渲染成注入用的一段文本。
 *
 * 用 `<memory-index>` 包起来而不是塞进系统提示词正文：它是**每轮都可能变的清单**
 * （写一条记忆就多一行），塞进前缀会让缓存前缀天天失效；放成独立一条消息，
 * 变化只发生在这一条上。开头一句说清"这是一张索引，不是记忆正文"——
 * 否则模型会把 `- [标题](file.md)` 当成用户给的任务链接去追。
 */
export function formatIndexForContext(index: string[]): string {
  if (!index.length) return ""
  return [
    "<memory-index>",
    "以下是跨会话持久记忆的索引（一行一条，不是正文）。需要细节时用 read_file 读对应文件；",
    "与当前事实冲突就以现状为准并更新记忆。",
    "",
    ...index,
    "</memory-index>",
  ].join("\n")
}
