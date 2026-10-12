/**
 * 办公文档四件套（TS-066）：docx / xlsx / pptx / pdf 的读写。
 *
 * **与 tools.ts 的关系（改动点）**：这些工具**不再在 tools.ts 顶层自动注册**，
 * 而是抽成可手动导入的模块——默认不进工具清单，只有 boot.json 把
 * `modules.office` 设为 `true` 时，`applyManifest` 才会调用 `registerOfficeTools()`。
 * 这样它们从"永远内置"变成"按需启用"，需要的人手动开启即可，不影响默认能力组合。
 *
 * 实现细节（docx 中文、subset 体积、pptx 要点、docx 读）见 `office.ts` 的注释，
 * 本模块只负责把能力包装成 `defineTool` 注册项。
 */

import fs from "node:fs"
import path from "node:path"
import { defineTool, overwriteWarning, truncate } from "./tools.ts"
import type { ToolContext, ToolResult } from "./types.ts"
import {
  docxFromMarkdown,
  pdfFromPages,
  pptxFromSlides,
  readDocx,
  readKind,
  readXlsx,
  xlsxFromRows,
  type DocxRead,
  type SlideSpec,
  type TableSpec,
  type XlsxRead,
} from "./office.ts"

/** 给展示用的相对路径（沙箱已移除，纯相对化即可）。 */
function relTo(workspace: string, abs: string): string {
  const rel = path.relative(path.resolve(workspace), abs)
  return rel.replace(/\\/g, "/") || "."
}

/**
 * 解析一个"可能是 JSON 字符串"的参数。
 *
 * 复杂结构（表格 / 幻灯片 / 数据行）一律让模型传 **JSON 字符串**而不是嵌套对象：
 * OpenAI 兼容接口对 array/object 参数的支持参差，而字符串一定到得了；
 * 解析失败时把原文与问题一起说清，而不是静默当成空数组——那会让模型以为
 * 自己传对了，然后拿到一份空文档。
 */
function jsonArg<T>(raw: unknown, what: string, example: string): T | null {
  if (raw === undefined || raw === null || raw === "") return null
  if (typeof raw === "object") return raw as T
  try {
    return JSON.parse(String(raw)) as T
  } catch (e) {
    throw new Error(`${what} 不是合法 JSON：${(e as Error).message}。要长这样：${example}`)
  }
}

/**
 * 注册办公文档四件套。默认不调用——只有 boot.json 开了 `modules.office` 才注册，
 * 因此这些工具默认不在 `allTools()` 里，也不会暴露给模型。
 */
