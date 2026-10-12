/**
 * 任务 API（T-021 前端侧）：侧栏历史、事件回放、回滚点、撤销。
 *
 * 后端废弃后，这里分成两类：
 *
 *   - **有真通道的**（侧栏列表/改名/删除、事件回放、回滚点、撤销）：
 *     全部走 TS 会话——要么主进程直读落盘会话目录，要么走 `api/tsAgent.ts` 的桥。
 *   - **只在后端存在的**（createTask / appendTaskMessage / cancelTask /
 *     fetchTask / streamTask / 智能跟进）：后端一撤就没有承载方了，TS 任务走的是
 *     `tsAgentPrompt` + 流式回调那条路，不走这里。这些保留签名但**如实报错**，
 *     而不是发一个注定失败的请求再显示"未连接后端"——那句没告诉用户该怎么办。
 */
import {
  replayTsAgent,
  tsSessionDelete,
  tsSessionRename,
  tsSessions,
  type TsSessionSummary,
} from './tsAgent';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled'; // T-073：被中断的步骤（内容保留，可重跑）

export interface Step {
  id: string;
  title: string;
  status: StepStatus;
  action: string;
  detail: string;
}

export interface Artifact {
  id: string;
  name: string;
  kind: string;
  path: string;
  content: string;
}

export interface Task {
  id: string;
  title: string;
  mode: string;
  model: string;
  state: string;
  steps: Step[];
  artifacts: Artifact[];
  error: string;
  /** 历史回显用：messages[0] 即用户原始输入（后端创建任务时写入） */
  messages?: { role: string; content: string }[];
}

/** T-070：模型主动发起的工具调用（工具由模型挑，不是前端/后端猜）。 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** T-070：工具执行结果；失败/被沙箱拦截也照实返回（error 有值）。 */
export interface ToolResult {
  call_id: string;
  name: string;
  ok: boolean;
  output: string;
  error: string;
  /** T-074：耗时（毫秒）——并发执行时多个工具的耗时会重叠，一眼能看出来 */
  elapsed_ms?: number;
  /** T-074：执行模式 parallel（并发）/ exclusive（独占串行） */
  mode?: string;
  /** T-089：写类工具给出的「改动前/后」原文（只进前端事件，不进模型消息） */
  diff?: ToolDiff;
  /** T-090：子代理的执行轨迹（同样只给人看：模型手里已经有摘要了） */
  subagent?: SubagentTrace;
}

/** T-090：子代理跑了什么（轮次 + 每次工具调用的结果摘要）。 */
export interface SubagentTrace {
  rounds: number;
  elapsed_ms?: number;
  calls: { tool: string; ok: boolean; elapsed_ms?: number; head: string }[];
}

/** T-089：改动审阅用。before 为空串表示新建文件。 */
export interface ToolDiff {
  path: string;
  before: string;
  after: string;
  truncated: boolean;
  new_file: boolean;
}

/**
 * TS-065：上下文用量（**token 是估算的**：中文 1 字 ≈ 1 token，西文 4 字符 ≈ 1 token）。
 *
 * 与 agent-ts 的 `ContextUsage` 一一对应；渲染层不该 import 子进程源码，所以在这里复述一份形状。
 */
export interface ContextUsagePart {
  id: string;
  label: string;
  tokens: number;
}
export interface ContextUsage {
  windowTokens: number;
  /** 压缩阈值：到这儿就开始丢早期轮次 */
  thresholdTokens: number;
  usedTokens: number;
  /** 已用占窗口的百分比（0–100，一位小数） */
  percent: number;
  parts: ContextUsagePart[];
}

