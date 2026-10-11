// EvaWork TS agent trace 解析工具（一次性逆向分析用，非产品代码）
//
// 用法：
//   node scripts/ev-trace-analyze.mjs [trace-目录]
//
// 输入：.evawork/ts-agent/trace 下的 req-*.json（每个文件是一个 step 的请求报文，
//       字段：step / model / messages / stream / temperature / tools / toolsCount）
// 输出：scripts/ev-out/
//   overview.txt    每 step 概览（消息数、字符数、角色序列、工具调用）
//   system.txt      系统提示词原文（含分节标注）
//   tools.txt       70 个工具清单（按 MCP server / 内置分组）
//   tools-schema.*  若 trace 中带完整 schema 则导出
//   flow.txt        完整对话流（逐条消息）
//   callstats.txt   工具调用统计
//   growth.txt      上下文增长曲线
//
// 对应文档：.docs/20 ~ .docs/23

import fs from 'node:fs'
import path from 'node:path'

const DIR = process.argv[2] || 'C:\\Users\\Administrator\\.evawork\\ts-agent\\trace'
const OUT = path.join(import.meta.dirname, 'ev-out')
fs.mkdirSync(OUT, { recursive: true })

// 文件名形如 `req-<step>-<随机id>-<seq>.json`。**中间那个 id 每次请求都变**，不是会话号，
// 所以只能按时间顺序切分：step 回退即视为新会话开始（`traceSeq` 是进程内计数器，跨会话会重合）。
const all = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, mtime: fs.statSync(path.join(DIR, f)).mtimeMs, j: JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }))
  .sort((a, b) => a.mtime - b.mtime)

const groups = []
let cur = null
for (const r of all) {
  if (!cur || (r.j.step || 0) <= (cur[cur.length - 1].j.step || 0)) { cur = []; groups.push(cur) }
  cur.push(r)
}
const sessions = groups.map((list, i) => ({
  id: `s${i + 1}`,
  list,
  steps: list.length,
  from: new Date(list[0].mtime).toISOString().slice(11, 19),
  to: new Date(list[list.length - 1].mtime).toISOString().slice(11, 19),
  task: String(list[0].j.messages?.find((m) => m.role === 'user')?.content || '').slice(0, 60),
}))

const pickIdx = process.argv[3] ? Number(process.argv[3]) : 0
const chosen = sessions.slice().sort((a, b) => b.steps - a.steps)[pickIdx] || sessions[0]
const recs = chosen.list
if (!recs.length) { console.error('没有可分析的 trace'); process.exit(1) }

const flat = (c) => (typeof c === 'string' ? c : JSON.stringify(c))
const write = (n, s) => fs.writeFileSync(path.join(OUT, n), s)

/* ---- overview ---- */
{
  const L = []
  L.push(`trace dir: ${DIR}`)
  L.push(`会话清单（共 ${sessions.length} 个，本次分析 ${chosen.id}）`)
  for (const s of sessions)
    L.push(`  ${s.id}  ${String(s.steps).padStart(2)} 步  ${s.from} → ${s.to}  ${s.task}`)
  L.push(`\nfiles: ${recs.length}\n`)
  L.push('step | file | model | temp | tools | msgs | chars | sysChars | 角色序列 | 本轮新增')
  for (const { file, j } of recs) {
    const msgs = j.messages || []
    const chars = msgs.reduce((a, m) => a + JSON.stringify(m.content ?? m).length, 0)
    L.push([
      j.step, file, j.model, j.temperature, j.toolsCount, msgs.length, chars,
      JSON.stringify(msgs[0]?.content ?? '').length,
      msgs.map((m) => m.role).join('>').slice(0, 160),
      msgs.length >= 2 ? `${msgs[msgs.length - 2].role}+${msgs[msgs.length - 1].role}` : '-',
    ].join(' | '))
  }
  write('overview.txt', L.join('\n'))
}

/* ---- 系统提示词 ---- */
{
  const sys = recs.map((r) => flat((r.j.messages || []).find((m) => m.role === 'system')?.content)).filter(Boolean)
  const uniq = [...new Set(sys)]
  let s = `不同版本数: ${uniq.length}\n各 step 系统提示词长度: ${sys.map((x) => x.length).join(', ')}\n\n`
  s += '='.repeat(80) + '\n' + uniq[0] + '\n'
  if (uniq.length > 1) uniq.slice(1).forEach((x, i) => (s += `\n${'='.repeat(80)}\n[变体${i + 1}]\n${x}\n`))
  write('system.txt', s)
}