export function registerOfficeTools(): void {
  defineTool({
    name: "create_document",
    description:
      "生成 Word 文档（.docx）。content 用 Markdown 子集：# 到 ###### 是各级标题，'- ' 是要点，其余非空行是段落。" +
      "需要表格时用 table 参数（JSON），不要用 ASCII 排版硬凑。path 给 .md/.markdown/.txt 会自动转成 .docx。" +
      "目标已存在会**整体覆盖**（结果里会警示）；改已有文档先用 read_document 读一遍再写，别凭印象重写。" +
      "不用场景：纯文本/Markdown 文件用 write_file 写，不要为了\"好看\"走 docx；记忆与草稿都不该是 .docx。",
    parameters: [
      { name: "path", type: "string", required: true, desc: "输出路径（.docx；.md/.markdown/.txt 自动转 .docx）" },
      { name: "content", type: "string", required: true, desc: "Markdown 正文（标题用 #，要点用 - ）" },
      { name: "table", type: "string", required: false, desc: '可选表格 JSON：{"header":["列1","列2"],"rows":[["a","b"]]}' },
    ],
    action: "write",
    async execute(args, ctx): Promise<ToolResult> {
      try {
        let abs = path.resolve(ctx.workspace, String(args.path || ""))
        if (!/\.docx$/i.test(abs)) {
          // 模型常先入为主给 .md/.markdown/.txt；自动落到 .docx，避免"只写 .docx"的硬拒导致重试。
          // 其它非 docx 后缀仍是非法输入，明确报错。
          const m = abs.match(/\.(md|markdown|txt)$/i)
          if (m) abs = abs.slice(0, -m[1].length) + "docx"
          else return { ok: false, error: "create_document 只写 .docx 文件（路径要以 .docx 结尾；.md/.markdown/.txt 会自动转成 .docx）" }
        }
        const table = jsonArg<TableSpec>(args.table, "table", '{"header":["列1"],"rows":[["值"]]}') ?? undefined
        if (table && (!Array.isArray(table.header) || !Array.isArray(table.rows))) {
          return { ok: false, error: 'table 需要形如 {"header":[...],"rows":[[...]]}' }
        }
        const warn = overwriteWarning(abs, ctx.workspace)
        const r = await docxFromMarkdown(String(args.content ?? ""), table)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, r.buffer)
        return {
          ok: true,
          output: `已生成 Word 文档 ${relTo(ctx.workspace, abs)}（${r.bytes} 字节，${r.paragraphs} 段${r.tables ? "，含 1 个表格" : ""}）${warn}`,
        }
      } catch (err) {
        return { ok: false, error: `生成 Word 文档失败：${String((err as Error).message || err)}` }
      }
    },
  })

  defineTool({
    name: "read_document",
    description:
      "读 Word（.docx）或 Excel（.xlsx）并返回文本内容。改文档前先读它——凭猜测改已有文件最容易把内容改坏。" +
      "PDF 暂不支持读取（只认 .docx/.xlsx）；xlsx 默认读第一个工作表、最多 200 行，可用 sheet/max_rows 调；" +
      "输出超 20000 字符会截断，超大表格分段读。",
    parameters: [
      { name: "path", type: "string", required: true, desc: "文件路径（.docx 或 .xlsx）" },
      { name: "sheet", type: "string", required: false, desc: "xlsx 的工作表名（不给则读第一个）" },
      { name: "max_rows", type: "number", required: false, desc: "xlsx 最多读多少行（默认 200）" },
    ],
    action: "read",
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const abs = path.resolve(ctx.workspace, String(args.path || ""))
        if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在：${relTo(ctx.workspace, abs)}` }
        const kind = readKind(abs)
        if (!kind) return { ok: false, error: "只支持 .docx 与 .xlsx（PDF 的读取是另一条链路，本轮没做）" }
        if (kind === "docx") {
          const r: DocxRead = await readDocx(abs)
          const parts: string[] = []
          if (r.paragraphs.length) parts.push(r.paragraphs.join("\n"))
          for (const t of r.tables) parts.push(t.map((row) => row.join(" | ")).join("\n"))
          if (!parts.length) return { ok: true, output: "（文档是空的，或内容都在图片里——文字提取不到）" }
          return {
            ok: true,
            output:
              truncate(parts.join("\n\n")) +
              `\n（共 ${r.paragraphs.length} 段${r.tables.length ? "、" + r.tables.length + " 个表格" : ""}）`,
          }
        }
        const r: XlsxRead = await readXlsx(abs, String(args.sheet || ""), Number(args.max_rows || 200))
        if (!r.sheets.length) return { ok: false, error: `没找到工作表${args.sheet ? "：" + args.sheet : ""}` }
        const out = r.sheets.map((sh) => `## ${sh.name}\n${sh.rows.map((row) => row.join(" | ")).join("\n")}`).join("\n\n")
        return { ok: true, output: truncate(out) + `\n（共 ${r.sheets.length} 个表）` }
      } catch (err) {
        return { ok: false, error: `读文档失败：${String((err as Error).message || err)}` }
      }
    },
  })

  defineTool({
    name: "create_spreadsheet",
    description:
      "生成 Excel 表格（.xlsx）。header 是表头数组，rows 是数据行（每行一个数组，值的顺序与表头对应）。" +
      "目标路径已存在会**整体覆盖**（结果里警示）。不用场景：两三行数据直接写在文档里用 Markdown 表格，不值得单独建一个 xlsx。",
    parameters: [
      { name: "path", type: "string", required: true, desc: "输出路径（.xlsx）" },
      { name: "sheet", type: "string", required: false, desc: "工作表名（默认 Sheet1）" },
      { name: "header", type: "string", required: true, desc: '表头 JSON 数组：["指标","数值"]' },
      { name: "rows", type: "string", required: true, desc: '数据行 JSON 二维数组：[["日活",12345]]' },
    ],
    action: "write",
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const abs = path.resolve(ctx.workspace, String(args.path || ""))
        if (!/\.xlsx$/i.test(abs)) return { ok: false, error: "create_spreadsheet 只写 .xlsx 文件" }
        const header = jsonArg<string[]>(args.header, "header", '["指标","数值"]')
        if (!header?.length) return { ok: false, error: 'header 不能为空，例如 ["指标","数值"]' }
        const rows = jsonArg<(string | number | boolean | null)[][]>(args.rows, "rows", '[["日活",12345]]') ?? []
        if (!Array.isArray(rows)) return { ok: false, error: 'rows 必须是二维数组，例如 [["日活",12345]]' }
        const bad = rows.findIndex((r) => !Array.isArray(r))
        if (bad >= 0) return { ok: false, error: `rows 第 ${bad + 1} 行不是数组（每行要是一个数组）` }
        const warn = overwriteWarning(abs, ctx.workspace)
        const r = await xlsxFromRows(String(args.sheet || "Sheet1"), header, rows)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, r.buffer)
        return {
          ok: true,
          output: `已生成表格 ${relTo(ctx.workspace, abs)}（工作表 "${r.sheet}"，${r.columns} 列 ${r.rows} 行，${r.bytes} 字节）${warn}`,
        }
      } catch (err) {
        return { ok: false, error: `生成表格失败：${String((err as Error).message || err)}` }
      }
    },
  })

  defineTool({
    name: "create_slides",
    description:
      "生成 PowerPoint 演示文稿（.pptx）。slides 是页面数组，每页 {title, bullets?, note?}。做汇报或方案时用它，不要写 ASCII 幻灯片。" +
      "目标已存在会**整体覆盖**（结果里警示）。不用场景：纯文字汇报用 create_document，不要为了\"有封面\"走 pptx。",
    parameters: [
      { name: "path", type: "string", required: true, desc: "输出路径（.pptx）" },
      { name: "slides", type: "string", required: true, desc: '页面 JSON 数组：[{"title":"季度总结","bullets":["要点一"]}]' },
    ],
    action: "write",
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const abs = path.resolve(ctx.workspace, String(args.path || ""))
        if (!/\.pptx$/i.test(abs)) return { ok: false, error: "create_slides 只写 .pptx 文件" }
        const slides = jsonArg<SlideSpec[]>(args.slides, "slides", '[{"title":"标题","bullets":["要点"]}]')
        if (!slides?.length) return { ok: false, error: 'slides 不能为空，例如 [{"title":"标题"}]' }
        const bad = slides.findIndex((s) => !s || typeof s.title !== "string")
        if (bad >= 0) return { ok: false, error: `slides 第 ${bad + 1} 页缺少 title` }
        const warn = overwriteWarning(abs, ctx.workspace)
        const r = await pptxFromSlides(slides)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, r.buffer)
        return {
          ok: true,
          output: `已生成演示文稿 ${relTo(ctx.workspace, abs)}（${r.slides} 页：${r.titles.join(" / ")}，${r.bytes} 字节）${warn}`,
        }
      } catch (err) {
        return { ok: false, error: `生成演示文稿失败：${String((err as Error).message || err)}` }
      }
    },
  })

  defineTool({
    name: "create_pdf",
    description:
      "生成 PDF（.pdf）。content 是正文（空行分页），自动折页。中文会自动嵌入系统字体（Windows 找 msyh/simhei，macOS 找 PingFang SC）；" +
      "找不到中文字体时明确报错并建议改用 create_document。目标已存在会**整体覆盖**（结果里警示）。",
    parameters: [
      { name: "path", type: "string", required: true, desc: "输出路径（.pdf）" },
      { name: "content", type: "string", required: true, desc: "正文内容（空行表示分页）" },
    ],
    action: "write",
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const abs = path.resolve(ctx.workspace, String(args.path || ""))
        if (!/\.pdf$/i.test(abs)) return { ok: false, error: "create_pdf 只写 .pdf 文件" }
        const content = String(args.content ?? "")
        if (!content.trim()) return { ok: false, error: "content 为空，没有内容可排" }
        const warn = overwriteWarning(abs, ctx.workspace)
        const pages = content.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)
        const r = await pdfFromPages(pages)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, r.buffer)
        return {
          ok: true,
          output:
            `已生成 PDF ${relTo(ctx.workspace, abs)}（${r.pages} 页，${r.bytes} 字节` +
            `${r.cjkFontEmbedded ? "，已嵌入中文字体 " + (r.fontPath || "") : "（纯 ASCII，未嵌字体）"}` +
            `）${warn}`,
        }
      } catch (err) {
        return { ok: false, error: `生成 PDF 失败：${String((err as Error).message || err)}` }
      }
    },
  })
}
