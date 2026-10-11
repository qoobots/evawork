# 23 · EvaWork Trace 问题诊断与改进清单

> 上游依据：`20`–`22` 号文档（会话 `s1`，11 步完整任务）
> 落地对象：`apps/agent-ts`（`spill.ts` / `prompt.ts` / `tools.ts` / `llm.ts` / `loop.ts` / `rules.ts` / `terminal.ts`）
> 与 Claude Code 的横向对照见 `19` 号文档

---

## 1. 一句话结论

这次任务 **11 步里有 4 步（36%）没有任何新信息产出**：3 步是"读溢出文件又触发一次溢出"（step 5 / 9 / 10），1 步是命令失败（step 6）。

而且到最后，**文件中间 44 行（第 101–144 行，约 11,964 字符 ≈ 全文 60%）始终没进过上下文**——模型只读到了首 100 行和末 50 行，任务却要求"用简单的话总结"。

不是模型笨，是运行时给它的反馈让它只能这么走。

---

## 2. 问题清单

| # | 问题 | 严重度 | 落点 |
|---|---|---|---|
| P0-1 | **递归溢出**：读溢出文件本身会再次溢出，形成链 | 高 | `spill.ts` |
| P0-2 | `run_command` 返回 PowerShell CLIXML 噪音 | 高 | `terminal.ts` / `tools.ts` |
| P0-3 | 工具名清单重复进提示词（2,329 字符，占 20.5%） | 中 | `prompt.ts` |
| P1-4 | 项目规则占系统提示词 71%，且被硬截断在句子中间 | 中 | `rules.ts` |
| P1-5 | trace 无 token / 缓存 / 耗时，上下文经济学不可度量 | 中 | `llm.ts` |
| P1-6 | 未按角色裁剪工具集（70 个全给） | 中 | `boot.ts` / `subagent.ts` |
| P1-7 | 无中途注入 / 后台完成通知 / "非用户输入"声明 | 中 | `loop.ts` / `jobs.ts` |
| P2-8 | 无显式 handback、Skill 注册表、安全分类器 | 低 | 见 `19` 号文档 |

---

## 3. P0-1 · 递归溢出（最重要）

### 3.1 证据

`scripts/ev-out/steps.txt`：

```
step 3   read_text_file(agent-architecture-paper.md)                  → 20000 字符 → 溢出 → l24b.txt
step 5   read_text_file(.eva-spill/out-…-l24b.txt,      tail: 500)    → 20000 字符 → 溢出 → ylp9.txt
step 8   read_text_file(agent-architecture-paper.md,    tail: 100)    → 10377 字符 → 溢出 → int7.txt
step 9   read_text_file(.eva-spill/out-…-int7.txt,      head: 300)    → 10376 字符 → 溢出 → 7aoh.txt
step 10  read_text_file(.eva-spill/out-…-7aoh.txt)                    → 10376 字符 → 溢出 → lfpm.txt
```

两条链：

```
链 A：论文(20000) ──溢出──> l24b.txt ──读 tail:500──> ylp9.txt
链 B：论文 tail:100(10377) ──溢出──> int7.txt ──读 head:300──> 7aoh.txt ──读全文──> lfpm.txt
```

**step 9、step 10 读的是溢出文件，读出来的结果又是一个溢出文件。** 模型每次只拿到 1,297 字符（其中 1,200 是 head）+ 一个新指针，什么新信息都没有。

### 3.2 根因

`spill.ts` 的提示是"**按行区间读，别一次读全部**"，但：

1. 它没告诉模型**这个文件有多少行 / 多少字符**，模型只能猜；
2. `head` / `tail` 的单位是**行**，而溢出阈值 8,000 是**字符**——模型猜的 300 / 500 行，换算成字符远超 8,000；
3. `maybeSpill()` 对**读溢出文件的结果一视同仁**，没有豁免。溢出文件本来就是"已经溢出过的内容"，再溢一次纯属浪费。

### 3.3 修复建议（按性价比排序）

**(a) 溢出文件豁免**——最小改动，立刻止血：

