# eva-agent-ts（`eva-desktop/apps/agent-ts`）

EVA 的 **TypeScript 智能体运行时**。原 Python 版 `apps/desktop-py/evawork`
曾是与之并存的第二套智能体（界面上二选一），**现已删除**：TS 是唯一内核。

> 目录叫 `agent-ts`，但**协议名与 `bin` 仍是 `eva-agent-ts`**：前者是它在仓库里的位置，
> 后者是它对外叫什么。改名字会同时打破 JSON-RPC 的 `protocolVersion` 协商与 CLI 入口，
> 所以只搬了目录，没改名字——看到两处不一致时不必去"统一"它们。

分工目标：TS 侧承担日常工作，Python 侧承担数据分析。

## 为什么是"独立两套"而不是"Python 调用 TS 插件"

TS 能力完全可以做成 MCP 服务让 Python 侧调用（现有 `plugins.py` 已支持），
但那只能复用能力、不能复用编排。两套并存的价值是各自独立演进与故障隔离，
代价是：**契约必须共用，状态必须分开**——

- 共用的：模型通道（同一个 eva-ai，同一份模型白名单）、工作区根、审批档位语义；
- 分开的：存储（TS 侧 `~/.evawork/ts-agent/`，**不碰 evawork.db**）、历史、进程。

Python 侧的主库是"单连接 + 一把 RLock"，它自己的注释就写着
`check_same_thread=False` 不保证并发安全、并实测咬过人。两套智能体不能共用那种存储。

## 设计来源

参考了 `deepseek-harness`（Cordis 插件化 harness），但**不依赖它的任何包**——
它是 `private`（未发 npm）、`0.2.1-alpha`、锁定自己的 Node 版本。只借三条设计：

1. **session 是 append-only 事件日志**（不是可变状态表）：事实只追加，可重放核对；
   多进程安全性远高于共享一张表。
2. **工具执行有统一前置钩子** `tools/pre-execute`：审批、沙箱、越界检查都挂这一处，
   不在每个工具里各写一遍。
3. **审批没有应答者就 deny（fail-closed）**，绝不一挂了之。挂起是最难排查的状态——
   它看起来既像"还没轮到"又像"卡住了"。这一条与 Python 版 T-086 是同一个结论。

## 零依赖

不装 `tsx` / `typescript` / `openai` SDK。**Node 22.18+ 原生剥离 TS 类型**即可直接运行
`.ts`，HTTP 用内置 `fetch`，SSE 手写解析。理由与 evawork 一致：本机可能无外网，
装不上包就等于跑不起来。

约束：strip-only 模式**不支持参数属性**（`constructor(readonly x)`）、`enum`、
`namespace`。老老实实在构造体里赋值。

## 跑起来

```bash
# 凭据由启动方注入（TS 侧不读 evawork 的 SQLite 登录态）
export EVA_AI_BASE_URL=http://localhost:8080/api/ai/v1
export EVA_AI_TOKEN=<EVA 登录令牌>

node src/cli.ts --prompt "用 list_dir 看一下工作区，然后一句话说明"
```

自检（不需要模型）：

```bash
node src/selftest.ts      # 198 项：事件日志 seq 连续性、沙箱越界、审批 fail-closed、受限令牌
node src/selftest-sdk.ts  # 22 项：JSON-RPC 握手、能力清单、错误码
node src/cli.ts --sandbox-status   # 受限令牌那层生效了吗（TS-056，不需要模型）
```

CLI 选项：`--model` `--workspace` `--policy ask|never` `--interactive`
`--session`（续跑）`--json` `--sessions`（历史）`--sandbox-status`。

## 目录

| 文件 | 职责 |
|---|---|
| `src/types.ts` | 公共类型（含审批档位、动作类别） |
| `src/session.ts` | 事件日志：append-only JSONL + 独占目录锁（含陈旧锁兜底） |
| `src/llm.ts` | OpenAI 兼容流式适配器；内部格式 → 线上格式的转换 |
| `src/sandbox.ts` | 工作区路径约束（软沙箱） |
| `src/sandbox-win.ts` | 受限令牌那层的加载器（可选）与状态查询 TS-056 |
| `src/approval.ts` | 审批闸门：`ask` / `never`，无人应答 → deny |
| `src/tools.ts` | 注册表 + `pre-execute` 管线 + 内置工具 |
| `src/loop.ts` | 主循环 turn/step：协作式取消，收口靠墙钟与"有没有进展" |
| `src/cli.ts` | 入口 |
| `src/selftest.ts` | 自检（不需要模型） |

## 可选的原生模块（Windows 受限令牌沙箱）

`native/win-sandbox`：给 `run_command` 的子进程上**真正的写限制**（只能写工作区与私有
temp）。它是全项目**唯一的原生模块**，且是**可选**的——默认关（`EVA_TS_WIN_SANDBOX=1` 开），
缺了就明说原因并退回路径层沙箱，绝不假装限制生效。

```bash
npm run build:native          # 需要 MSVC Build Tools + Python；编不出来不阻断打包
```

## 当前边界

- 受限令牌那层**只限写**，不限读与网络；且仍有程序起不来（实测 `git` / `ping` 报
  0xC0000142，工具层已把它翻成人话而不是甩一串负数）
- 原生模块是平台专属（只有 Windows）且要编译，装包环境不一定有
- 工具的历史与会话查询都在本地 JSONL，规模变大后摘要需要索引（现在读全文够用）
- 没有 HTTP 接口，只有 stdio 上的 JSON-RPC（界面经 `apps/desktop-node` 驱动）
