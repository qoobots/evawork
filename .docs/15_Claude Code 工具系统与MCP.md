# 15 · Claude Code 工具系统与 MCP

> 素材：`scripts/cc-out/tools.json`（28 个工具的完整 schema，从 `clientRequest.tools` 去重）、`tools.md`（可读版）、`tools-brief.md`（速查版）
> 调用频次统计来自 157 次请求的 `response.toolCalls`

---

## 1. 工具总表（28 个，按职能分组）

`*` 表示必填参数。

### 1.1 文件读写与编辑（4）

| 工具 | 参数 | 要点 |
|---|---|---|
| `Read` | `file_path*`, `offset`, `limit`, `pages`, `allow_large` | 默认 2000 行；`cat -n` 格式带行号；支持图片/PDF（最多 20 页）/notebook；**"刚编辑过不要再读一遍验证"** |
| `Write` | `file_path*`, `content*` | 用于新建或整体替换；**覆盖一个未 Read 过的文件会失败**；局部改动请用 `Edit` |
| `Edit` | `file_path*`, `old_string*`, `new_string*`, `replace_all` | 精确字符串替换；必须先 Read；`old_string` 必须唯一；要去掉 Read 输出的行号前缀再匹配 |
| `NotebookEdit` | `notebook_path*`, `cell_id`, `new_source*`, `cell_type`, `edit_mode` | 替换/插入/删除 `.ipynb` 单元格 |

### 1.2 检索（2）

| 工具 | 参数 | 要点 |
|---|---|---|
| `Glob` | `pattern*`, `path` | 按修改时间排序返回；`path` 不填就是 cwd（**明确写了"不要填 undefined/null，直接省略"**） |
| `Grep` | `pattern*`, `path`, `glob`, `output_mode`, `-B/-A/-C/context`, `-n`, `-i`, `-o`, `type`, `head_limit`, `offset`, `multiline` | 基于 ripgrep；默认 `files_with_matches`；`head_limit` 默认 250；`offset` 支持分页 |

### 1.3 执行（1）

| 工具 | 参数 | 要点 |
|---|---|---|
| `Bash` | `command*`, `timeout`, `description`, `run_in_background`, `dangerouslyDisableSandbox` | 跑 Git Bash（POSIX sh，非 cmd/PowerShell）；`timeout` 默认 120 s、前台最长 600 s；`description` 要求主动语态、不许出现 "complex"/"risk"；后台命令跨轮次存活并在结束时**重新唤醒模型** |

### 1.4 计划模式（2）

| 工具 | 参数 | 要点 |
|---|---|---|
| `EnterPlanMode` | — | 进入计划模式，先探索再出方案；**需用户批准** |
| `ExitPlanMode` | `allowedPrompts`（已废弃） | 计划已写入计划文件后请求批准；**不接受计划内容参数**（从文件读）；明确禁止用 `AskUserQuestion` 问"计划行不行" |

### 1.5 工作树隔离（2）

| 工具 | 参数 | 要点 |
|---|---|---|
| `EnterWorktree` | `name`, `path` | **只在用户明确说 "worktree" 时用**；分支基线由 `worktree.baseRef` 决定（`fresh` 从 origin 默认分支 / `head` 从当前 HEAD） |
| `ExitWorktree` | `action*`(keep/remove), `discard_changes` | 只作用于本会话创建的 worktree；`remove` 时有未提交改动会**拒绝并列出**，需 `discard_changes:true` |

### 1.6 多智能体协作（5）

| 工具 | 参数 | 要点 |
|---|---|---|
| `Agent` | `description*`, `prompt*`, `subagent_type`, `model`, `effort`, `run_in_background`, `isolation` | 见 16 号文档 |
| `SendMessage` | `to*`, `summary`, `message*`, `notify_when_idle` | 按名字/ID 给 agent 发消息，`"main"` 指主会话 |
| `ListAgents` | `channel`, `q` | 列出可发消息的 agent（本进程子 agent、团队队友、本机/云端其它会话、Remote Control 会话） |
| `TaskStop` | `task_id`, `shell_id`(废弃) | 停后台任务 / 团队队友 / 具名后台 agent |
| `SubagentHandback` | `message*` | 子 agent 交付最终报告，**调用即结束运行**；只有它能被父 agent 收到 |

