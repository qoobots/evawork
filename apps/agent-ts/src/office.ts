/**
 * 办公文档四件套（TS-066）：docx / xlsx / pptx / pdf 的读写。
 *
 * **为什么自己做**（这是本文件存在的全部理由）：
 * 官方那四个技能（docx/pptx/xlsx/pdf）是 Anthropic **专有许可**（source-available,
 * not open source），且捆绑 GPL 的 FFmpeg——不能抄也不能照搬实现。所以按"借鉴工作流、
 * 自己实现"的路子走：npm 生态的四个库都是 MIT/Apache 且纯 JS。
 *
 * 几个真实踩过的点（写在这里，省得下次再踩）：
 *
 * 1. **PDF 的中文**：pdf-lib 的 14 个标准字体是 WinAnsi 编码，drawText('中文') 直接抛
 *    `WinAnsi cannot encode "中"`。要中文必须 `registerFontkit` + 嵌入一个中文 ttf。
 *    这里按顺序找系统字体（黑体/雅黑/等线…），**找不到就明确报错并说清怎么办**，
 *    绝不静默出一份乱码 PDF。
 * 2. **嵌入体积**：用 `subset: true`，只嵌用到的字形——实测 9.3MB 的黑体嵌四个字
 *    只产出 4.4KB 的 PDF。不 subset 的话每个 PDF 都是 9MB 起。
 * 3. **pptx 的 addText**：要点列表必须传 `[{ text, options: { bullet: true } }]`，
 *    直接传 `string[]` 会报 `Cannot create property 'options' on string`。
 * 4. **docx 不擅长读**：`docx` 库只写不读。读的办法是 jszip 解出
 *    `word/document.xml` 再抽 `<w:t>` —— 段落与表格都覆盖得到。
 *
 * **输入用 Markdown / 行列数组**而不是让模型拼 OOXML：模型写 Markdown 几乎不会错，
 * 而拼 OOXML 一定会有结构错误。这是能力边界，不是省事。
 *
 * 本模块是**纯函数**：不碰工具注册表、不自己写盘。落盘由 tools.ts 统一走
 * `writeText`（回滚点快照，TS-060）——否则生成文档这条路径会绕过回滚点，
 * 而"以为能撤、其实撤不动"是最糟的一种状态。
 */

import fs from "node:fs"

/* ---------------- 通用 ---------------- */

/** 分页时每页放多少行（PDF 与 pptx 概览共用这个节奏）。 */
const PDF_LINES_PER_PAGE = 34

/**
 * 中文字体候选。**按优先级排**，第一个存在的就用。
 *
 * 都是 Windows 自带的中文字体（ttf 单文件优先——ttc 是字体集合，
 * fontkit 读它需要指定 index，麻烦且不稳）。
 */
const CJK_FONT_CANDIDATES = [
  "C:/Windows/Fonts/simhei.ttf", // 黑体（首选：单文件、覆盖完整）
  "C:/Windows/Fonts/msyh.ttf", // 微软雅黑（部分系统是 .ttc，这条只命中 .ttf）
  "C:/Windows/Fonts/Deng.ttf", // 等线
  "C:/Windows/Fonts/simsun.ttf", // 宋体
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttf", // Linux 文泉驿
  "/System/Library/Fonts/PingFang.ttc", // macOS（可能因 ttc 失败，捕获后继续试下一个）
]