```ts
// spill.ts
export const SPILL_DIR_NAME = ".eva-spill"

/** 读溢出文件的结果不再溢出：它本来就是"已经溢出过的内容"，再溢一次等于把
 *  模型推向死循环（实测：读 spill → 又 spill → 再读，连烧 3 步零进展）。 */
export function maybeSpill(workspace: string, text: string, limit = SPILL_LIMIT, srcPath?: string): SpillResult {
  const isSpillFile = srcPath ? srcPath.replace(/\\/g, "/").includes(`/${SPILL_DIR_NAME}/`) : false
  if (!isSpillFile && text.length <= limit) return { text, chars: text.length }
  if (isSpillFile && text.length <= limit * 4) return { text, chars: text.length }
  // …原逻辑
}
```

**(b) 溢出提示给出"安全窗口"，按字符而不是让模型猜行数**：

```ts
// 现在的文案
`完整内容在 \`${p}\`，需要更多细节时用 read_file 读它（按行区间读，别一次读全部）。`

// 改成
`完整内容在 \`${p}\`（共 ${chars} 字符 / ${lines} 行）。` +
`单次读取请控制在 ${safeLines} 行以内（约 ${safeChars} 字符），否则仍会溢出；` +
`需要中段就用 offset/limit 分段取。`
```

其中 `safeChars ≈ limit * 0.6`，`safeLines = 按平均行长换算`。

**(c) 溢出时回贴 head + tail，而不是只有 head**：

```ts
const head = text.slice(0, 800)
const tail = text.slice(-400)
return `${head}\n\n…（中段省略 ${chars - 1200} 字符）…\n\n${tail}\n\n完整内容在 \`${p}\`…`
```

成本几乎不变，但模型一次就能看到"开头讲了什么、结尾落到哪"——对"总结文件"这类任务，这往往就够了。本会话如果有 tail，step 11 那次 `tail: 50` 就可以省掉。

**(d) 长期**：把超大文件**预切成段**存盘（`out-xxx.txt` + `out-xxx.segments.json`），溢出提示里给出段索引，模型按段号取。这比让模型自己算行数可靠得多。

### 3.4 验收标准

重跑同类任务（读一个 20 K 字符的文件并总结），要求：

- 溢出链长度 ≤ 1（不出现"读溢出文件又溢出"）；
- 完成同样的任务步数 ≤ 6（本次 11 步）；
- 文件各段（首/中/尾）都被覆盖到。

---

## 4. P0-2 · `run_command` 的 CLIXML 噪音

### 4.1 证据

step 6 失败，返回 1,177 字符：

```
执行失败：退出码 1
#< CLIXML
<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">
  <Obj S="progress" RefId="0"><TN RefId="0">
    <T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN>
  <MS><I64 N="SourceId">1</I64><PR N="Record"><AV>正在准备首次使用模块。</AV>…
<S S="Error">wc : 无法将“wc”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。…
```

**有用信息只有一句"wc 无法识别"，其余 ~1,100 字符是 PowerShell 的进度对象序列化。**

step 7 成功（返回 `194`），398 字符里同样混着一段 CLIXML 进度包。

### 4.2 危害

- 直接吃掉上下文（本会话这两步共 1,575 字符，占最终上下文 5%）；
- 更糟的是**稀释了真正的错误信息**——模型要在一大段 XML 里找到那一行；
- 一步步累积，在长任务里是纯负担。

### 4.3 修复建议

在 `terminal.ts` 的 PowerShell 调用侧做三件事：

```powershell
$ProgressPreference = 'SilentlyContinue'     # 关掉进度流
$ErrorActionPreference = 'Continue'
<实际命令> 2>&1 | Out-String                  # 合并并纯文本化
```

并在返回前**剥离 `#< CLIXML …` 块**（正则去掉 `#< CLIXML` 到结尾的 XML，或从 XML 里只抽取 `<S S="Error">` 内容）。

失败时只保留：

```
执行失败：退出码 1
wc : 无法将“wc”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。请检查名称的拼写…
```

**顺带**：`wc -l` 在 Windows 上不存在，模型是从 Unix 习惯出发猜的。可以在系统提示词的 `tools` 节补一句"本平台是 Windows/PowerShell，`wc`/`ls`/`grep` 等 Unix 命令不可用，请用 PowerShell 等价写法"——一句就能省掉一整步。

### 4.4 验收标准

- 一次 `run_command` 的失败输出 ≤ 300 字符；
- 输出里不含 `#< CLIXML`；
- 模型的下一步不再出现"换个 Unix 命令再试一次"。

---

## 5. P0-3 · 工具名清单重复进提示词

### 5.1 证据

系统提示词 `tools` 节共 2,329 字符，其中 2,327 字符是 70 个工具名的平铺：