export type TaskEvent =
  | { type: 'status'; state: string }
  | { type: 'plan'; steps: Step[] }
  // T-076：本次任务加载的技能（正文注入 + 工具收窄，让用户看得见）
  | { type: 'skill'; name: string; description: string; tools: string[]; declared: string[] }
  | { type: 'step'; step: Step }
  | { type: 'token'; content: string; step: string | null }
  // T-105：边界帧——此前流出的文本是过程叙述（"让我查看…"），不是正文。
  // 后端在"工具摘掉的收尾轮"之前发它，否则那句预告会粘在答案开头。
  | { type: 'narration'; step: string | null }
  // T-109：引擎侧说明（如"某步失败，跳过它继续执行剩余步骤"）——只影响过程，不影响任务结论
  | { type: 'notice'; message: string }
  | { type: 'retry'; step: string | null; attempt: number; message: string } // T-071：瞬时失败重试
  // T-091：模型降级——首选通道/模型不可用，换一条路由继续（不是从零开始）
  | {
      type: 'degrade';
      step: string | null;
      from: { channel: string; model: string; label: string };
      to: { channel: string; model: string; label: string };
      message: string;
    }
  | { type: 'tool_call'; step: string | null; call: ToolCall }
  | { type: 'tool_result'; step: string | null; result: ToolResult }
  | { type: 'artifact'; artifact: Artifact }
  // T-087：一步失败后重规划——新步骤接在后面，失败的那一步留在列表里
  | { type: 'replan'; attempt: number; steps: Step[]; reason: string; failed: string }
  | { type: 'done'; task: Task }
  // T-073：用户中断——已产出的正文与产物都留在任务上
  | { type: 'cancelled'; task: Task; reason: string }
  // 跑到时间/预算类边界（deadline / timeout / stalled）：任务只是被截停，已做的产出都还在上下文里——
  // 给"继续"而不是"重试"，让用户自己决定要不要接着跑（区别于 guard：guard 是真卡死，仍走 error/重试）。
  | { type: 'limit'; message: string; stop: string }
  // TS-065：上下文用量（每个 step 更新一次）。**派生值**：不进任务级列表、不落盘，
  // 只喂给输入框下方那条监控——它回答的是"还能塞多少、被什么吃掉的"。
  | { type: 'usage'; usage: ContextUsage }
  | { type: 'error'; message: string }
  // T-138：终答续跑时上一趟只吐了半截——先发这帧让前端清空那半截再重问
  | { type: 'answer_restart'; message: string };

/** T-072：落盘后的事件带 rev —— 断线重连拿 `since=rev` 就能补发缺失的帧。 */
export type StreamEvent = TaskEvent & { rev?: number };

/**
 * S-24：智能跟进推荐（任务跑完后的「下一步」）。
 *
 * 契约要点：
 * - `refresh=1`（或 POST）才调模型重新生成；不带参数只读已存的建议（不花模型调用）；
 * - `ok=false` 时 `reason` 是成句的原因（开关关了 / 离线演示 / 未登录 / 模型没给可用行），
 *   界面照实显示，不许拿"暂无建议"糊过去。
 */
export interface FollowupState {
  enabled: boolean;
  items: string[];
  ok?: boolean;
  reason?: string;
  ts?: number;
}

/* 智能跟进要后端自己调模型生成建议，TS 通道没有对应实现，本地也没有推理链路。
   如实返回"不可用"，界面据此不显示这块——而不是挂一个永远加载失败的区块。 */
const FOLLOWUP_UNAVAILABLE: FollowupState = {
  enabled: false,
  items: [],
  ok: false,
  reason: '智能跟进需要后端生成，当前不可用',
};

export function fetchFollowup(_id: string, _refresh = false): Promise<FollowupState> {
  return Promise.resolve(FOLLOWUP_UNAVAILABLE);
}

export function refreshFollowup(_id: string): Promise<FollowupState> {
  return Promise.resolve(FOLLOWUP_UNAVAILABLE);
}

/** 界面模型名 → 后端模型标识（Auto 系交给后端默认）。 */
export function modelCode(name: string): string {
  return /auto/i.test(name) ? 'auto' : name;
}

