// Claude Code trace 解析工具（一次性逆向分析用，非产品代码）
//
// 用法：
//   node scripts/cc-trace-analyze.mjs <trace-目录>
//
// 输入：EvaCode 抓取的 claude-code 请求 trace（每个 JSON 是一次完整 LLM 往返）
// 输出：scripts/cc-out/ 下的解析产物
//   step1.txt        概览：字段统计、工具清单、usage、耗时
//   step2.txt        按 (system 提示词, 工具集) 分类出的 agent 角色
//   bridge.txt       clientRequest(Anthropic 风格) → request(OpenAI 兼容) 的转换对照 + 时间线
//   curve.txt        每个请求的 sys/msg 字符数与 token 明细
//   main-flow.txt    主智能体 20 轮的对话流（消息 / 输出 / 工具调用）
//   sub-flow.txt     子智能体样例
//   classifier.txt   安全分类器的提示词结构与输入输出样例
//   tools.json       28 个工具的完整 schema
//   tools.md         工具可读版（描述 + 参数）
//   tools-brief.md   工具速查版（一行一个）
//   cls-*.txt        安全分类器提示词的章节切片
//   classes/         每一类 agent 的 system 提示词原文 + meta
//
// 对应文档：.docs/13 ~ .docs/19

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DIR = process.argv[2]
if (!DIR) {
  console.error('用法: node scripts/cc-trace-analyze.mjs <trace-目录>')
  process.exit(1)
}

const OUT = path.join(import.meta.dirname, 'cc-out')
fs.mkdirSync(OUT, { recursive: true })

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
const recs = files.map((f) => ({ file: f, j: JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }))
const seqOf = (r) => Number((r.j.id || '').split('#')[1] || 0)
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex').slice(0, 8)

const sysTextOf = (r) => {
  const s = (r.j.clientRequest || {}).system
  if (Array.isArray(s)) return s.map((x) => (typeof x === 'string' ? x : x.text || JSON.stringify(x))).join('\n')
  return typeof s === 'string' ? s : ''
}
const flat = (c) => {
  if (typeof c === 'string') return c
  if (Array.isArray(c))
    return c
      .map((b) =>
        b.text ? b.text
          : b.type === 'tool_use' ? `[tool_use:${b.name} ${JSON.stringify(b.input ?? b.arguments ?? {}).slice(0, 200)}]`
          : b.type === 'tool_result' ? `[result:${flat(b.content).slice(0, 200)}]`
          : JSON.stringify(b).slice(0, 200))
      .join('\n')
  return JSON.stringify(c)
}
const argOf = (t) => JSON.stringify(t.input ?? t.arguments ?? t).slice(0, 400)

const log = (L, ...a) => L.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' '))