```
可用工具：run_command, web_fetch, terminal, delegate, job_start, …, mcp__Everything_______simulate-research-query
```

而**同样的名字已经随 `tools` 数组的 JSON Schema 送给了模型**（`llm.ts`：`body.tools = schemas`）。

> Claude Code 不做这件事：它的 system 提示词里一个工具名都没有，全靠 schema 承载。

### 5.2 成本

2,329 字符 × 11 步 = **25,619 字符**，占本会话总发送量的 11.6%。

### 5.3 修复建议

`prompt.ts` 的 `tools` 节改成只留**语义提示**，去掉名字清单：

```ts
{
  id: "tools",
  render: (c) =>
    join([
      // 不再列名字：schema 里已经有了，重复一遍是纯成本
      c.tools.includes("terminal")
        ? "terminal 的当前目录会跨命令保持；run_command 每条都重置回工作区根。"
        : null,
      c.tools.includes("run_command")
        ? "本平台是 Windows/PowerShell：run_command 走 PowerShell，不要用 wc/ls/grep 等 Unix 命令。"
        : null,
      c.tools.includes("job_start")
        ? "慢活（构建/测试）用 job_start 放后台，立刻拿 id，不要干等。"
        : null,
      c.tools.includes("delegate")
        ? "独立的小任务可以派给子代理：它有自己的上下文，看不到这里的对话历史。"
        : null,
      "工具返回失败时先读错误原因再决定下一步，盲目重试只会重复失败。",
    ]),
}
```

### 5.4 验收标准

- 系统提示词从 11,351 降到约 9,000 字符以下；
- 模型仍能正确选用工具（回归测试：分别触发一次 `terminal` / `job_start` / `delegate` 类任务）。

---

## 6. P1-4 · 项目规则占 71% 且被硬截断

### 6.1 证据

- `rules` 节 8,060 字符，占系统提示词 **71.0%**；
- 单层上限 `PER_LAYER_MAX = 8_000`，超限后 `clean.slice(0, 8000)` **直接切在句子中间**，只补一句 `（规则文件过长，已截断）`。

本会话实际截断位置：

```
- For tracing async work, instrument the function or method definition with
  `#[tracing::instrument(...)]` instead of attaching spans to futures with
  `.instrument(...)` at call sites. Before adding instrumentation, check whether the callee—or
  the implementation method it immedi