### 1.7 人机交互（1）

| 工具 | 参数 | 要点 |
|---|---|---|
| `AskUserQuestion` | `questions*`(1–4 条), `answers`, `annotations`, `metadata` | 只在"决定权确实属于用户"时用；用户总可选 "Other"；有推荐项放第一个并加 "(Recommended)"；支持 `preview` 字段做 ASCII 稿并排对比 |

### 1.8 技能与工作流（3）

| 工具 | 参数 | 要点 |
|---|---|---|
| `Skill` | `skill*`, `args` | 见 16 号文档 |
| `Workflow` | `script`, `name`, `description`, `title`, `args`, `scriptPath`, `resumeFromRunId` | 脚本化编排多子 agent；**必须用户显式 opt-in**（关键词 `ultracode` / 用户原话要求），否则一律不用 |
| `ReportFindings` | `level`, `findings*` | 把评审结果结构化上报给宿主 UI；只调一次，按严重度排序；不要同时用文本再打一遍 |

### 1.9 网络（2）

| 工具 | 参数 | 要点 |
|---|---|---|
| `WebFetch` | `url*`, `prompt*`, `offset` | 页面转 markdown 后用小模型回答；**认证/私有 URL 会失败**；localhost 会失败；HTTP 自动升 HTTPS；跨主机重定向交回模型；**按 URL 缓存 15 分钟** |
| `WebSearch` | `query*`, `allowed_domains`, `blocked_domains` | 返回标题+URL 块；结尾必须给 "Sources:" 列表 |

### 1.10 调度（4）

| 工具 | 参数 | 要点 |
|---|---|---|
| `CronCreate` | `cron*`, `prompt*`, `recurring`, `durable` | 5 段 cron、本地时区；`durable:true` 落盘 `.claude/scheduled_tasks.json`；**递归任务 7 天自动过期**；文档里专门教"避开 :00/:30"（避免全球同一时刻打爆 API） |
| `CronDelete` | `id*` | |
| `CronList` | — | |
| `ScheduleWakeup` | `delaySeconds`, `reason`, `prompt`, `stop`, `noop` | `/loop` 自步进行模式；**文档里明确写了 prompt cache TTL 是 5 分钟**，并给出"要么 ≤270 s 保缓存，要么 ≥1200 s 一次miss买长等待，绝不要选 300 s" |

### 1.11 外部集成（2）

| 工具 | 参数 | 要点 |
|---|---|---|
| `DesignSync` | `method*`, `projectId`, `path`, `writes`, `deletes`, `planId`, `files`, `paths`, `name`, `assets`, `localDir`, `counts` | claude.ai/design 设计系统同步；**强顺序约束**：list/read → `finalize_plan` → write/delete，没有 planId 一律拒绝 |
| `mcp__claude-vscode__getDiagnostics` | `uri` | 取 VS Code Problems 面板的诊断（含未保存改动） |

---

## 2. 最小权限：主智能体 vs 子智能体

这是整套工具设计里最容易复用的部分——**同一套工具注册表，按角色裁剪**。

| | 主智能体（27） | 子智能体（13） |
|---|---|---|
| 文件 | Read / Write / Edit / NotebookEdit | **Read**（无 Write/Edit/NotebookEdit） |
| 检索 | Glob / Grep | Glob / Grep |
| 执行 | Bash | **Bash**（提示词里额外限制为只读命令） |
| 计划 | EnterPlanMode / ExitPlanMode | — |
| 工作树 | EnterWorktree / ExitWorktree | EnterWorktree / ExitWorktree |
| 多智能体 | Agent / SendMessage / ListAgents / TaskStop | SendMessage / TaskStop |
| 交付 | — | **SubagentHandback** |
| 交互 | AskUserQuestion | — |
| 技能 | Skill / Workflow / ReportFindings | Skill |
| 网络 | WebFetch / WebSearch | WebFetch / WebSearch |
| 调度 | CronCreate / CronDelete / CronList / ScheduleWakeup | — |
| 外部 | DesignSync / mcp__claude-vscode__getDiagnostics | mcp__claude-vscode__getDiagnostics |

