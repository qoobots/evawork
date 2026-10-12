// 长输出溢出（TS-031）：超出阈值的工具输出写进文件，只把**引用 + 摘要**回给模型。
//
// 为什么必须做：一次 `run_command` 或读一个大文件，几万字符直接进上下文，几轮下来
// 就把窗口塞满——而模型真正需要的往往只是其中一小段。
//
// 溢出文件放在**工作区内**的 `.eva-spill/`（隐藏目录）而不是数据目录：
// 放在数据目录的话模型根本读不到——read_file 受工作区约束，够不着工作区外的路径，
// 于是"溢出"变成了"丢失"。

import fs from "node:fs"
import path from "node:path"

/** 超过这个长度就溢出（回给模型的可见部分）。 */
export const SPILL_LIMIT = 8000

const DIR_NAME = ".eva-spill"

export function spillDir(workspace: string): string {
  const d = path.join(path.resolve(workspace), DIR_NAME)
  fs.mkdirSync(d, { recursive: true })
  return d
}

export interface SpillResult {
  text: string
  spilled?: string
  chars: number
}

export function maybeSpill(workspace: string, text: string, limit = SPILL_LIMIT): SpillResult {
  const chars = text.length
  if (chars <= limit) return { text, chars }

  const name = `out-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.txt`
  const p = path.join(spillDir(workspace), name)
  try {
    fs.writeFileSync(p, text, "utf8")
  } catch (err) {
    // 写不进去也不能把全部内容塞回上下文——截断并如实说明
    return { text: `${text.slice(0, limit)}\n…（共 ${chars} 字符；溢出文件写入失败：${String(err)}）`, chars }
  }

  const head = text.slice(0, 1200)
  return {
    text:
      `${head}\n\n…（共 ${chars} 字符，已溢出）\n` +
      `完整内容在 \`${path.relative(path.resolve(workspace), p).replace(/\\/g, "/")}\`，` +
      `需要更多细节时用 read_file 读它（按行区间读，别一次读全部）。`,
    spilled: p,
    chars,
  }
}