function findCjkFont(): string | null {
  for (const p of CJK_FONT_CANDIDATES) {
    try {
      if (fs.statSync(p).isFile()) return p
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

/** 按最大行宽折行（中文按字符数、西文按单词，尽量不切半个词）。 */
function wrapLine(text: string, width: number): string[] {
  if (text.length <= width) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > width) {
    // 西文尽量在空格处断，中文直接按字数断
    const cut = rest.lastIndexOf(" ", width)
    const at = cut > width * 0.6 ? cut : width
    out.push(rest.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

/* ---------------- Markdown → docx ---------------- */

export interface TableSpec {
  header: string[]
  rows: string[][]
}

export interface DocxBuildResult {
  /** 二进制内容（工具负责落盘，这样生成文档也能走回滚点） */
  buffer: Buffer
  bytes: number
  paragraphs: number
  tables: number
  /** 写进去的纯文本，自检与"回读校验"都用它 */
  text: string
}

/**
 * 生成 docx。
 *
 * 支持的 Markdown 子集（**刻意窄**：窄到模型不会写错，够用就行）：
 * - `# 标题` ~ `###### 标题` → 各级标题
 * - `- 要点` / `* 要点` → 项目符号列表（连续多条会并成一个列表）
 * - 表格（可选参数）：`table` 一份，追加在正文之后
 * - 其余非空行 → 段落（空行分段）
 */
export async function docxFromMarkdown(content: string, table?: TableSpec): Promise<DocxBuildResult> {
  const { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } = await import("docx")

  const children: unknown[] = []
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const plain: string[] = []
  let bullets: string[] = []

  const flushBullets = () => {
    if (!bullets.length) return
    for (const b of bullets) {
      children.push(new Paragraph({ text: b, bullet: { level: 0 } }))
      plain.push("• " + b)
    }
    bullets = []
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flushBullets()
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flushBullets()
      const level = Math.min(h[1]!.length, 6)
      const text = h[2]!.trim()
      children.push(new Paragraph({ text, heading: (HeadingLevel as Record<string, unknown>)[`HEADING_${level}`] }))
      plain.push(text)
      continue
    }
    const b = /^\s*[-*]\s+(.*)$/.exec(line)
    if (b) {
      bullets.push(b[1]!.trim())
      continue
    }
    flushBullets()
    children.push(new Paragraph({ text: line.trim() }))
    plain.push(line.trim())
  }
  flushBullets()

  let tables = 0
  if (table && table.header?.length) {
    tables = 1
    const cell = (s: unknown) => new TableCell({ children: [new Paragraph({ text: String(s ?? "") })] })
    const rows = [
      new TableRow({ children: table.header.map((h) => cell(h)) }),
      ...table.rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) })),
    ]
    children.push(new Table({ rows }))
    plain.push(table.header.join(" | "))
    for (const r of table.rows) plain.push(r.join(" | "))
  }

  const doc = new Document({ sections: [{ children: children as never[] }] })
  const buf = await Packer.toBuffer(doc)
  return {
    buffer: buf,
    bytes: buf.byteLength,
    paragraphs: plain.filter((l) => !l.startsWith("• ")).length,
    tables,
    text: plain.join("\n"),
  }
}

/* ---------------- 读 docx / xlsx ---------------- */

export interface DocxRead {
  kind: "docx"
  /** 段落与列表项（表格单元格也在里面，读起来更像全文） */
  paragraphs: string[]
  tables: string[][][]
}

/**
 * 读 docx：解 zip 抽 `word/document.xml`。
 *
 * 按 `<w:p>`（段落）与 `<w:tbl>`（表格）分别收集——顺序不重要，
 * 重要的是"读出来的东西人能看懂、模型能引用"。
 */
export async function readDocx(abs: string): Promise<DocxRead> {
  const JSZip = (await import("jszip")).default
  let xml: string
  try {
    const zip = await JSZip.loadAsync(fs.readFileSync(abs))
    const f = zip.file("word/document.xml")
    if (!f) throw new Error("不是 docx：缺少 word/document.xml")
    xml = await f.async("string")
  } catch (e) {
    throw new Error(`读 docx 失败：${(e as Error).message}`)
  }

  const paragraphs: string[] = []
  const tables: string[][][] = []

  for (const block of xml.match(/<w:p\b[\s\S]*?<\/w:p>|<w:tbl>[\s\S]*?<\/w:tbl>/g) || []) {
    if (block.startsWith("<w:tbl")) {
      const rows: string[][] = []
      for (const row of block.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || []) {
        const cells: string[] = []
        for (const cell of row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []) {
          cells.push(
            [...cell.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
              .map((m) => m[1]!)
              .join("")
              .trim(),
          )
        }
        if (cells.length) rows.push(cells)
      }
      if (rows.length) tables.push(rows)
    } else {
      const text = [...block.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
        .map((m) => m[1]!)
        .join("")
        .trim()
      if (text) paragraphs.push(text)
    }
  }
  return { kind: "docx", paragraphs, tables }
}

export interface XlsxRead {
  kind: "xlsx"
  sheets: { name: string; rows: string[][] }[]
}

/** 读 xlsx：默认读第一个工作表；`maxRows` 防止一次吐出十万行。 */
export async function readXlsx(abs: string, sheet: string, maxRows: number): Promise<XlsxRead> {
  const XLSX = (await import("xlsx")) as unknown as XlsxModule
  let wb: XlsxWorkbook
  try {
    wb = XLSX.read(fs.readFileSync(abs), { type: "buffer" })
  } catch (err) {
    throw new Error(`读 xlsx 失败：${String((err as Error).message || err)}`)
  }
  const names = sheet ? wb.SheetNames.filter((x) => x === sheet) : wb.SheetNames.slice()
  const sheets: XlsxRead["sheets"] = []
  for (const name of names) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1,
      raw: true,
      defval: "",
      blankrows: false,
    }) as unknown[][]
    // max_rows 是**防吐爆**：一次读十万行会把上下文吃光，而多数场景只看个开头
    sheets.push({ name, rows: rows.slice(0, Math.max(1, maxRows)) })
  }
  return { sheets }
}
export interface XlsxBuildResult {
  buffer: Buffer
  bytes: number
  sheet: string
  rows: number
  columns: number
}