**两层裁剪**：① 工具集裁剪（子 agent 根本拿不到 `Write`/`Edit`/`Agent`）；② 提示词裁剪（子 agent 拿到 `Bash`，但提示词把它的命令白/黑名单钉死）。双保险，且第二层不需要改代码。

> 注意子 agent **保留了** `EnterWorktree/ExitWorktree/SendMessage/TaskStop/Skill/WebFetch/WebSearch`。说明裁剪不是"越少越好"，而是"去掉所有会改变用户状态的能力，保留所有只读 + 自我管理能力"。

---

## 3. 工具描述（description）是怎么写的

Claude Code 的工具 `description` 平均几百到上千字，是**提示词的一部分**，而不只是 API 元数据。固定套路：

### 3.1 结构模板

```
一句话职责。
（可选）## When to Use / When NOT to Use
（可选）## How This Tool Works / What Happens / Behavior / Examples
用法要点清单（bullets）
Usage notes
参数级说明（写在 input_schema.properties[x].description 里）
```

### 3.2 六种反复出现的写法

1. **正反例对比**（`EnterPlanMode`）
   ```
   ### GOOD - Use EnterPlanMode:
   User: "Add user authentication to the app" ...
   ### BAD - Don't use EnterPlanMode:
   User: "Fix the typo in the README" ...
   ```
2. **明确越界条件**（`ExitPlanMode`）
   > "For research tasks where you're gathering information... do NOT use this tool."
3. **把运行时的坑写进 description**（`Bash`）
   > "Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist."
4. **替模型省一次调用**（`Read`）
   > "Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed."
5. **把成本意识写进去**（`Workflow`）
   > "Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred."
6. **参数级反模式警告**（`Bash.description`）
   > "Never use words like 'complex' or 'risk' in the description."

### 3.3 三个值得照抄的原文

**Bash（节选）**
```
Executes a bash command and returns its output.
This tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell. Use Unix shell syntax:
`/dev/null` not `NUL`, forward slashes, `$VAR` not `%VAR%` or `$env:VAR`.
- Working directory persists between calls, but prefer absolute paths — `cd` in a
  compound command can trigger a permission prompt. Shell state (env vars, functions)
  does not persist; the shell is initialized from the user's profile.
- IMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`,
  `awk`, or `echo` commands, unless explicitly instructed or after you have verified
  that a dedicated tool cannot accomplish your task.
- Command output is displayed to you, not reliably to the user.
- `timeout` is in milliseconds: default 120000, max 600000 for a foreground command.
- `run_in_background` runs the command detached: it keeps running across turns and
  re-invokes you when it exits. No `&` needed.
# Git
- Interactive flags (`-i`) are not supported in this environment.
- Use the `gh` CLI for GitHub operations (PRs, issues, API).
- Commit or push only when the user asks. If on the default branch, branch first.
```

**Read（节选）**
```
- Reads up to 2000 lines by default.
- When you already know which part of the file you need, only read that part.
- Results are returned using cat -n format, with line numbers starting at 1.
- Reads images (PNG, JPG, …) and presents them visually. Reads PDFs via the `pages`
  parameter. Reads Jupyter notebooks as cells with outputs.
- Reading a directory, a missing file, or an empty file returns an error or system
  reminder rather than content.
- Do NOT re-read a file you just edited to verify.
```

**Agent（节选）**
```
- The agent's final report is not shown to the user — relay what matters.
- Use SendMessage with the agent's ID or name to continue a previously spawned agent
  with its context intact; a new Agent call starts fresh.
- Subagents run in the background by default; you'll be notified when one completes.
  Pass run_in_background: false only when your very next action depends on the result
  and nothing else could usefully happen while it runs.
- Never fabricate or predict a pending agent's results — the notification is never
  something you write yourself; if the user asks before it arrives, say it's still running.
