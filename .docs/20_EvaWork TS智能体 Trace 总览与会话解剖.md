# 20 · EvaWork TS 智能体 Trace 总览与会话解剖

> **素材**：`C:\Users\Administrator\.evawork\ts-agent\trace`（由 `apps/agent-ts/src/llm.ts` 的 `traceRequest()` 在 `EVA_TS_TRACE=1` 时落盘）
> **本次分析对象**：会话 `s1` —— 11 个请求、19:11:11 → 19:11:55（44 秒）的完整任务
> **任务**：「总结文件内容：agent-architecture-paper.md，用简单的话总结」
> **工作区**：`D:\05workspaces\codex`　**模型**：`qwen3.7-plus`　**temperature**：0.7
>
> 本文档是 EvaWork 智能体自身 trace 的逆向资料索引，21–23 号按主题展开。
> 与 Claude Code 的对照参考 `13`–`19` 号文档。

---

## 1. Trace 文件格式

每个 JSON 是**一次模型请求的完整 body**（不是响应），顶层 7 个字段：

| 字段 | 值（本会话） | 说明 |
|---|---|---|
| `step` | 1–11 | 循环步号，与 `loop.ts` 的 `steps` 一致 |
| `model` | `qwen3.7-plus` | 实际使用的模型 |
| `messages` | 2 → 22 条 | 完整上下文（OpenAI 兼容格式） |
| `stream` | `true` | |
| `temperature` | `0.7` | |
| `tools` | 70 个**名字** | 见下方"瘦身"说明 |
| `toolsCount` | 70 | |

### 1.1 `tools` 只留名字

`llm.ts` 的注释写明了原因：

> **瘦身**：`tools` 的 schema 是文件体积的绝对大头——100+ 个插件 / 技能 / MCP 工具，每个几十行 JSON，堆起来比整段对话还长；但它对本机几乎不变，调提示词时真正要看的是 messages。所以这里只留工具**名字**（外加一个数量）。

即：**真正发给模型的请求里带完整 JSON Schema，落盘的 trace 只记名字。** 分析时要注意别把 `tools: ["run_command", ...]` 当成"模型只看到了名字"。

### 1.2 与 Claude Code trace 的格式对比

| | EvaWork | Claude Code |
|---|---|---|
| 记录内容 | 仅请求（`messages` / `tools`） | 请求 + 响应 + `usage` + `durationMs` |
| 工具 schema | 剥离为名字 | 完整保留 |
| token / 缓存统计 | **无** | `prompt_tokens` / `cached_tokens` / `completion_tokens` |
| 耗时 | 无（需靠文件 mtime 推） | `durationMs` |
| 会话区分 | 无显式字段（需按时间切分） | `metadata.user_id.session_id` |
| 响应文本 / 工具调用 | 不记（可从下一步的 `messages` 反推） | `response.text` / `response.toolCalls` |
| 安全/守卫流水线 | 无 | 独立 `safeguards` 请求 |

**可观测性差距**：EvaWork 的 trace 能回答"发了什么"，但不能回答"花了多少 token / 缓存命中多少 / 哪一步慢"。这三项恰恰是上下文工程最需要度量的量——Claude Code 那份 trace 里 93% 的缓存命中率就是靠 `usage` 字段算出来的。

### 1.3 会话怎么切分

文件名形如 `req-<step>-<随机id>-<seq>.json`。**中间的随机 id 每次请求都变，不是会话号**；`seq` 是**进程内**计数器，跨会话会重合。所以只能按文件 mtime 排序、遇 `step` 回退即切新会话。

本次目录下切出 4 个会话：

| 会话 | 步数 | 时间 | 任务 |
|---|---:|---|---|
| **s1** | **11** | 19:11:11 → 19:11:55 | 总结文件内容：agent-architecture-paper.md，用简单的话总结 |
| s2 | 4 | 19:23:35 → 19:23:48 | 研究 Codex 源码，写一篇论文名为「Codex前沿智能体.md」 |
| s3 | 9 | 19:24:44 → 19:26:07 | 同上（重试，分析时仍在跑） |
| s4 | 2 | 19:26:36 → 19:26:43 | Read and summarize the following files from the Codex codeba… |

> 提示：trace 目录是**全局的、只增不减**，多个会话混在一起。做分析前务必先切分，否则会把不同任务的消息拼成一段不存在的"对话"。

---

## 2. 本次任务解剖（11 步）

```
19:11:11  step 1   [2 msgs]   收到任务，无任何工具调用
19:11:26  step 2   [4]        search_files **/agent-architecture-paper.md → 命中 1 个文件
19:11:29  step 3   [6]        read_text_file 全文（20000 字符）→ **触发溢出**，落 .eva-spill/out-…-l24b.txt
19:11:31  step 4   [8]        读溢出文件 head:100 → 4018 字符，拿到开头
19:11:34  step 5   [10]       读溢出文件 tail:500 → 又是 20000 字符 → **再次溢出**
19:11:39  step 6   [12]       run_command `wc -l …` → **失败**（Windows 没有 wc）
19:11:44  step 7   [14]       run_command `(Get-Content …).Count` → 得到 194 行
19:11:47  step 8   [16]       read_text_file tail:100 → 10377 字符 → **再次溢出**
19:11:49  step 9   [18]       读溢出文件 head:300 → 10376 字符 → **再次溢出**
19:11:52  step 10  [20]       读溢出文件（不带范围）→ 10376 字符 → **再次溢出**
19:11:55  step 11  [22]       read_text_file tail:50 → 4018 字符，拿到结尾（终于不再溢出）
                              ↓
                   模型返回正文（无工具调用）→ 循环结束，不再发请求
```

