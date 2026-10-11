# 17 · Claude Code 上下文工程与缓存策略

> 素材：`scripts/cc-out/curve.txt`（157 次请求的 sys/msg 字符数与 token 明细）、`main-flow.txt`、`bridge.txt`、`main-msg-0.txt` / `main-msg-1.txt`

---

## 1. 实测：93% 的缓存命中率

| 指标 | 数值 |
|---|---|
| Prompt tokens 总计 | 8,692,733 |
| 其中命中缓存 | 8,084,096 |
| **缓存命中率** | **93.00%** |
| 实际"新鲜" token | ≈ 608,637（7%） |

这意味着：**157 次请求里，平均每次只有约 3,900 个 token 是真正需要重新计算的**。剩下 51,000 个 token/次全部命中前缀缓存。

下面这张表是主智能体 20 轮的完整曲线（`sys` = system 数组字符数，`msg` = messages 字符数）：

| # | sys | msg | promptTok | cached | fresh | 耗时 |
|---:|---:|---:|---:|---:|---:|---:|
| 2 | 9,265 | 33,448 | 28,533 | 0 | 28,533 | 7.9 s |
| 3 | 9,265 | 38,515 | 30,269 | 27,648 | 2,621 | 32.3 s |
| 6 | 9,265 | 45,005 | 32,286 | 29,696 | 2,590 | 24.1 s |
| 22 | 9,265 | 50,632 | 34,170 | 32,256 | 1,914 | 17.5 s |
| 43 | 9,265 | 54,262 | 35,405 | 34,048 | 1,357 | 4.4 s |
| 48 | 9,265 | 57,168 | 36,207 | 34,816 | 1,391 | 8.5 s |
| 66 | 9,265 | 58,746 | 36,685 | 35,840 | 845 | 3.0 s |
| 75 | 9,265 | 59,338 | 36,868 | 35,840 | 1,028 | 5.1 s |
| 86 | 9,265 | 60,446 | 37,222 | 36,864 | 358 | 6.6 s |
| 91 | 9,265 | 63,827 | 38,118 | 36,864 | 1,254 | 4.0 s |
| 94 | 9,265 | 68,805 | 39,348 | 37,888 | 1,460 | 4.3 s |
| 99 | 9,265 | 70,728 | 39,844 | 38,912 | 932 | 8.4 s |
| 103 | 9,265 | 73,947 | 40,758 | 39,424 | 1,334 | 2.9 s |
| 134 | 9,265 | 81,468 | 43,515 | 39,936 | 3,579 | 9.1 s |
| 138 | 9,265 | 91,622 | 47,266 | 43,008 | 4,258 | 8.7 s |
| 151 | 9,265 | 100,835 | 50,587 | 47,104 | 3,483 | 10.3 s |
| 153 | 9,265 | 111,106 | 54,205 | 50,176 | 4,029 | 26.6 s |
| 154 | 9,265 | 120,824 | 56,699 | 53,760 | 2,939 | 23.7 s |
| 156 | 9,265 | 125,590 | 57,911 | 56,320 | 1,591 | 185.8 s |
| 157 | 9,265 | 150,423 | 68,940 | 57,344 | 11,596 | 10.5 s |

三个可直接观察到的规律：

1. **`sys` 恒为 9,265**，20 轮一字未变。前缀的第一段锁死。
2. **`cached` 单调递增且从不回退**（0 → 57,344），且以 **256 token 为粒度阶梯上升**。这说明上游的缓存是"前缀命中长度"语义：只要前缀不变，命中长度就只增不减。
3. **`fresh` 通常只有 1–4 K**，只有两处例外：第 2 轮（首轮，全量）和第 157 轮（11,596，因为上一条 assistant 消息里塞进了整篇论文的 `Write` 调用入参）。

> 推论：**每轮新增的内容越集中在尾部、越连续，缓存越好。** 任何"修改历史消息"的操作都会让 `cached` 掉回去——Claude Code 显然严格避免了这一点。

---

## 2. 上下文是怎么装配的

一次请求的完整结构（`clientRequest`）：

```
system[]                       ← 计费头 + 身份/规则提示词（恒定）
  [0] x-anthropic-billing-header: cc_version=2.1.296.7f1; cc_entrypoint=claude-vscode;
  [1] You are Claude Code, ...（9,267 字符，见 14 号文档）

messages[]
  [0] role=user   33,448 字符
        <system-reminder> 项目指令 AGENTS.md 全文（OVERRIDE 声明） </system-reminder>
        <system-reminder> gitStatus（分支/主分支/用户/状态/最近提交） </system-reminder>
        用户真实提问：「你是一名智能体研究员，请研究 Codex 源代码…」
  [1] role=system  9,258 字符
        # Environment（工作目录/平台/Shell/OS/下载文件警告）
        You are powered by the model qwen3.8-flash.
        Available agent types for the Agent tool: …（6 种）
        The following skills are available for use with the Skill tool: …（12 个）
        <total_tokens>15000000 tokens left</total_tokens>
        Today's date is 2026-10-11.
  [2] role=assistant   ← 上一轮的 thinking + 文本 + tool_use
  [3] role=user        ← 上一轮的 tool_result
  [4] role=system  49~1,404 字符  ← 中途注入（见 3.2）
  [N] …循环
```

