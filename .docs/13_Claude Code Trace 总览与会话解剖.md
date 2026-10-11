# 13 · Claude Code Trace 总览与会话解剖

> **素材来源**：`C:\Users\Administrator\AppData\Roaming\Evacode\User\globalStorage\vscode.eva-ai\eva-ai-trace\2026-10-11`
> **样本**：单次完整任务，157 个 LLM 请求 JSON（共 71.9 MB）
> **会话窗口**：`2026-10-11T05:05:08.102Z` → `2026-10-11T05:17:29.517Z`（约 12 分 21 秒）
> **任务原文**：「你是一名智能体研究员，请研究 Codex 源代码的智能体架构设计以及实现，写一篇关于前沿智能体的论文，论文保存到项目根目录下。」
> **任务结果**：产出 `agent-architecture-paper.md`（主 agent 第 20 轮用 Write 落盘）
>
> 本文档是整套 Claude Code 逆向资料的索引与数据底座，后续 14–18 号文档按主题展开，19 号给出 EvaWork 的落地清单。

---

## 1. 一句话结论

这一份 trace 最有价值的地方不是"某个提示词写了什么"，而是它暴露了 **一个成熟 Agent 运行时是怎么被拆成若干条独立的模型调用流水线** 的：

| 流水线 | 请求数 | 模型 | 系统提示词体量 | 工具数 | 职责 |
|---|---:|---|---:|---:|---|
| 会话命名（TITLE） | 1 | qwen3.8-flash | 3.2 KB | 0 | 给会话起 2–5 词标题 |
| **主智能体（MAIN）** | 20 | qwen3.8-flash | 9.3 KB | 27 | 编排、决策、写文件 |
| **只读子智能体（SUB / Explore）** | 120 | qwen3.8-flash | 3.4 KB | 13 | 并行深读源码、回传纪要 |
| **安全守卫（SAFETY）** | 16 | qwen3.7-plus | 140.6 KB | 0 | 判定当前动作是否该阻断 |

**主智能体只占 157 次请求中的 20 次（12.7%）与 9.7% 的 prompt tokens。**

| 类别 | 请求数 | 请求占比 | prompt tokens | token 占比 | completion tokens |
|---|---:|---:|---:|---:|---:|
| MAIN | 20 | 12.7% | 844,836 | 9.7% | 21,739 |
| SUB | 120 | 76.4% | 7,207,747 | **82.9%** | 54,523 |
| SAFETY | 16 | 10.2% | 639,315 | 7.4% | 8,048 |
| TITLE | 1 | 0.6% | 835 | 0.0% | 240 |

**82.9% 的 token 消耗和 76.4% 的请求数都发生在并行子智能体里。** 这是 Claude Code 处理"大范围代码研究"这类任务的核心成本控制手段：主上下文只收结论，不收过程。

---

## 2. 单个 trace 文件的结构

每个 JSON 是一次「客户端 → 本地网关 → 上游模型」的完整往返，顶层字段如下：

| 字段 | 说明 |
|---|---|
| `id` | `2026-10-11T05:05:03.699Z#1`，`#` 后为本会话内的请求序号（1–157） |
| `ts` | 请求完成时间（ISO 8601） |
| `source` | 恒为 `claude-code` |
| `route` | 恒为 `POST /v1/messages`（Anthropic Messages API 形态） |
| `upstream` | `http://localhost:8080/api/ai/v1/chat/completions`（被转换为 OpenAI 兼容格式） |
| `model` | 实际模型：`qwen3.8-flash`（141 次）/ `qwen3.7-plus`（16 次） |
| `durationMs` | 端到端耗时 |
| `status` | HTTP 状态，全部为 200 |
| `requestSummary` | 网关生成的摘要：`messageCount` / `totalChars` / `toolCount` / 每条消息的 `role`+`chars` |
| `clientRequest` | **原始请求**（Anthropic 风格：`system` 为数组、`messages` 里可含 `system` 角色） |
| `request` | **转换后发给上游的请求**（OpenAI 兼容：`system` 为字符串、`tool_result` 变成 `tool` 角色） |
| `response` | `{ textChars, text, thinking, toolCalls, usage }` |

### 2.1 `clientRequest`（客户端原始报文）

```jsonc
{
  "model": "qwen3.8-flash",
  "messages": [ /* user / system / assistant / user(tool_result) ... */ ],
  "system": [
    "x-anthropic-billing-header: cc_version=2.1.296.7f1; cc_entrypoint=claude-vscode;",
    "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.\n\n..."
  ],
  "tools": [ /* 27 个工具 schema */ ],
  "metadata": {
    "user_id": "{\"device_id\":\"...\",\"account_uuid\":\"\",\"session_id\":\"3d306146-...\"}"
  },
  "max_tokens": 32000,
  "thinking": { "type": "adaptive", "display": "updates" },
  "context_management": { "edits": [ { "type": "clear_thinking_20251015", "keep": "all" } ] },
  "safeguards": [ { "type": "dangerous_tool_use", "classifier_context": { /* 见 18 号文档 */ } } ],
  "output_config": { "effort": "xhigh" },
  "stream": true
}
```

