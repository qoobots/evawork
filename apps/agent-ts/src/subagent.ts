// 子代理（TS-043）：把一件独立的小任务派出去，它有自己的上下文。
//
// 边界是：**独立上下文**——子代理只看到"任务是什么 + 结果"，看不到主任务的对话历史。
// 不隔离的话，主任务那一大坨上下文原样复制一份，派一次就翻倍，越派越贵。

import { runTurn } from "./loop.ts"
import type { StreamFn, TurnResult } from "./loop.ts"
import { SessionLog, nextSubId } from "./session.ts"
import { defineTool } from "./tools.ts"
import type {LlmConfig, SessionEvent, ToolContext, ToolResult, SubagentTrace } from "./types.ts"

export interface SubagentOptions {
  /** 交给它做的事（一句话任务，不要塞上下文） */
  goal: string
  cfg: LlmConfig
  workspace: string
  /** 父会话日志：子代理的结论会追加到这里，便于事后回看 */
  parentLog: SessionLog
  /** 工具子集白名单；不填 = 全部（但审批仍是 never） */
  tools?: string[]
  system?: string
  stream?: StreamFn
  onEvent?: (e: SessionEvent) => void
}

export interface SubagentResult extends TurnResult {
  /** 子代理那边被拒的高危动作（带原因）——拿回主任务去问人，不在这里弹窗 */
  denied: string[]
  sessionId: string
  goal: string
  /** 给界面那张"子代理轨迹"卡（TS-064：此前 TS 侧不带轨迹，卡片永远是空的） */
  trace: SubagentTrace
}

export async function runSubagent(o: SubagentOptions): Promise<SubagentResult> {
  const denied: string[] = []
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
    tools: o.tools || null,
  })

  /* 收集子代理自己干了什么（TS-064）：结论摘要给模型看，**轨迹给人看**。
     此前 TS 侧不带轨迹，界面上那张卡（T-090）对 TS 会话永远是空的——
     派了活却看不见，等于"派了就信了"。 */
  const calls: SubagentTrace["calls"] = []
  const t0 = Date.now()

  const res = await runTurn({
    prompt: o.goal,
    cfg: o.cfg,
    workspace: o.workspace,
    log,
    // 子代理生命周期短、几乎撞不到上下文压缩，别为它多付一次归档调用
    archiveDropped: false,
    tools: o.tools,
    stream: o.stream,
    system:
      o.system ??
      "你是一个子代理：只完成交给你的这一件任务，用简短结论汇报做了什么、结果是什么。\n" +
        "写文件、跑命令、联网这类动作会被直接拒绝——不要重试，把需要批准的事写进结论里，由主任务去处理。",
    onEvent: o.onEvent,
    onTool: (name, _args, r, deniedReason) => {
      // 只有被拒的才需要带回主任务：成功做了什么，结论里已经写了
      if (deniedReason) denied.push(deniedReason)
      calls.push({
        tool: name,
        ok: !deniedReason && (!r || r.ok !== false),
        head: String(deniedReason || (r ? r.output || r.error || "" : "")).replace(/\s+/g, " ").slice(0, 120),
      })
    },
  })

  o.parentLog.append({
    type: "subagent/result",
    session: log.id,
    goal: o.goal,
    steps: res.steps,
    stop: res.stopReason,
    denied,
    text: res.text,
  })

  return {
    ...res,
    denied,
    sessionId: log.id,
    goal: o.goal,
    trace: { rounds: res.steps, elapsed_ms: Date.now() - t0, calls },
  }
}

/** 给主任务看的摘要：结论 +（若有）需要批准的动作。 */
export function summarizeSubagent(r: SubagentResult): string {
  const head = `子代理（${r.sessionId}）${r.stopReason === "completed" ? "完成" : "未跑完（" + r.stopReason + "）"}，${r.steps} 步。\n结论：${r.text || "（无正文）"}`
  if (!r.denied.length) return head
  return `${head}\n需要批准的动作（子代理一律不自行执行）：\n${r.denied.map((d) => `- ${d}`).join("\n")}`
}

/**
 * 把委派注册成工具 `delegate`，让模型自己决定什么时候派人。
 *
 * 动作类别是 `llm`（**非高危**）：委派本身不碰外部世界，因为子代理是 fail-closed 的——
 * 真正有风险的动作在子代理里执行不了，会被带回主任务。若把 delegate 标成 command，
 * 反而要为主任务弹一次"可以派个人吗"的审批，而这次审批并不能挡住任何实际风险。
 */
export function registerDelegateTool(): void {
  defineTool({
    name: "delegate",
    description:
      "把一件独立的小任务派给子代理：它有自己的上下文、看不到主任务的对话历史，可限定工具子集；" +
      "子代理那边写文件/跑命令/联网一律不执行，会把需要批准的事带回结论里。",
    parameters: [
      { name: "goal", type: "string", required: true, desc: "交给子代理的一件任务（一句话，不要塞上下文）" },
      { name: "tools", type: "string", required: false, desc: "逗号分隔的工具白名单，不填=全部" },
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
      const list = String(args.tools || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const r = await runSubagent({
        goal,
        cfg,
        workspace: ctx.workspace,
        parentLog: log,
        tools: list.length ? list : undefined,
      })
      // subagent 轨迹：给界面那张卡（T-090）。**只给人看**，不进模型消息。
      return { ok: r.stopReason === "completed", output: summarizeSubagent(r), subagent: r.trace }
    },
  })
}