/** 下面这些只在后端存在，后端撤了就没有承载方；TS 任务走 tsAgentPrompt + 流式回调。 */
function backendOnly(what: string): never {
  throw new Error(`${what}：后端任务通道已移除，请用 TS 智能体通道`);
}

export function createTask(_input: {
  title: string;
  mode: string;
  model: string;
  skill?: string; // T-076：`/name` 唤起的技能
  /** T-101：同一会话的历轮对话（user/assistant 成对）——随任务落进 task.messages，模型才看得见上下文 */
  messages?: { role: string; content: string }[];
}): Promise<Task> {
  return backendOnly('创建任务');
}

/** T-102：同一任务上再追加一轮（追问）——TS 侧用 tsAgentPrompt 带 sessionId 续跑。 */
export function appendTaskMessage(_id: string, _content: string, _skill?: string): Promise<Task> {
  return backendOnly('追加消息');
}

/** T-073：请求取消任务——TS 侧用 cancelTsAgent。 */
export function cancelTask(_id: string): Promise<{ cancelled: boolean; state: string; mode: string }> {
  return backendOnly('取消任务');
}

/** 拉任务详情：历史回显走会话列表 + replayTsAgent，没有单独的"任务详情"存储。 */
export function fetchTask(_id: string): Promise<Task> {
  return backendOnly('读取任务详情');
}

/** T-115：侧栏列表用的任务摘要（`GET /api/tasks?summary=1`）。 */
export interface TaskSummary {
  id: string;
  title: string;
  mode?: string;
  state?: string
  error?: string;
  /** 任务创建时的工作区；空 = 老任务 → 界面归入「默认」组 */
  work_dir?: string
  created_at?: number
  updated_at?: number
  /** 父任务 id（根任务为 null）。24 号方案：把父子关系从文件名提升为结构化字段 */
  parent_id?: string | null
  /** 层级种类：root / subtask / job */
  kind?: string
  /** 直接子任务（嵌套），仅根任务可能非空 */
  children?: TaskSummary[]
  /** 子任务数量（仅根任务非零，侧栏聚合展示用） */
  childCount?: number
}

/**
 * 侧栏任务列表。
 *
 * 真相源换过两次：**前端 localStorage 影子列表** → **后端库** → **本地会话目录**（现在）。
 * 影子列表的问题是别的窗口建的任务看不见；后端库的问题是后端一废弃就没有了。
 * 现在是主进程直接读落盘的 TS 会话目录——不依赖子进程在不在跑，也没登录也能翻旧账。
 *
 * 会话形状（{ id,title,goal,lastTs,… }）在这里映射成界面要的 TaskSummary，
 * 免得侧栏和它下面的每个组件都去认识两套字段。
 */
export async function fetchTaskList(): Promise<TaskSummary[]> {
  const res = await tsSessions();
  if (!res.ok) throw new Error(res.reason || '读取会话列表失败');
  // 递归把后端返回的树（根 + 嵌套 children）映射成 TaskSummary 树；
  // 后端默认只给根任务，子任务随父任务的 children 下来（24 号方案 G2）
  const mapOne = (s: TsSessionSummary): TaskSummary => ({
    id: s.id,
    title: s.title || s.goal || s.id,
    // 会话没有"排队/规划/执行中"这类状态机，只看最后一轮怎么结束的
    state: sessionStopToState(s.stop),
    created_at: s.firstTs || undefined,
    updated_at: s.lastTs || undefined,
    parent_id: s.parentId ?? null,
    kind: s.kind || 'root',
    childCount: s.childCount || (s.children ? s.children.length : 0),
    children: s.children && s.children.length ? s.children.map(mapOne) : undefined,
  });
  return (res.sessions || []).map(mapOne);
}