值得注意的几个非标准字段：

- **`system` 是数组**，且第 `[0]` 项是计费/来源头 `x-anthropic-billing-header`。把元信息藏在 system 数组首位，既不影响缓存前缀稳定性，又能让上游侧做计费归因。
- **`thinking: {type:"adaptive", display:"updates"}`**：思考是"自适应"的，由模型/网关决定深度，而不是开关。
- **`context_management.edits`**：把"清理历史 thinking 块"这类上下文编辑下沉到服务端，`keep:"all"` 表示保留其余部分。这是一个**服务端上下文管理 API** 的雏形，压缩策略不在客户端硬编码。
- **`output_config.effort: "xhigh"`**：推理档位外置为请求参数（子 agent 可用 `effort` 字段单独覆盖）。
- **`safeguards`**：随请求带上分类器所需的环境上下文（权限模式、可信目录、git 状态、规则根路径等），见 18 号文档。

### 2.2 `request`（转换后的上游报文）

网关做了一次 Anthropic → OpenAI 兼容的转换，规则可从 `130547-416-claude-code-003.json` 直接对照出来：

| clientRequest（原始） | request（上游） |
|---|---|
| `system: [header, "..."]` | `messages[0].role=system`，两段文本拼成一个字符串 |
| `messages[0] user`（`<system-reminder>` 项目指令） | `messages[1].role=user` |
| `messages[1] role=system`（`# Environment`） | `messages[2].role=user`（**system 角色被降级为 user**） |
| `messages[2] role=assistant` | `messages[3].role=assistant` |
| `messages[3] role=user`（`tool_result`） | `messages[4].role=tool` |
| `messages[4] role=system`（`# Environment update`） | `messages[5].role=user` |

即：**Claude Code 大量使用 `role=system` 的消息做"中途注入"**（环境变更、预算提示、任务通知），而这是 Anthropic API 支持、OpenAI 兼容层不支持的能力，网关统一降级成 `user`。

`requestSummary` 则是网关给 UI/可观测性用的轻量摘要：

```json
{ "messageCount": 6, "totalChars": 48945, "toolCount": 27,
  "messages": [ {"index":0,"role":"system","chars":9394}, ... ] }
```

### 2.3 `response`

```json
{ "textChars": 63,
  "text": "我先梳理一下任务：研究 Codex 源码中的智能体架构与实现……",
  "thinking": "The user wants me, as an agent researcher, to investigate ...",
  "toolCalls": [ { "name": "Bash", "input": { "command": "ls -d /d/...", "description": "..." } } ],
  "usage": { "prompt_tokens": 28533, "completion_tokens": 1451,
             "prompt_tokens_details": { "cached_tokens": 0, "text_tokens": 835 } } }
```

`thinking` 与 `text` 被**分字段记录**：思考过程也进上下文（作为 assistant 消息里的 `{"type":"thinking"}` 块），但对用户是"更新式"展示（`display:"updates"`）。

---

## 3. 全局统计

| 指标 | 数值 |
|---|---|
| 请求总数 | 157 |
| Prompt tokens 总计 | **8,692,733** |
| Completion tokens 总计 | 84,550 |
| **缓存命中 tokens** | **8,084,096（93.00%）** |
| 单请求最大 prompt tokens | 103,369 |
| 单请求最大 messages 字符数 | 351,363 |
| 单次耗时 min / avg / max | 1,908 ms / 9,647 ms / 185,752 ms |
| 耗时求和 | 1,514,596 ms（≈25.2 分钟，因并行而远大于 12 分钟的墙钟窗口） |
| 失败请求 | 0 |

**93% 的缓存命中率是整套设计里最硬的一个指标。** 它意味着绝大部分请求是"同样的前缀 + 一小段新尾巴"，前缀就是：system 提示词 + 项目指令 + 环境描述 + 已积累的对话。Claude Code 的一切上下文操作（只追加不重写、把动态信息塞进独立的尾部消息、子 agent 独立上下文）都在为这个数字服务。

---

## 4. 四类请求的识别方法

分类不靠猜，靠三个可判定的特征：

| 类别 | 判据 | 数量 |
|---|---|---:|
| TITLE | `clientRequest.output_config.format.type === "json_schema"`，无 tools | 1 |
| MAIN | `clientRequest.tools.length === 27` | 20 |
| SUB | `clientRequest.tools.length === 13`，且 system 首行带 `cc_is_subagent=true` | 120 |
| SAFETY | `clientRequest.stop_sequences` 非空（`["</block>"]`），无 tools | 16 |

四类请求的 system 提示词内容两两完全不同（MD5 可分），说明**每一类都是独立维护的提示词资产**，不是一份模板加变量。

---

## 5. 这次任务的真实编排过程

按时间线还原（时间点取 `ts`，仅列关键节点）：