（规则文件过长，已截断）
```

模型看到的是**一条没有说完的规则**。更麻烦的是：它不知道后面还有多少、也不知道缺的是什么。

### 6.2 修复建议（三选一，从上到下成本递增）

**(a) 按段落边界截断**（最小改动）：

```ts
const cut = (s: string, max: number): { text: string; truncated: boolean } => {
  if (s.length <= max) return { text: s, truncated: false }
  const slice = s.slice(0, max)
  const br = slice.lastIndexOf("\n")           // 退到最后一个换行
  return { text: slice.slice(0, br > max * 0.6 ? br : max), truncated: true }
}
```

并把提示语改得更可用：`（规则文件过长，已按段落截断，全文见 <路径>；需要完整版请用 read_file 读它）`。

**(b) 注入索引而非全文**：只把每一层的**一级标题 + 路径**注入（几百字符），需要时模型自己 `read_file`。这与 Claude Code 的 Skill 注册表思路一致（清单轻量、按需加载）。

**(c) 按当前任务相关性挑 top-N**：规则文件通常有清晰的小节结构，可按用户目标做关键词打分，只注入最相关的几条。

### 6.3 验收标准

- 系统提示词里规则节 ≤ 4,000 字符，且**永不出现半句话**；
- 截断时给出可复核的路径。

---

## 7. P1-5 · trace 缺 token / 缓存 / 耗时

### 7.1 证据

trace 文件只有 7 个字段（`step` / `model` / `messages` / `stream` / `temperature` / `tools` / `toolsCount`），**没有 `usage`、没有 `durationMs`、没有响应**。

对比 Claude Code 的 trace：`prompt_tokens` / `completion_tokens` / `cached_tokens` / `durationMs` 一应俱全——**93% 的缓存命中率就是这么算出来的**。

### 7.2 后果

无法回答三个最该回答的问题：

1. 这个任务花了多少 token？
2. 缓存命中多少？（11 步里 56.5% 的字符是系统提示词重发，如果上游有前缀缓存，这部分应该大部分命中——**但现在我们不知道**）
3. 哪一步慢？

### 7.3 修复建议

`llm.ts` 的 `traceRequest()` 已经拿到了请求时机，补三项即可：

```ts
// 建议在 streamChat 结束时补写（同一文件名 + .resp 后缀，或改写同一 JSON）
{
  durationMs: Date.now() - t0,
  usage: { prompt_tokens, completion_tokens, cached_tokens },   // 从流的最后一个 chunk 取
  finishReason,
}
```

另外两个可选字段：`messages` 里每条消息的 `role` 与字符数（便于画上下文增长曲线，不必存正文），以及一个真正的 `sessionId`（现在要靠 mtime 猜会话）。

### 7.4 验收标准

- 能从 trace 直接算出"单任务 token 总量"与"缓存命中率"；
- 能画出每步的耗时分布。

---

## 8. P1-6 · 未按角色裁剪工具集

本会话 70 个工具全给，实际只用了 2 个名字。**62 个 MCP 工具的 schema 每一步都要送一遍。**

Claude Code 的做法：主智能体 27、只读子智能体 13，且子 agent 的工具集在 agent type 声明里写死。

EvaWork 已经有裁剪能力（`runTurn({ tools })` + `boot.json` 的 `exclude` / 模块开关），缺的是**策略层**。建议新增一个"只读探索"角色模板：

```ts
// boot.ts
export const TOOL_PROFILES = {
  full: undefined,                                  // 全部
  readonly: ["run_command", "terminal", "web_fetch", "job_status",
             "mcp__Filesystem__read_file", "mcp__Filesystem__read_text_file",
             "mcp__Filesystem__search_files", "mcp__Filesystem__list_directory",
             "mcp__Filesystem__get_file_info"],
}
```

并在 `delegate` 的 description 里暴露 `profile` 参数，让主 agent 能说"派一个只读的去查"。

---

## 9. P1-7 · 中途注入 / 通知 / "非用户输入"声明

`loop.ts` 里有 `inbox?: () => string[]`（每个 step 边界拉一次外部注入），但本会话没有触发，也没看到两样东西：

1. **后台任务完成时重唤醒主循环**——`job_start` 起的活儿结束了，主循环不会自动知道（现在只能靠模型自己 `job_status` 轮询）。
2. **注入消息自带"这不是用户输入"声明**——Claude Code 那段 `[SYSTEM NOTIFICATION - NOT USER INPUT]` 措辞极重，原因是模型极易把"后台任务完成了"当成"用户又同意了什么"。

建议（与 `19` 号 P0-4 / P1-7 同一项）：所有非用户来源的注入统一走一个 helper，自动加声明前缀。

---

## 10. 建议的落地顺序

```
第 1 批（1～2 天，止血）
  P0-1(a) 溢出文件豁免 + (b) 安全窗口文案 + (c) head+tail
  P0-2    CLIXML 剥离 + 补一句"Windows 没有 Unix 命令"
  P0-3    去掉提示词里的工具名清单

第 2 批（3～5 天）
  P1-4    规则按段落截断 + 可复核路径
  P1-5    trace 补 usage / durationMs
  P1-6    只读工具 profile

第 3 批（1～2 周）
  P1-7    中途注入与通知协议
  P2-8    见 19 号：handback / Skill 注册表 / 轻量安全分类器

回归验证（每批之后跑同一任务对比）
  · 完成步数（基线 11）
  · 总发送字符（基线 22.1 万）
  · 系统提示词长度（基线 11,351）
  · 溢出次数 / 溢出链长度（基线 5 / 2 条链）
  · 文件覆盖完整性（基线：中间 44 行没读到）
```

---

## 11. 复核方式

- 原始 trace：`C:\Users\Administrator\.evawork\ts-agent\trace`（需 `EVA_TS_TRACE=1` 才会写；目录是全局的、多会话混合，分析前先按时间切分）
- 解析脚本：`node scripts/ev-trace-analyze.mjs [目录] [会话序号]`
- 解析产物：`scripts/ev-out/`（`overview.txt` 会话清单与概览、`system.txt` 系统提示词、`tools.txt` 工具清单、`flow.txt` 完整对话、`steps.txt` 每步工具调用与溢出判定、`spill-chain.txt` 溢出链、`growth.txt` 上下文增长、`callstats.txt` 调用统计）——**生成物，不入库**