/* ---- 工具清单 ---- */
{
  const tools = recs[recs.length - 1].j.tools || []
  const mcp = new Map(), builtin = []
  for (const t of tools) {
    const name = typeof t === 'string' ? t : t.name
    if (name.startsWith('mcp__')) {
      const srv = name.split('__')[1] || '?'
      if (!mcp.has(srv)) mcp.set(srv, [])
      mcp.get(srv).push(name)
    } else builtin.push(name)
  }
  const L = []
  L.push(`工具总数: ${tools.length}（自带 toolsCount=${recs[recs.length - 1].j.toolsCount}）\n`)
  L.push(`内置工具 ${builtin.length} 个：\n  ${builtin.join(', ')}\n`)
  L.push(`MCP server ${mcp.size} 个：\n`)
  for (const [srv, list] of [...mcp.entries()].sort((a, b) => b[1].length - a[1].length))
    L.push(`  ${srv} (${list.length}): ${list.map((n) => n.split('__').slice(2).join('__')).join(', ')}`)
  L.push('\n完整名称列表：\n' + tools.map((t, i) => `${String(i + 1).padStart(3)} ${typeof t === 'string' ? t : t.name}`).join('\n'))
  write('tools.txt', L.join('\n'))
  write('tools.json', JSON.stringify({ builtin, mcp: Object.fromEntries(mcp) }, null, 2))
}

/* ---- 完整对话流 ---- */
{
  const last = recs[recs.length - 1].j.messages || []
  const L = []
  L.push(`最终 step=${recs[recs.length - 1].j.step} 的完整上下文，共 ${last.length} 条消息\n`)
  last.forEach((m, i) => {
    const c = m.content == null
      ? (m.tool_calls ? JSON.stringify(m.tool_calls) : '')
      : flat(m.content)
    L.push(`\n${'='.repeat(70)}\n[${i}] ${m.role}  (${c.length} 字符)`)
    if (m.tool_calls) L.push(`tool_calls: ${JSON.stringify(m.tool_calls).slice(0, 800)}`)
    if (m.name) L.push(`name: ${m.name}`)
    if (m.tool_call_id) L.push(`tool_call_id: ${m.tool_call_id}`)
    L.push(c.slice(0, 6000))
  })
  write('flow.txt', L.join('\n'))
}

/* ---- 工具调用统计 ---- */
{
  const last = recs[recs.length - 1].j.messages || []
  const freq = new Map()
  const add = (n) => freq.set(n, (freq.get(n) || 0) + 1)
  for (const m of last) {
    if (m.tool_calls) for (const t of m.tool_calls) add(t.function?.name || t.name)
    else if (m.role === 'assistant' && typeof m.content === 'string')
      for (const mm of m.content.matchAll(/<tool[ _]?name[^>]*>([^<]+)/gi)) add(mm[1].trim())
  }
  const L = [`工具调用统计（从最终上下文反推）\n`]
  for (const [k, v] of [...freq.entries()].sort((a, b) => b[1] - a[1])) L.push(`${String(v).padStart(3)}  ${k}`)
  L.push(`\n合计 ${[...freq.values()].reduce((a, b) => a + b, 0)} 次`)
  write('callstats.txt', L.join('\n'))
}

/* ---- 上下文增长 ---- */
{
  const L = ['step | msgs | totalChars | sysChars | 本轮新增字符']
  let prev = 0
  for (const { j } of recs) {
    const msgs = j.messages || []
    const total = msgs.reduce((a, m) => a + JSON.stringify(m.content ?? m).length, 0)
    L.push(`${j.step} | ${msgs.length} | ${total} | ${JSON.stringify(msgs[0]?.content ?? '').length} | +${total - prev}`)
    prev = total
  }
  write('growth.txt', L.join('\n'))
}

/* ---- 每一步的工具调用（含溢出链追踪） ---- */
{
  const L = ['step | 工具 | 参数 | 结果字符 | 是否触发溢出']
  for (const { j } of recs) {
    const msgs = j.messages || []
    const lastTool = msgs[msgs.length - 1]
    if (lastTool?.role !== 'tool') { L.push(`${j.step} | — | — | — | —`); continue }
    const out = flat(lastTool.content)
    const spilled = /已溢出/.test(out)
    const target = (out.match(/完整内容在 `([^`]+)`/) || [])[1] || ''
    const declared = (out.match(/共 (\d+) 字符，已溢出/) || [])[1] || ''
    L.push(`${j.step} | ${lastTool.name} | ${JSON.stringify(msgs[msgs.length - 2]?.tool_calls?.[0]?.function?.arguments ?? '').slice(0, 120)} | ${out.length} | ${spilled ? `是(${declared}) -> ${target}` : '否'}`)
  }
  write('steps.txt', L.join('\n'))

  // 溢出链：.eva-spill 文件的生成顺序
  const chain = []
  for (const { j } of recs) {
    const last = (j.messages || [])[j.messages.length - 1]
    if (last?.role !== 'tool') continue
    const out = flat(last.content)
    const t = (out.match(/完整内容在 `([^`]+)`/) || [])[1]
    if (t) chain.push(`step${j.step}: ${t}`)
  }
  write('spill-chain.txt', chain.join('\n'))
}

console.log('done ->', OUT)
console.log(fs.readdirSync(OUT).map((f) => `  ${f} (${fs.statSync(path.join(OUT, f)).size})`).join('\n'))
