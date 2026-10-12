// 子代理（TS-043 / 文档 19 P0-3、P1-6）：把一件独立任务派出去，它有自己的上下文。
//
// 边界是：**独立上下文**——子代理只看到"任务是什么 + 交付"，看不到主任务的对话历史。
// 不隔离的话，主任务那一大坨上下文原样复制一份，派一次就翻倍，越派越贵。
//
// 交付走**显式通道**（handback 工具），而不是"最后一段 assistant 文本"：
// 文本会被模型随手写半句话就收尾，而 handback 强制它把"主任务需要的全部信息"
// 打包成一次调用——调用即结束，不存在"交付了又接着聊"的悬空状态。

import { runTurn } from "./loop.ts"
import type { StreamFn, TurnResult } from "./loop.ts"
import { SessionLog, nextSubId } from "./session.ts"
import { defineTool, MAX_DELEGATE_OUTPUT, truncate } from "./tools.ts"
import type { LlmConfig, SessionEvent, ToolContext, ToolResult, SubagentTrace } from "./types.ts"

export type SubagentRole = "general" | "explore"

/**
 * explore 角色的默认工具白名单（P1-6）。名字必须与注册表**完全一致**——
 * 白名单里的名字不存在，子代理就永远看不到这个工具（不是报错，是消失）。
 *
 * 刻意**不含** run_command / terminal：Claude Code 的 Explore 允许"只读 Bash"靠的是
 * 命令分类器兜底，我们审批已移除、分类器默认关，白名单是唯一防线——
 * 读文件、列目录、找名字、搜内容、抓网页，这五件事专用工具都够干，不需要 shell。
 * handback 在 runSubagent 里**无条件追加**（交付通道不能被白名单挡掉）。
 */
export const EXPLORE_TOOLS = ["read_file", "list_dir", "glob_files", "search_text", "web_fetch", "load_skill", "handback"]

/** 只读锁提示词（三重否定，对齐文档 19 P1-6 / 14 号文档 §3）。 */
const EXPLORE_SYSTEM =
  "你是一个**只读检索**子代理：唯一目标是把\"东西在哪、内容是什么\"查清楚，交回结论。\n" +
  "=== 严格只读模式 ===\n" +
  "- 你**没有**任何写工具：不能创建、修改、删除、移动、复制文件，也没有 shell——不存在\"顺手跑一条命令\"的通道。\n" +
  "- 一切\"先落个草稿/报告再说\"的想法都是错的：**不要写任何文件，包括 .md**——主任务读的是你的 handback 文本。\n" +
  "- 不要尝试绕过（拼路径、改后缀都不行）：你手里只有 read_file / list_dir / glob_files / search_text / web_fetch。\n" +
  "汇报纪律：每条事实都要带**具体文件路径**（相对工作区、正斜杠），关键原文用一小段代码块贴出来；" +
  "结论只写\"有什么/在哪/是什么\"，不要写建议、不要评价质量。"

export interface SubagentOptions {
  /** 交给它做的事（一句话任务，不要塞上下文） */
  goal: string
  cfg: LlmConfig
  workspace: string
  /** 父会话日志：子代理的结论会追加到这里，便于事后回看 */
  parentLog: SessionLog
  /**
   * 角色（P1-6）：`explore` = 只读检索模板（白名单与提示词都收紧），
   * `general`（默认）= 与主任务同权限。调用方显式给了 tools/system 时**以给的为准**，
   * 角色只填没给的空。
   */
  role?: SubagentRole
  /** 工具子集白名单；不填 = 全部（handback 总是自动在内） */
  tools?: string[]
  system?: string
  stream?: StreamFn
  onEvent?: (e: SessionEvent) => void
}

export interface SubagentResult extends TurnResult {
  /** 子代理这边被拒的动作（带原因）——带回主任务，不在这里弹窗 */
  denied: string[]
  sessionId: string
  goal: string
  /** 结论是不是经 handback 显式交付的（false = 没调 handback，退回首段正文，可能不完整） */
  handback: boolean
  /** 给界面那张"子代理轨迹"卡（TS-064：此前 TS 侧不带轨迹，卡片永远是空的） */
  trace: SubagentTrace
}

/**
 * `handback` 工具（P0-3）：子代理交付结论的**唯一正门**，调用即终止本轮。
 *
 * 只在 runTurn 的 step 边界生效（loop 检查 ctx.handback）：此刻本轮的 tool_call
 * 已全部配好 tool_result，协议不破。主任务误调被 `ctx.subtask` 闸挡住——
 * 更要紧的是 boot 的暴露名单永远剔除它，这里是纵深防御的第二层。
 */