/** 最后一轮的结束原因 → 界面状态标签。认不出的按"已完成"处理并记录原文。 */
function sessionStopToState(stop: string): string {
  const s = String(stop || '').toLowerCase();
  if (!s) return 'running'; // 没有 turn/end = 还没跑完一轮
  if (s.includes('error') || s.includes('fail')) return 'failed';
  if (s.includes('cancel') || s.includes('abort')) return 'cancelled';
  if (s.includes('limit') || s.includes('maxstep')) return 'pending';
  return 'done';
}

/** 重命名任务：落到会话日志里（追加一条改名事件），刷新后仍在。 */
export async function renameTask(id: string, title: string): Promise<{ id: string; title: string }> {
  const r = await tsSessionRename(id, title);
  if (!r.ok) throw new Error(r.reason || '重命名失败');
  return { id: r.sessionId || id, title: r.title || title };
}

/** 删除单个任务。删不掉必须把原因带出来——静默失败会让人以为删了其实还在。 */
export async function deleteTask(id: string): Promise<{ deleted: string }> {
  const r = await tsSessionDelete(id);
  if (!r.ok) throw new Error(r.reason || '删除失败');
  return { deleted: r.sessionId || id };
}

/** 批量删除的结果。`skipped` = 没删成的那几条（要如实告诉用户）。 */
export interface DeleteTasksResult {
  deleted: string[];
  skipped: { id: string; title: string; state: string }[];
  missing: string[];
}

/** 会话本就不在（从未落盘 / 已被删）：删除等于已经达成，归入 missing 交调用方本地剔除。 */
function isGoneReason(reason: unknown): boolean {
  const s = String(reason || '');
  return s.includes('不合法') || s.includes('不存在') || /ENOENT|no such file/i.test(s);
}

export async function deleteTasks(ids: string[]): Promise<DeleteTasksResult> {
  const deleted: string[] = [];
  const skipped: { id: string; title: string; state: string }[] = [];
  const missing: string[] = [];
  // 逐个删而不是一口气管后端要：会话目录是本地文件，删一半失败也要知道哪几条留下了
  for (const id of ids) {
    const r = await tsSessionDelete(id).catch(() => ({ ok: false, reason: '删除失败' }));
    if (r.ok) deleted.push(id);
    else if (isGoneReason(r.reason)) missing.push(id);
    else skipped.push({ id, title: id, state: String(r.reason || '删除失败') });
  }
  return { deleted, skipped, missing };
}

/**
 * T-072：增量回放事件日志（重开窗口/断线后补齐）。
 * `since` 为已看到的最大 rev，返回其后的帧与最新 rev。
 */
export async function fetchTaskEvents(
  id: string,
  since = 0,
): Promise<{ items: StreamEvent[]; latest: number }> {
  const r = await replayTsAgent(id);
  if (!r.ok) throw new Error(r.reason || '回放失败');
  const all = (r.events || []) as StreamEvent[];
  // 会话日志没有 rev 序号：用下标当序号，`since` 就是"已经看到第几帧"
  const items = since > 0 ? all.slice(since) : all;
  return { items, latest: all.length };
}


/**
 * 消费 SSE 事件流；遇到 `[DONE]` 结束。
 * `since > 0` 时后端先补发缺失的帧再接实时流（断线重连用）。
 */
export async function* streamTask(
  id: string,
  _resume = false,
  since = 0,
): AsyncGenerator<StreamEvent> {
  /* 实时流走 onTsAgent 的推送（主进程把子进程事件转发到渲染层）。
     这里是"补历史"的场景：把落盘会话回放出来，调用方照旧 for-await 消费。
     不做假流式——拿回放冒充实时流会让界面以为任务还在跑。 */
  const { items } = await fetchTaskEvents(id, since);
  for (const ev of items) yield ev;
}

export const STATE_LABEL: Record<string, string> = {
  pending: '排队中',
  planning: '规划中',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export const STEP_LABEL: Record<StepStatus, string> = {
  pending: '待执行',
  running: '进行中',
  waiting: '等待中',
  done: '已完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已中断',
};