```

最后这条（**不许编造未到达的 agent 结果**）是对幻觉的定点防御，非常值得照抄。

---

## 4. MCP 集成

### 4.1 命名规范

本次 trace 里唯一出现的 MCP 工具：`mcp__claude-vscode__getDiagnostics`。

命名格式：`mcp__<server>__<tool>`，双下划线分隔 server 与 tool。这个前缀同时出现在**主智能体和子智能体的工具集里**，说明 MCP 工具与内置工具在注册表中地位完全相同——模型不需要区分"这是内建还是 MCP"。

从安全分类器的定义里可以看到其它 MCP 前缀的写法，进一步印证规范：

```
`mcp__claude-in-chrome__*`、`mcp__Claude_in_Chrome__*`、`mcp__Claude_Preview__*`、
`mcp__Claude_Browser__*`      —— 同一个浏览器能力的不同宿主拼写
`mcp__remote-devices__claude-in-chrome__*`  —— 远程会话经设备桥接的二级命名
```

### 4.2 MCP 工具进入审批体系的证据

分类器 prompt 的 `Chrome-MCP` 定义段说明：

> "drive the user's real local browser with their live authenticated sessions — **not a sandbox**. You see only the tool name and input parameters; page content, screenshots, and tool results never reach you."

即：**MCP 工具被视为"真实用户环境"，默认不在沙箱内**，因此安全分类器对它们有专门规则（Browser Navigate/Input/JS/File Upload/Shortcut Exfil 共 5 条）。这提示 MCP 集成的关键不是"能不能调通"，而是"它是不是进入了同一套审批与审计通道"。

EvaWork 侧对应的落点见 19 号文档：`apps/agent-ts/src/mcp.ts` + `apps/mcp-bundle`。

---

## 5. 实际调用频次（157 次请求的响应侧统计）

| 工具 | 次数 | 说明 |
|---|---:|---|
| `Bash` | 91 | 主 agent 与子 agent 都在大量使用；子 agent 侧被提示词限制为只读命令 |
| `Read` | 70 | |
| `Grep` | 44 | |
| `Glob` | 9 | |
| `Agent` | 5 | 4 个研究方向 + 1 次失败重发 |
| `SubagentHandback` | 4 | 每个子 agent 交付一次 |
| `Write` | 1 | 写论文 |

**并行度**：子 agent 的响应里经常出现 `Bash+Grep`、`Read+Read`、`Grep+Grep` 两个工具同时调用（trace 里可见 `assistant > tool > tool > user` 的角色序列）。主 agent 第 3 轮一次响应里发出 2 个 `Agent` 调用。这和提示词里"Independent tool calls can run in parallel in one response"是一致的。

---

## 6. 可直接复用的工具设计清单

1. **写文件类工具要有前置约束**：`Write` 覆盖未读文件会失败、`Edit` 必须先 Read、`old_string` 必须唯一。把"安全"做成**调用约束**而不是提示词劝说。
2. **检索工具要有分页与截断默认值**：`Grep.head_limit` 默认 250、`Read` 默认 2000 行、`WebFetch` 有 `offset`。所有"可能返回巨量内容"的工具都必须有默认上限。
3. **每个工具都要写清"什么时候不要用"**：`ExitPlanMode`、`EnterWorktree`、`Workflow` 都有明确的禁用场景。
4. **后台机制要配套通知语义**：`run_in_background` 的 Bash 在退出时**重新唤醒模型**；子 agent 完成发 `task-notification`。后台任务必须有一条确定的"回来"的路径，否则模型只能傻等或瞎猜。
5. **成本/缓存意识写进工具文档**：`ScheduleWakeup` 直接告诉模型缓存 TTL 是 5 分钟，并给出选间隔的规则。这是把运行时经济模型暴露给模型的做法。
6. **显式禁止幻觉**：`Agent` 里"never fabricate or predict a pending agent's results"。对任何异步能力都要有这一句。
7. **MCP 用统一前缀并入同一注册表**，不要给 MCP 工具单独的调用路径——模型无法在两条路径间做出稳定选择。