export function registerHandbackTool(): void {
  defineTool({
    name: "handback",
    description:
      "把最终结论交给派你出来的主任务。**调用即结束本次子任务**：先做完其它事，再把主任务需要的全部信息放进这一次调用。" +
      "只有这里的文字会被主任务收到——你最后写的普通文本不会送达，落盘的报告文件主任务也不会去读。",
    parameters: [{ name: "message", type: "string", required: true, desc: "给主任务的完整结论（自包含：路径、数字、未竟事项都写全）" }],
    action: "llm",
    execute(args, ctx): ToolResult {
      if (!ctx.subtask) {
        return { ok: false, error: "handback 只属于子代理的交付通道：主任务请直接结束回答（这不是错误，是误用）" }
      }
      const msg = String(args.message || "")
      if (!msg.trim()) return { ok: false, error: "message 为空——交付要有内容；没内容就别调" }
      ctx.handback = msg
      return { ok: true, output: "[handback] 已交付，本次子任务到此结束" }
    },
  })
}

/**
 * 子代理可见的工具名单：
 *   - 给了白名单 → 原样 + 无条件补上 handback（交付通道不能被限掉）；
 *   - 没给 → 注册表全量，但**必须剔掉主任务专属之外不该乱入的**——目前只有一条
 *     反向纪律：handback 要**在**（子代理没有主任务的概念）。
 * 注意返回值会同时用于"schema 暴露"与"越界调用拒绝"两处，两处同源，不会漂。
 */
export function subagentTools(whitelist: string[] | undefined, role: SubagentRole): string[] | undefined {
  if (role === "explore") {
    // explore 收紧到只读模板；显式给了 tools 则尊重调用方
    const base = whitelist ?? EXPLORE_TOOLS
    return [...new Set([...base, "handback"])]
  }
  if (!whitelist) return undefined // 全部：visible=allTools()，handback 本来就在注册表里
  return [...new Set([...whitelist, "handback"])]
}

export async function runSubagent(o: SubagentOptions): Promise<SubagentResult> {
  const denied: string[] = []
  const role: SubagentRole = o.role === "explore" ? "explore" : "general"
  // 子会话 id 由 nextSubId 决定（取同父最大序号 +1），避免子进程重启归零重名
  const id = nextSubId(o.parentLog.id)
  const log = new SessionLog(id, {
    parentId: o.parentLog.id,
    kind: "subtask",
    goal: o.goal,
    workDir: o.workspace,
  })

  o.parentLog.append({
    type: "subagent/start",
    session: log.id,
    goal: o.goal,
    parentId: o.parentLog.id,
    role,
    tools: o.tools || null,
  })

  /* 收集子代理自己干了什么（TS-064）：结论摘要给模型看，**轨迹给人看**。
     此前 TS 侧不带轨迹，界面上那张卡（T-090）对 TS 会话永远是空的——
     派了活却看不见，等于"派了就信了"。handback 也会进 calls：多一条
     "交付记录"反而让轨迹更像事实，模型侧读不到它（只读 summarize 的文本），
     不会污染主上下文。 */
  const calls: SubagentTrace["calls"] = []
  const t0 = Date.now()

  /* 系统提示词 = 调用方覆盖（或角色模板），**再追加 handback 用法**。
     追加不能做成"只有默认文案才加"——调用方自带 system 时更容易不知道
     交付通道长什么样，工具在而用法没说，等于没给。
     判据用"文案里提没提 handback"，提过就不重复。 */
  const baseSystem =
    o.system ??
    (role === "explore"
      ? EXPLORE_SYSTEM
      : "你是一个子代理：只完成交给你的这一件任务，交付走 handback 工具。\n" +
        "你的工具权限与主任务相同（默认可写文件、跑命令、联网）——派你出来就是为了把过程隔离在独立上下文里，" +
        "动作照做，做不成的（被策略拦的、缺权限的）如实写进交付。")
  const system = /\bhandback\b/.test(baseSystem)
    ? baseSystem
    : `${baseSystem}\n- 结论通过 handback 工具交付，调用即结束本轮；结尾写的普通文本不会送达。\n- 不要创建报告/纪要 .md 文件——主任务读的是你的 handback 文本，不是你落的文件。`

  const tools = subagentTools(o.tools, role)

  const res = await runTurn({
    prompt: o.goal,
    cfg: o.cfg,
    workspace: o.workspace,
    log,
    // 子代理生命周期短、几乎撞不到上下文压缩，别为它多付一次归档调用
    archiveDropped: false,
    tools,
    stream: o.stream,
    system,
    // 交付闸：handback 工具只认这个（见 tools/handback execute 的 ctx.subtask）
    subtask: true,
    onEvent: o.onEvent,
    onTool: (name, _args, r, deniedReason) => {
      // 只有被拒的才需要带回主任务：成功做了什么，交付里已经写了
      if (deniedReason) denied.push(deniedReason)
      calls.push({
        tool: name,
        ok: !deniedReason && (!r || r.ok !== false),
        head: String(deniedReason || (r ? r.output || r.error || "" : "")).replace(/\s+/g, " ").slice(0, 120),
      })
    },
  })

  const isHandback = res.stopReason === "handback"

  o.parentLog.append({
    type: "subagent/result",
    session: log.id,
    goal: o.goal,
    steps: res.steps,
    stop: res.stopReason,
    // 交付通道如实落盘：界面/回放要能区分"正经交了"与"没调 handback、捡了最后一段话"
    handback: isHandback,
    denied,
    text: res.text,
  })

  return {
    ...res,
    denied,
    sessionId: log.id,
    goal: o.goal,
    handback: isHandback,
    trace: { rounds: res.steps, elapsed_ms: Date.now() - t0, calls },
  }
}