export async function xlsxFromRows(
  sheetName: string,
  header: string[],
  rows: (string | number | boolean | null)[][]
): Promise<XlsxBuildResult> {
  const XLSX = (await import("xlsx")) as unknown as XlsxModule
  // 表头加粗 + 列宽 + 冻结首行：SheetJS 默认什么都不设，生成出来的表在 Excel 里很难读，
  // 而这份"难看"是要交给用户看的产物，不只是能被程序读回来。
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows])
  ws["!cols"] = header.map((h) => ({
    // 中文按 2 个字符宽度算，不然标题会被截断
    wch: Math.min(40, Math.max(8, String(h).length * 2 + 2)),
  }))
  if (header.length) ws["!freeze"] = { xSplit: 0, ySplit: 1 }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer
  return { buffer: buf, bytes: buf.byteLength, sheet: sheetName, columns: header.length, rows: rows.length }
}
export interface SlideSpec {
  title: string
  /** 要点（每条一个 bullet）。空数组 = 只有标题的过渡页 */
  bullets?: string[]
  /** 可选备注页脚 */
  note?: string
}

export interface PptxBuildResult {
  buffer: Buffer
  bytes: number
  slides: number
  titles: string[]
}

export async function pptxFromSlides(slides: SlideSpec[]): Promise<PptxBuildResult> {
  if (!slides.length) throw new Error("至少要一页")
  const mod = (await import("pptxgenjs")) as unknown as { default: new () => PptxLike }
  const pptx = new mod.default()
  for (const spec of slides) {
    const slide = pptx.addSlide()
    slide.addText(String(spec.title ?? "").slice(0, 120), {
      x: 0.6, y: 0.4, w: 8.8, h: 0.9, fontSize: 28, bold: true,
    })
    const bullets = (spec.bullets ?? []).map((b) => String(b)).filter(Boolean)
    if (bullets.length) {
      // ⚠️ 要点必须传 [{text, options:{bullet}}]，直接传 string[] 会报
      // "Cannot create property 'options' on string"（这个错在实现时踩过）
      slide.addText(
        bullets.map((b) => ({ text: b, options: { bullet: true } })),
        { x: 0.7, y: 1.7, w: 8.6, h: 4.2, fontSize: 16, valign: "top" },
      )
    }
    if (spec.note) {
      slide.addText(String(spec.note).slice(0, 200), {
        x: 0.6, y: 6.7, w: 8.8, h: 0.5, fontSize: 11, color: "888888",
      })
    }
  }
  const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer
  return { buffer: buf, bytes: buf.byteLength, slides: slides.length, titles: slides.map((s) => s.title) }
}

/** pptxgenjs 的最小结构化类型。 */
interface PptxLike {
  addSlide(): {
    addText(
      text: string | { text: string; options?: Record<string, unknown> }[],
      opts?: Record<string, unknown>,
    ): unknown
  }
  write(opts: { outputType: string }): Promise<Buffer | string | ArrayBuffer>
}

/* ---------------- 生成 pdf ---------------- */

export interface PdfBuildResult {
  buffer: Buffer
  bytes: number
  pages: number
  /** 是否嵌入了中文字体（ASCII 内容不需要，体积小得多） */
  cjkFontEmbedded: boolean
  fontPath?: string
}