/* ---------- step1：概览 ---------- */
{
  const L = []
  log(L, '=== 概览 ===', 'files', files.length, 'time', recs[0].j.ts, '->', recs[recs.length - 1].j.ts)

  const count = (pick) => {
    const m = new Map()
    for (const r of recs) { const v = JSON.stringify(pick(r)); m.set(v, (m.get(v) || 0) + 1) }
    return m
  }
  log(L, '\n=== route/upstream/source ===', [...count((r) => [r.j.route, r.j.upstream, r.j.source]).entries()])
  log(L, '\n=== model ===', [...count((r) => r.j.model).entries()])
  log(L, '\n=== max_tokens/stream ===', [...count((r) => [r.j.request?.max_tokens, String(r.j.request?.stream)]).entries()])
  log(L, '\n=== clientRequest 顶层键 ===', [...count((r) => Object.keys(r.j.clientRequest || {}).sort()).entries()].slice(0, 3))
  log(L, '\n=== response 顶层键 ===', [...count((r) => Object.keys(r.j.response || {}).sort()).entries()].slice(0, 3))

  log(L, '\n=== 每请求摘要 ===')
  log(L, 'seq | model | dur | status | sysChars | roles | toolCount | respCalls | textChars | promptTokens')
  for (const r of recs) {
    const msgs = r.j.request?.messages || []
    const sysLen = msgs.filter((m) => m.role === 'system').reduce((a, m) => a + JSON.stringify(m.content).length, 0)
    log(L, [
      seqOf(r), r.j.model, r.j.durationMs, r.j.status, sysLen,
      msgs.map((m) => m.role).join('>'),
      (r.j.request?.tools || []).length,
      (r.j.response?.toolCalls || []).map((t) => t.name).join(',') || '-',
      r.j.response?.textChars ?? '-',
      r.j.response?.usage?.prompt_tokens ?? '-',
    ].join(' | '))
  }

  const tools = new Map()
  for (const r of recs) for (const t of r.j.clientRequest?.tools || []) if (!tools.has(t.name)) tools.set(t.name, t)
  log(L, '\n=== 工具清单（去重', tools.size, '）===')
  for (const [n, t] of tools) log(L, n, '|', (t.description || '').split('\n')[0].slice(0, 160))

  const freq = new Map()
  for (const r of recs) for (const t of r.j.response?.toolCalls || []) freq.set(t.name, (freq.get(t.name) || 0) + 1)
  log(L, '\n=== 工具调用频次 ===', [...freq.entries()].sort((a, b) => b[1] - a[1]))

  let pt = 0, ct = 0, cached = 0
  for (const r of recs) {
    const u = r.j.response?.usage || {}
    pt += u.prompt_tokens || 0; ct += u.completion_tokens || 0; cached += u.prompt_tokens_details?.cached_tokens || 0
  }
  log(L, '\n=== usage ===', { prompt_tokens: pt, completion_tokens: ct, cached_tokens: cached, hit: (cached / pt * 100).toFixed(2) + '%' })

  const d = recs.map((r) => r.j.durationMs).sort((a, b) => a - b)
  log(L, '\n=== duration ===', 'min', d[0], 'max', d[d.length - 1], 'avg', Math.round(d.reduce((a, b) => a + b, 0) / d.length), 'sum', d.reduce((a, b) => a + b, 0))
  fs.writeFileSync(path.join(OUT, 'step1.txt'), L.join('\n'))
}