### 2.1 `system-reminder` 约定

**第一类：项目指令**（放在第 1 条 user 消息里，用 `<system-reminder>` 包裹）

```text
<system-reminder>
Codebase and user instructions are shown below. Be sure to adhere to these instructions.
IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them
exactly as written.

Contents of d:\05workspaces\codex\AGENTS.md (project instructions, checked into the codebase):
  …（AGENTS.md 全文，本次约 24 KB）
</system-reminder>
```

注意三点：

- **"OVERRIDE any default behavior"** 的措辞是必须的——否则模型会把项目规则和内置规则平级对待。
- 明确指出来源文件与性质：`(project instructions, checked into the codebase)`。
- 项目指令放在 **user 角色**而不是 system 角色里，这样它在整个会话里只出现一次、位置固定在最前，天然成为缓存前缀的一部分。

**第二类：git 状态快照**

```text
<system-reminder>
As you answer the user's questions, you can use the following context:
# gitStatus
This is the git status at the start of the conversation. Note that this status is a
snapshot in time, and will not update during the conversation.

Current branch: main
Main branch (you will usually use this PRs): main
Git user: Administrator
Status: ?? .eva-spill/  ?? .evawork/  …
Recent commits: be33f80bc …（5 条）

Claude Code attached this context automatically; it isn't part of the user's message.
It describes the user's own account and workspace, so they don't need it reported back.
</system-reminder>
```

三处措辞都值得抄：① 明确"这是快照、不会更新"（防止模型把它当实时状态）；② 明确"自动附加、不是用户消息"；③ 明确"不需要回报给用户"。

**第三类：注册表**（Skills、Agent types，见 16 号文档）。

**第四类：交付协议**（子 agent 的任务描述末尾追加）：

```text
<system-reminder>
Your final report is delivered through SubagentHandback: when your work is complete,
call SubagentHandback({message: <your full report>}). The call ends your run, so make
it your last step. Only a SubagentHandback call reaches your caller as your result;
plain text you write at the end is not delivered.
</system-reminder>
```

> **模式总结**：`<system-reminder>` 是 Claude Code 唯一的"运行时注入通道"。所有动态内容——项目规则、git 状态、技能表、agent 类型表、交付协议——都用它包裹。好处是语义统一（模型知道"这是系统给的，不是用户说的"）、可裁剪、且位置可控（追加在末尾或固定在开头）。

### 2.2 中途注入：`role=system` 消息

这是 Claude Code 能在不破坏缓存的前提下**动态改变规则**的关键。本次会话出现的三种：

| 内容 | 长度 | 触发时机 |
|---|---:|---|
| `# Environment update`<br>` - Primary working directory: D:\05workspaces\codex (was d:\05workspaces\codex)`<br>`<total_tokens>15000000 tokens left</total_tokens>` | 151 | 工作目录大小写被规范化后 |
| `<total_tokens>15000000 tokens left</total_tokens>` | 49 | **几乎每轮结束都追加一次** |
| `[SYSTEM NOTIFICATION - NOT USER INPUT] … <task-notification> …` | 1,404 | 后台子 agent 完成时 |

要点：

- **追加，不修改**。工作目录变了不是回去改 `messages[1]` 里的 `# Environment`，而是追加一条 `# Environment update`，且明确写出 `(was ...)`。
- **预算每轮刷新**：`<total_tokens>N tokens left</total_tokens>` 作为一条 49 字符的独立消息跟在每轮尾部。它极短，对缓存几乎无影响，却让模型始终知道还剩多少。
- **通知消息自带防误读声明**（见 16 号文档）。

> 对比：OpenAI 兼容层不支持 `role=system` 的中途消息，网关把它们降级成 `role=user`（见 13 号文档 2.2）。如果 EvaWork 也要走 OpenAI 兼容上游，需要评估这个降级带来的语义损失。

---

## 3. 请求级的上下文控制参数

```jsonc
{
  "max_tokens": 32000,
  "thinking": { "type": "adaptive", "display": "updates" },
  "context_management": { "edits": [ { "type": "clear_thinking_20251015", "keep": "all" } ] },
  "output_config": { "effort": "xhigh" },
  "stream": true
}
```