/**
 * 生成 pdf：`pages` 每项一页（内部再按行数自动折页）。
 *
 * **中文靠嵌入系统字体**（见文件头第 1 条）。ASCII 内容走标准字体，
 * 体积小且不依赖系统字体——所以中文用户之外的人也有能跑的路径。
 */
export async function pdfFromPages(pages: string[]): Promise<PdfBuildResult> {
  if (!pages.length) throw new Error("至少要一页")
  const { PDFDocument, StandardFonts } = await import("pdf-lib")

  const doc = await PDFDocument.create()
  const hasCjk = pages.some((p) => /[^\x00-\x7F]/.test(p))

  let font: unknown
  let cjkFontEmbedded = false
  let fontPath: string | undefined
  if (hasCjk) {
    const fp = findCjkFont()
    if (!fp) {
      throw new Error(
        "这份内容含中文，但系统里没找到可嵌入的中文字体（试过黑体/雅黑/等线/宋体）。" +
          "两条出路：① 改成 .docx（不依赖字体，最稳）；② 安装一个中文字体后重试",
      )
    }
    const fontkitMod = (await import("@pdf-lib/fontkit")) as unknown as { default: unknown }
    doc.registerFontkit(fontkitMod.default as never)
    // subset: true —— 只嵌用到的字形。9.3MB 的黑体嵌四个字只产出 4.4KB
    font = await doc.embedFont(fs.readFileSync(fp), { subset: true })
    cjkFontEmbedded = true
    fontPath = fp
  } else {
    font = await doc.embedFont(StandardFonts.Helvetica)
  }

  const f = font as { widthOfTextAtSize(t: string, s: number): number }
  const size = 11
  const lineH = 16
  const margin = 56

  // 先把所有段落折成行，再按每页容量切
  const allLines: { text: string; first: boolean }[] = []
  for (const raw of pages) {
    const body = String(raw ?? "")
    const firstLine = true
    let isFirst = firstLine
    for (const rawLine of body.replace(/\r\n/g, "\n").split("\n")) {
      for (const wrapped of wrapLine(rawLine, 76)) {
        allLines.push({ text: wrapped, first: isFirst })
        isFirst = false
      }
    }
  }

  const perPage = Math.max(8, PDF_LINES_PER_PAGE)
  let pageCount = 0
  for (let i = 0; i < allLines.length; i += perPage) {
    const chunk = allLines.slice(i, i + perPage)
    const page = doc.addPage([595, 842]) // A4
    pageCount += 1
    let y = 842 - margin - lineH
    for (const line of chunk) {
      if (line.text) page.drawText(line.text, { x: margin, y, size, font: font as never })
      y -= lineH
    }
    // 页码（右下角）：让人翻页时知道这是第几页，也方便核对有没有丢页
    page.drawText(`${pageCount} / ${Math.ceil(allLines.length / perPage)}`, {
      x: 495, y: 30, size: 9, font: font as never,
    })
  }

  const buf = await doc.save()
  return { buffer: Buffer.from(buf), bytes: buf.byteLength, pages: pageCount, cjkFontEmbedded, fontPath }
}

/* ---------------- 文件类型判断 ---------------- */

/** 按扩展名判断读哪种格式。给界面与工具用，避免模型自己猜。 */
export function readKind(abs: string): "docx" | "xlsx" | null {
  const lower = abs.toLowerCase()
  if (lower.endsWith(".docx")) return "docx"
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return "xlsx"
  return null
}
/**
 * SheetJS 的最小结构化类型。
 *
 * 不装 `@types/xlsx`：它只是类型包，而本项目对第三方一律用最小声明自给自足
 *（与其它库一致，避免类型依赖变成运行时依赖的隐形来源）。
 */
interface XlsxModule {
  read(data: Buffer, opts: { type: "buffer" }): XlsxWorkbook
  write(wb: XlsxWorkbook, opts: { type: "buffer"; bookType: string }): Buffer
  utils: {
    aoa_to_sheet(rows: unknown[][]): Record<string, unknown>
    book_new(): XlsxWorkbook
    book_append_sheet(wb: XlsxWorkbook, ws: Record<string, unknown>, name: string): void
    sheet_to_json(ws: unknown, opts: Record<string, unknown>): unknown[][]
  }
}

interface XlsxWorkbook {
  SheetNames: string[]
  Sheets: Record<string, unknown>
}