/* ---------- step2：按 (system, tools) 分类 ---------- */
{
  const L = []
  const classes = new Map()
  for (const r of recs) {
    const sys = sysTextOf(r)
    const tools = ((r.j.clientRequest || {}).tools || []).map((t) => t.name)
    const key = md5(sys.slice(0, 5000)) + '/' + md5(tools.join(','))
    if (!classes.has(key)) classes.set(key, [])
    classes.get(key).push({ r, sys, tools })
  }

  const clsOut = path.join(OUT, 'classes')
  fs.mkdirSync(clsOut, { recursive: true })
  log(L, '=== 分类结果 ===', 'classDir | count | sysLen | model | maxTokens | effort | stop | tools | 样例文件')
  let n = 0
  for (const [, items] of [...classes.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const { r, sys, tools } = items[0]
    n++
    const dir = `${String(n).padStart(2, '0')}-sys${sys.length}-t${tools.length}`
    fs.mkdirSync(path.join(clsOut, dir), { recursive: true })
    fs.writeFileSync(path.join(clsOut, dir, 'system.txt'), sys)
    fs.writeFileSync(path.join(clsOut, dir, 'meta.json'), JSON.stringify({
      count: items.length,
      files: items.map((x) => x.r.file),
      tools, model: r.j.model, maxTokens: r.j.clientRequest?.max_tokens,
      effort: JSON.stringify(r.j.clientRequest?.output_config || null),
      stop: JSON.stringify(r.j.clientRequest?.stop_sequences || null),
    }, null, 2))
    log(L, [dir, items.length, sys.length, r.j.model, r.j.clientRequest?.max_tokens,
      JSON.stringify(r.j.clientRequest?.output_config || null), JSON.stringify(r.j.clientRequest?.stop_sequences || null),
      tools.join(','), items.slice(0, 3).map((x) => x.r.file).join(' ')].join(' | '))
  }

  log(L, '\n=== 每类 system 提示词的小节标题 ===')
  for (const d of fs.readdirSync(clsOut)) {
    const t = fs.readFileSync(path.join(clsOut, d, 'system.txt'), 'utf8')
    log(L, `\n----- ${d} (len=${t.length}) -----`)
    log(L, t.split('\n').filter((l) => /^#{1,6}\s|^[A-Z][A-Za-z /-]{3,40}:$|^-{3,}$/.test(l)).slice(0, 60).join('\n'))
  }
  fs.writeFileSync(path.join(OUT, 'step2.txt'), L.join('\n'))
}

/* ---------- 工具导出 ---------- */
{
  const tools = new Map()
  for (const r of recs) for (const t of r.j.clientRequest?.tools || []) if (!tools.has(t.name)) tools.set(t.name, t)
  fs.writeFileSync(path.join(OUT, 'tools.json'), JSON.stringify([...tools.values()], null, 2))

  const md = []
  for (const [name, t] of tools) {
    const is = t.input_schema || {}
    const props = Object.entries(is.properties || {}).map(([k, v]) =>
      `      - \`${k}\` (${v.type}${v.enum ? ', enum: ' + JSON.stringify(v.enum) : ''}${is.required?.includes(k) ? ', required' : ''}): ${(v.description || '').replace(/\n/g, ' ').slice(0, 220)}`)
    md.push(`### ${name}\n${t.description || ''}\n\n参数：\n${props.join('\n') || '      (无)'}\n`)
  }
  fs.writeFileSync(path.join(OUT, 'tools.md'), md.join('\n---\n\n'))

  const brief = []
  for (const [name, t] of tools) {
    const is = t.input_schema || {}
    const params = Object.entries(is.properties || {}).map(([k, v]) => `${k}:${v.type}${is.required?.includes(k) ? '*' : ''}`).join(', ')
    brief.push(`- **${name}**(${params || '-'}) — ${(t.description || '').replace(/\s+/g, ' ').slice(0, 300)}`)
  }
  fs.writeFileSync(path.join(OUT, 'tools-brief.md'), brief.join('\n'))
}

/* ---------- bridge：报文转换 + 时间线 ---------- */
{
  const L = []
  const r = recs.find((x) => (x.j.request?.messages || []).length > 5)
  log(L, 'file=' + r.file)
  log(L, '--- clientRequest(Anthropic 风格) ---')
  ;(r.j.clientRequest.messages || []).forEach((m, i) => log(L, `[${i}] ${m.role} :: ${flat(m.content).slice(0, 140).replace(/\n/g, ' ')}`))
  log(L, '--- request(上游 OpenAI 兼容) ---')
  ;(r.j.request.messages || []).forEach((m, i) => log(L, `[${i}] ${m.role}(${JSON.stringify(m).length}) :: ${typeof m.content === 'string' ? m.content.slice(0, 170).replace(/\n/g, ' ') : JSON.stringify(m.content).slice(0, 170)}`))
  log(L, '\n--- requestSummary ---\n' + JSON.stringify(r.j.requestSummary, null, 2))
  log(L, '\n--- response ---\n' + JSON.stringify(Object.keys(r.j.response)) + '\n' + JSON.stringify(r.j.response?.usage, null, 2))

  log(L, '\n--- 时间线 ---')
  for (const x of recs) {
    const cr = x.j.clientRequest || {}
    const t = (cr.tools || []).length
    const kind = t === 27 ? 'MAIN' : t === 13 ? 'SUB' : (cr.stop_sequences || []).length ? 'SAFETY' : 'TITLE'
    log(L, `${x.j.ts} #${String(seqOf(x)).padStart(3)} ${kind} ${x.j.model} dur=${x.j.durationMs} status=${x.j.status}`)
  }
  fs.writeFileSync(path.join(OUT, 'bridge.txt'), L.join('\n'))
}

/* ---------- curve：上下文增长 ---------- */
{
  const rows = recs.map((r) => {
    const cr = r.j.clientRequest || {}
    const sysLen = sysTextOf(r).replace(/\n/g, '').length
    const msgLen = (cr.messages || []).reduce((a, m) => a + flat(m.content).length, 0)
    const u = r.j.response?.usage || {}
    return `#${String(seqOf(r)).padStart(3)} ${r.j.model} tools=${(cr.tools || []).length} sys=${sysLen} msg=${msgLen} total=${sysLen + msgLen} promptTok=${u.prompt_tokens} cached=${u.prompt_tokens_details?.cached_tokens ?? '-'} compTok=${u.completion_tokens} durMs=${r.j.durationMs}`
  })
  fs.writeFileSync(path.join(OUT, 'curve.txt'), rows.join('\n'))
}

/* ---------- main-flow / sub-flow ---------- */
{
  const dump = (list, lastN) => {
    const L = []
    for (const r of list) {
      const cr = r.j.clientRequest || {}
      L.push(`\n\n########## #${seqOf(r)}  ${r.file}  dur=${r.j.durationMs}ms  promptTok=${r.j.response?.usage?.prompt_tokens}  cached=${r.j.response?.usage?.prompt_tokens_details?.cached_tokens}`)
      const msgs = cr.messages || []
      msgs.forEach((m, i) => {
        const t = flat(m.content)
        const show = m.role === 'assistant' || m.role === 'tool' ? t.slice(0, 2500) : i >= msgs.length - lastN ? t.slice(0, 1200) : null
        if (show != null) L.push(`--- [${i}] ${m.role} (${t.length}) ---\n${show}`)
      })
      L.push(`>>> OUT(${r.j.response?.textChars}): ${(r.j.response?.text || '').slice(0, 900)}`)
      L.push(`>>> CALLS: ${(r.j.response?.toolCalls || []).map((t) => t.name + '(' + argOf(t) + ')').join('\n           ')}`)
    }
    return L.join('\n')
  }
  const main = recs.filter((r) => ((r.j.clientRequest || {}).tools || []).length === 27)
  const sub = recs.filter((r) => ((r.j.clientRequest || {}).tools || []).length === 13)
  fs.writeFileSync(path.join(OUT, 'main-flow.txt'), dump(main, 4))
  fs.writeFileSync(path.join(OUT, 'sub-flow.txt'), dump([sub[0], sub[1], sub[sub.length - 1]], 99))

  // 主智能体首轮的原始消息（含 system-reminder 项目指令 / # Environment）
  const first = recs.find((r) => seqOf(r) === 2)
  if (first) {
    ;(first.j.clientRequest?.messages || []).forEach((m, i) => {
      fs.writeFileSync(path.join(OUT, `main-msg-${i}.txt`), flat(m.content))
    })
  }
}

/* ---------- classifier：安全分类器 ---------- */
{
  const cls = recs.filter((r) => ((r.j.clientRequest || {}).stop_sequences || []).length > 0)
  if (cls.length) {
    const sys = sysTextOf(cls[0])
    const L = []
    log(L, '### 分类器 system prompt 分段标题')
    log(L, sys.split('\n').filter((l) => /^#{1,4}\s/.test(l)).join('\n'))
    log(L, '\n### 分类器 system prompt 前 12000 字\n' + sys.slice(0, 12000))
    log(L, '\n### 分类器输入样例\n' + (cls[0].j.clientRequest.messages || []).map((m) => `[${m.role}] ${flat(m.content).slice(0, 3000)}`).join('\n\n'))
    log(L, '\n### 分类器输出样例\n' + cls.slice(0, 6).map((r) => `#${seqOf(r)} <<<${r.j.response?.text}>>>`).join('\n'))
    fs.writeFileSync(path.join(OUT, 'classifier.txt'), L.join('\n'))

    const sec = (a, b) => { const i = sys.indexOf(a); const j = b ? sys.indexOf(b, i) : sys.length; return sys.slice(i, j < 0 ? sys.length : j) }
    fs.writeFileSync(path.join(OUT, 'cls-scope.txt'), sec('## Scope', '## User Intent Rule'))
    fs.writeFileSync(path.join(OUT, 'cls-environment.txt'), sec('## Environment', '## Definitions'))
    fs.writeFileSync(path.join(OUT, 'cls-definitions.txt'), sec('## Definitions', '## Classification Process'))
    fs.writeFileSync(path.join(OUT, 'cls-process.txt'), sec('## Classification Process', '## Session Context'))
    const titles = (s) => [...s.matchAll(/(?:^|\n)\s*- ([A-Z][^\n:]{3,60}):/g)].map((m) => m[1])
    fs.writeFileSync(path.join(OUT, 'cls-rules.json'), JSON.stringify({
      SOFT_BLOCK: titles(sec('## SOFT BLOCK', '## ALLOW (exceptions)')),
      ALLOW: titles(sec('## ALLOW (exceptions)', '## Classification Process')),
    }, null, 2))
  }
}

console.log('done. output ->', OUT)