```
05:05:08  #1  TITLE    生成会话标题 → "Codex 智能体架构论文"
05:05:11  #2  MAIN     读 AGENTS.md + 环境，先 ls 看仓库结构
05:05:47  #3  MAIN     一次性并行派 2 个 Explore 子 agent（核心主循环 / 工具与沙箱）
05:05:53  #4  SAFETY   对上一步的 ls 命令做安全判定 → <block>no
05:05:56  #5  SUB      [子A] 开始读 codex-rs/core/src/**
05:06:03  #7  SUB      [子A] 继续
05:06:13  #8  SUB      [子A] 继续
05:06:17  #6  MAIN     发现第 2 个 agent 因 JSON 转义失败 → 修正后重派，并追加派第 3 个
05:06:35  #11 SAFETY   对 Agent 调用做判定 → <block>no
...
05:06:59  #22 MAIN     派第 4 个子 agent（多智能体与扩展机制）
...                    （4 个子 agent 共 120 轮并行推进，主 agent 期间穿插做自己的事实核查）
05:07:17  #43 MAIN     自己跑 Bash 统计 crate 数量 / 行数 / 找 prompts 模板
05:07:35  #55 SAFETY   对 Bash 判定 → <block>no
...
05:15:xx  #40/#42/#44  MAIN   陆续收到子 agent 的 SubagentHandback 纪要，每收到一份就
                              在主上下文里"摘录要点"写一条 assistant 消息
05:16:xx  #46 MAIN     四份齐了 → 自己跑 sed/grep 抽查 4 处关键证据锚点
05:17:17  #156 MAIN    Write 写出 agent-architecture-paper.md（耗时 185.7 s，最长的一次）
05:17:29  #157 MAIN    向用户汇报：论文结构 + 研究过程说明
```

可提炼出的编排模式：

1. **先探路再派活**：主 agent 第 1 轮只用 1 次 `Bash` 摸清仓库骨架，第 2 轮才拆任务派出子 agent。
2. **子 agent 后台化 + 主 agent 不空转**：派完 4 个后台 agent 后，主 agent 自己去核对"crate 数量、代码行数、prompt 模板位置"这些**不会被子 agent 覆盖的公共事实**（thinking 里明确写了"子 agent 会覆盖 X，我不重复做"）。
3. **结论落地为 assistant 消息**：每收到一份子 agent 纪要，主 agent 就在上下文里写一段"要点摘录"，把子 agent 的长报告压缩成可长期引用的短结论。这是对抗上下文膨胀的关键动作。
4. **交付前抽查**：写完论文前，自己用 `sed -n` 验证 4 处 `文件:行号` 证据是否属实。
5. **失败自愈**：第 2 个 `Agent` 调用因 Windows 路径 `d:\...` 在 JSON 里转义不当被 `InputValidationError` 拒绝，主 agent 下一轮改用 `D:/...` 正斜杠重发——错误直接作为 `tool_result` 回到上下文，不需要人工介入。

---

## 6. 子智能体的成本占比（重要）

| 类别 | 请求数 | 占比 | prompt tokens | token 占比 |
|---|---:|---:|---:|---:|
| MAIN | 20 | 12.7% | 844,836 | 9.7% |
| SUB | 120 | 76.4% | 7,207,747 | 82.9% |
| SAFETY | 16 | 10.2% | 639,315 | 7.4% |
| TITLE | 1 | 0.6% | 835 | 0.0% |

主 agent 的 prompt tokens 曲线：`28,533 → 30,269 → 32,286 → 34,170 → … → 57,911 → 68,940`，20 轮只涨到 69 K。
子 agent 单条最长跑到 **103,369** prompt tokens（第 150 号请求，最多 60+ 轮工具调用）。

**结论**：长程探索的成本被下推到"可回收、可丢弃"的子上下文里，主上下文始终保持在一个小而稳定的规模。这正是 EvaWork `subagent.ts` 已经做对的方向（独立上下文 + 硬顶步数），但还可以再往前走两步——见 19 号文档。

---

## 7. 配套文档索引

| 文档 | 内容 |
|---|---|
| `14_Claude Code 系统提示词全解析.md` | 四类 system prompt 全文与逐段设计解读 |
| `15_Claude Code 工具系统与MCP.md` | 28 个工具的完整 schema、分组、MCP 命名与最小权限裁剪 |
| `16_Claude Code 技能与子智能体编排.md` | Skill 注册表、6 种 agent 类型、子 agent 全生命周期与通知协议 |
| `17_Claude Code 上下文工程与缓存.md` | 消息装配顺序、system-reminder 约定、93% 缓存命中怎么来的 |
| `18_Claude Code 安全守卫与权限模型.md` | 独立小模型分类器、67 条 SOFT BLOCK、17 条 ALLOW、输出协议 |
| `19_EvaWork 借鉴 Claude Code 改进清单.md` | 对照 `apps/agent-ts` 现状的可执行改进项 |

> 原始解析产物（供复核）保留在 `scripts/cc-out/`：`step1.txt`、`step2.txt`、`bridge.txt`、`tools.json`、`tools.md`、`tools-brief.md`、`curve.txt`、`main-flow.txt`、`sub-flow.txt`、`classifier.txt`、`classes/*`。