### 2.1 三个一眼可见的事实

1. **10 次工具调用里 7 次是 `read_text_file`**，其中 **5 次触发溢出**，而**有 3 次是在读溢出文件本身**（step 5 / 9 / 10）——每次拿回来的还是"1200 字符 head + 一个新指针"。
2. **模型从头到尾没读到文件中段**。文件当时为 194 行 / 约 20,000 字符；step 4 拿到 `head:100`（4,018 字符）、step 11 拿到 `tail:50`（4,018 字符），**中间 44 行（第 101–144 行，约 11,964 字符 ≈ 全文 60%）始终没进上下文**。任务要求"用简单的话总结"，最终只能基于首尾作答。
3. **每一步只发一个工具调用**。11 步里没有一次并行（对比 Claude Code 的子 agent 响应里常见 `Read+Read`、`Grep+Grep` 并行）。

### 2.2 上下文增长

| step | 消息数 | 总字符 | 本轮新增 | 说明 |
|---:|---:|---:|---:|---|
| 1 | 2 | 11,503 | +11,503 | system 11,459 + user 42 |
| 2 | 4 | 11,823 | +320 | 工具结果只有 49 字符 |
| 3 | 6 | 13,415 | +1,592 | 溢出：可见 1,297 |
| 4 | 8 | 17,798 | +4,383 | 读到 4,018 字符 |
| 5 | 10 | 19,410 | +1,612 | 又溢出 |
| 6 | 12 | 20,870 | +1,460 | `wc` 失败，1177 字符全是 CLIXML 噪音 |
| 7 | 14 | 21,542 | +672 | 拿到 `194` |
| 8 | 16 | 23,124 | +1,582 | 又溢出 |
| 9 | 18 | 24,711 | +1,587 | 又溢出 |
| 10 | 20 | 26,283 | +1,572 | 又溢出 |
| 11 | 22 | 30,624 | +4,341 | 读到结尾 |

**总量**：11 次请求累计发送 **221,103 字符**（`JSON.stringify` 计），11 个 trace 文件共 343 KB。
其中 **系统提示词一项就占 126,049 字符（57.0%）**——它被原封不动重发了 11 次。

---

## 3. 全局统计

| 指标 | 数值 |
|---|---|
| 请求数 / 步数 | 11 |
| 墙钟 | 44 秒（19:11:11 → 19:11:55） |
| 模型 / 温度 | qwen3.7-plus / 0.7 |
| 工具总数 | **70**（内置 8 + MCP 62） |
| 系统提示词 | **11,351 字符，11 步一字未变** |
| 上下文峰值 | 22 条消息 / 30,624 字符 |
| 工具调用次数 | 10（`read_text_file`×7、`run_command`×2、`search_files`×1） |
| 溢出次数 | **5 次**，生成 5 个溢出文件 |
| 失败调用 | 1（`wc` 命令不存在） |
| 并行调用 | 0 |
| 子 agent / 后台任务 | 0（`delegate` / `job_*` 全程未用） |

---

## 4. 与 Claude Code 同场景的对照

Claude Code 那份 trace 是一个**研究型大任务**（157 请求、12 分钟、4 个并行子 agent）；EvaWork 这份是**小任务**（11 请求、44 秒）。规模不可直接比，但机制差异很清楚：

| 维度 | EvaWork（本会话） | Claude Code |
|---|---|---|
| 长输出处理 | 溢出到 `.eva-spill/`，回贴 head 1200 + 指针 | `Read` 默认 2000 行上限 + 子 agent 只读摘要 |
| 溢出后遗症 | **读溢出文件会再次溢出**，形成链 | 无此机制 |
| 工具清单 | 70 个名字写进提示词（2,329 字符） | 不写，只靠 schema |
| 项目规则 | 分层加载（用户/项目/目录），单层 8,000 上限，超限截断 | 单个 `<system-reminder>` 全量注入 |
| 子 agent | 有 `delegate`，本会话未用 | `Agent` + 6 种 agent type，大量使用 |
| 后台任务 | `job_start/status/wait/cancel`，本会话未用 | `run_in_background` + 完成通知重唤醒 |
| 安全判定 | 无独立流水线 | 独立小模型分类器（16 次，fail-closed） |
| 缓存度量 | **无** | 93% 命中率可见 |
| 步数上限 | 无（`loop.ts` 刻意不设步数上限，只设墙钟 15 分钟 + 连续 12 步无进展） | 20 轮主循环 + 子 agent 硬顶 |

---

## 5. 配套文档索引

| 文档 | 内容 |
|---|---|
| `21_EvaWork 系统提示词与上下文装配.md` | 分节结构、长度占比、规则分层、装配顺序、压缩策略 |
| `22_EvaWork 工具系统与MCP集成.md` | 8 内置工具、5 个 MCP server 共 62 工具、模块开关、审批分类 |
| `23_EvaWork Trace 问题诊断与改进清单.md` | 本次 trace 暴露的 8 个问题与可执行的修复项 |

> 解析产物（生成物，不入库）在 `scripts/ev-out/`：`overview.txt`、`system.txt`、`tools.txt`、`flow.txt`、`steps.txt`、`spill-chain.txt`、`growth.txt`、`callstats.txt`。
> 解析脚本：`scripts/ev-trace-analyze.mjs`（`node scripts/ev-trace-analyze.mjs [目录] [会话序号]`）。