/** 给主任务看的摘要：结论来源 +（若有）被拒动作。 */
export function summarizeSubagent(r: SubagentResult): string {
  const done = r.stopReason === "completed" || r.stopReason === "handback"
  const head = `子代理（${r.sessionId}）${done ? "完成" : "未跑完（" + r.stopReason + "）"}，${r.steps} 步。`
  if (r.handback) return `${head}结论（handback 交付）：${r.text || "（空交付——不该出现，按失败处理）"}`
  const body = `${head}结论：${r.text || "（无正文）"}\n（子代理未调用 handback，以上是最后一段正文，可能不完整——重要结论请自行复核）`
  if (!r.denied.length) return body
  return `${body}\n被拒的动作（带原因，由主任务决定怎么办）：\n${r.denied.map((d) => `- ${d}`).join("\n")}`
}

/**
 * 把委派注册成工具 `delegate`，让模型自己决定什么时候派人。
 *
 * 动作类别是 `llm`（非高危）：委派本身不碰外部世界，被限制的动作会以"被拒清单"
 * 的形式随交付带回主任务。**并行友好**：多个独立任务请同一轮发多个 delegate 调用
 * （loop 里 action llm 归入并行安全集）。
 */
export function registerDelegateTool(): void {
  defineTool({
    name: "delegate",
    description:
      "把一件**独立**的任务派给子代理：它有完全独立的上下文（看不到主任务历史），" +
      "做完经 handback 交回一段自包含结论。适合：大范围检索、读一堆文件出摘要、验证某个猜测——" +
      "把这些过程的上下文开销隔离出去。不适合：需要主任务对话背景的事、要改同一批文件的协作（互相看不见，会写重）。" +
      "子代理权限默认与主任务相同，传 role=explore 收紧为只读检索。" +
      "**结果只能来自它的回报**：派出去之后不要编造或预测它会说什么。" +
      "多个互不依赖的子任务放在同一轮发多个调用，会并行执行。",
    parameters: [
      { name: "goal", type: "string", required: true, desc: "交给子代理的一件任务（一句话说清目标与交付物；它看不到其它背景）" },
      { name: "tools", type: "string", required: false, desc: "逗号分隔的工具白名单，不填=全部（handback 自动包含）" },
      { name: "role", type: "string", required: false, desc: "explore=只读检索（默认工具集收紧+只读提示词）；不填=general" },
    ],
    action: "llm",
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const goal = String(args.goal || "").trim()
      if (!goal) return { ok: false, error: "goal 为空" }
      const cfg = ctx.cfg as LlmConfig | undefined
      const log = ctx.log as SessionLog | undefined
      // 缺什么就说什么：静默"委派失败"会让模型反复重试同一件事
      if (!cfg || !log) {
        return { ok: false, error: "当前上下文没有模型通道或事件日志，不能委派（子代理要自己调模型）" }
      }
      // 子代理里再派子代理：目前刻意**禁止**。不是做不到，是没必要——
      // 递归深度没人管，两个代理互相派工就变成无人收敛的图；要做异步编排（P1-7 后半）时再放。
      if (ctx.subtask) return { ok: false, error: "子代理不能再派子代理（goal 请拆成多个 delegate 由主任务自己发）" }
      const list = String(args.tools || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const role: SubagentRole = String(args.role || "").trim() === "explore" ? "explore" : "general"
      const r = await runSubagent({
        goal,
        cfg,
        workspace: ctx.workspace,
        parentLog: log,
        role,
        tools: list.length ? list : undefined,
      })
      // subagent 轨迹：给界面那张卡（T-090）。**只给人看**，不进模型消息。
      // 交付文本加保险上限（P0-2[15]）：话多的子代理不能把主上下文撑爆。
      // 截断必须**说出来**——静默截会让孩子说的"第 3 条建议"凭空蒸发。
      const full = summarizeSubagent(r)
      const summary = truncate(full, MAX_DELEGATE_OUTPUT)
      return {
        ok: r.stopReason === "completed" || r.stopReason === "handback",
        output:
          summary.length < full.length
            ? `${summary}\n…（交付超 ${MAX_DELEGATE_OUTPUT} 字符已截断；完整过程见子代理轨迹 ${r.sessionId}）`
            : summary,
        subagent: r.trace,
      }
    },
  })
}

/**
 * subagent 模块带来的工具（boot.ts 的 MODULE_TOOLS 用）。
 * `handback` 即使注册了也**永远不进主任务暴露名单**（boot 统一剔除）：
 * 它只在 runSubagent 的白名单里出现，主任务看不见才不会被误调。
 */
export const SUBAGENT_MODULE_TOOLS: string[] = ["delegate", "handback"]