| 参数 | 含义与价值 |
|---|---|
| `thinking.type: "adaptive"` | 思考深度由运行时决定，不是布尔开关 |
| `thinking.display: "updates"` | 思考以"更新"形式展示给用户，而非完整流式输出 |
| `context_management.edits` | **把上下文编辑下沉到服务端**。`clear_thinking_20251015` = 清理历史 thinking 块，`keep:"all"` = 保留其余。客户端不实现压缩算法，只声明策略 |
| `output_config.effort` | 推理档位外置为参数（low/medium/high/xhigh/max），可按 agent 覆盖 |
| `stream: true` + `stream_options.include_usage` | 流式返回但保留 usage 统计 |

**`context_management` 是最值得抄的一点**：压缩/裁剪是**服务端能力**，客户端只传策略标识。这样压缩策略可以灰度、可以 A/B、可以按模型切换，而不用发版客户端。

---

## 4. 与之配套的三处缓存友好设计（从其它工具/文档里挖到的）

### 4.1 Prompt cache TTL = 5 分钟（`ScheduleWakeup` 描述原文）

```
This session's requests use the default 5-minute Anthropic prompt-cache TTL.
Sleeping past 300 seconds means the next wake-up reads your full conversation
context uncached — slower and more expensive. So the natural breakpoints:
- Under 5 minutes (60s–270s): cache stays warm. …
- 5 minutes to 1 hour (300s–3600s): pay the cache miss. …
**Don't pick 300s.** It's the worst-of-both: you pay the cache miss without
amortizing it. … Don't think in round-number minutes — think in cache windows.
```

这段直接把**运行时的经济模型**（缓存 TTL）写进工具文档，让模型自己做成本决策。

### 4.2 `WebFetch` 按 URL 缓存 15 分钟

> "Responses are cached for 15 minutes per URL."

工具级缓存，避免同一页面被反复抓取并反复占上下文。

### 4.3 子 agent 独立上下文

长程探索放在子 agent 里（120 次请求），主上下文只收结论。**子 agent 的上下文用完即弃，不会因为它的膨胀而破坏主 agent 的缓存前缀。**

---

## 5. 压缩（compaction）的对外承诺

系统提示词里只有一小段，但措辞很讲究：

```text
# Context management
When the conversation grows long, some or all of the current context is summarized;
the summary, along with any remaining unsummarized context, is provided in the next
context window so work can continue — you don't need to wrap up early or hand off
mid-task.
```

三句话分别解决三个问题：

1. **会发生什么**：部分或全部上下文会被摘要，摘要 + 未摘要部分进入下一个窗口。
2. **连续性**：工作可以继续。
3. **行为约束（最关键）**：**你不需要提前收尾，也不需要中途交接。**

第 3 句是防止"模型听说会被压缩 → 慌忙降低质量赶工"的定点防御。

EvaWork 的 `prompt.ts` 里 `context` 节目前的写法：

```
上下文是**投影**，不是长期记忆：你批量采集的信息…在预算满后，早期轮次会被整段移出对话
——之后你就看不到它们了，且不会有任何提示。
所以扫描项目、批量阅读时，**每拿到关键结论就落盘**…
若看到「早期内容已从上下文中移除」，说明前文已被压缩…
```

**缺的正是那句"不用慌"**。建议补一句等价承诺——见 19 号文档 P1 项。

---

## 6. 上下文工程检查清单（可直接用于 EvaWork）

| # | 做法 | Claude Code 证据 | 收益 |
|---|---|---|---|
| 1 | system 提示词恒定不变，动态信息全部追加为尾部消息 | `sys` 20 轮恒为 9,265 | 缓存前缀稳定 |
| 2 | 项目规则放在第 1 条 user 消息的 `<system-reminder>` 里，带 OVERRIDE 声明 | `main-msg-0.txt` | 规则位置固定 + 优先级明确 |
| 3 | 环境变化用 `# Environment update` 追加，并写出 `(was …)` | `main-flow.txt` [4] | 不回改历史 |
| 4 | 预算以极短伪标签每轮刷新 | `<total_tokens>15000000 tokens left</total_tokens>`（49 字符） | 模型可自规划，缓存几乎无损 |
| 5 | 异步事件注入自带"非用户输入"声明 | `[SYSTEM NOTIFICATION - NOT USER INPUT]` | 防止自我授权 |
| 6 | 子 agent 报告只走专用通道，通知块不重复正文 | `<result>…it is not repeated here.</result>` | 长文本不占两次上下文 |
| 7 | 主 agent 把长纪要压缩成要点再落上下文 | 4 条"要点摘录"assistant 消息 | 主上下文 20 轮只涨到 69 K |
| 8 | 压缩策略下沉为服务端参数 | `context_management.edits` | 策略可灰度、可 A/B |
| 9 | 缓存 TTL / 工具级缓存写进工具文档 | 5 分钟 TTL、WebFetch 15 分钟 | 模型参与成本决策 |
| 10 | 明确承诺"被压缩也不用提前收尾" | `# Context management` 末句 | 消除上下文焦虑 |
