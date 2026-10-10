// TS 智能体的渲染层封装（TS-052）。
//
// preload 已经把桥暴露出来了（`window.evawork.tsAgent`），但渲染层一行封装都没有，
// 结果就是"能力存在但没人用"。这里补齐三件事：
//   1. 把 invoke 收敛成有类型的函数（不用在每个组件里写 `any`）
//   2. **没有 Electron 时明确不可用**（浏览器里直接开发 UI 的场景不能假装能调）
//   3. 智能体二选一：选择是**本机级**的，切换要立刻生效（主进程会顺手收/起子进程）

import type { TsAgentPayload, TsAgentStatus } from './backend';
import type { ContextUsage } from './tasks';

function bridge() {
  const w = window as unknown as {
    evawork?: {
      tsAgent?: {
        status: () => Promise<TsAgentStatus>;
        start: (opts?: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>;
        prompt: (args: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string; sessionId?: string }>;
        cancel: (args: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>;
        stop: () => Promise<{ ok: boolean }>;
        replay: (args: { sessionId: string }) => Promise<{ ok: boolean; reason?: string; events?: unknown[] }>;
        contextUsage: (args: { sessionId: string }) => Promise<{ ok: boolean; reason?: string; usage?: ContextUsage }>;
        sessions: () => Promise<TsSessionListResult>;
        sessionRename: (sessionId: string, title: string) => Promise<{ ok: boolean; reason?: string; sessionId?: string; title?: string }>;
        sessionDelete: (sessionId: string) => Promise<{ ok: boolean; reason?: string; sessionId?: string }>;
        sessionSearch: (term: string, sessionId?: string) => Promise<{ ok: boolean; hits?: TsSearchHit[] }>;
        /** 调试模式（trace）：重拉子进程以套用最新的 EVA_TS_TRACE 环境变量。 */
        restart: () => Promise<{ ok: boolean; reason?: string }>;
        /** 打开 trace 目录（系统文件管理器）。 */
        openTraceDir: () => Promise<{ ok: boolean; reason?: string; path?: string }>;
        on: (cb: (payload: TsAgentPayload) => void) => () => void;
      };
      agentChoice?: {
        get: () => Promise<{ agent: 'py' | 'ts'; running: boolean }>;
        set: (agent: string) => Promise<{ agent: 'py' | 'ts'; running: boolean }>;
      };
    };
  };
  return w.evawork;
}

/** 桥在不在：浏览器直连开发（无 Electron）时为真 false，UI 据此**明示**而不是报错。 */
export function tsAgentAvailable(): boolean {
  return Boolean(bridge()?.tsAgent);
}

/** 重拉 TS 智能体子进程（调试模式改了 trace 开关后，让它立刻套用 EVA_TS_TRACE）。 */
export async function tsAgentRestart(): Promise<{ ok: boolean; reason?: string }> {
  const b = bridge();
  if (!b?.tsAgent?.restart) return { ok: false, reason: '当前不是桌面运行环境（缺少主进程桥）' };
  return await b.tsAgent.restart();
}

/** 打开 trace 目录（系统文件管理器）；非桌面运行环境会如实告知。 */
export async function openTraceDir(): Promise<{ ok: boolean; reason?: string; path?: string }> {
  const b = bridge();
  if (!b?.tsAgent?.openTraceDir) return { ok: false, reason: '当前不是桌面运行环境（缺少主进程桥）' };
  return await b.tsAgent.openTraceDir();
}

/* ---------- 侧栏历史（会话目录） ----------
   后端废弃后，侧栏的真相源是**主进程读的会话目录**（以前是后端任务库）。
   这里刻意不走子进程 RPC：没登录、子进程没起来时侧栏也得能翻旧账。 */

export interface TsSessionSummary {
  id: string;
  title: string;
  goal: string;
  events: number;
  firstTs: number;
  lastTs: number;
  stop: string;
  steps: number;
}

export interface TsSessionListResult {
  ok: boolean;
  reason?: string;
  sessions?: TsSessionSummary[];
}

export interface TsSearchHit {
  id: string;
  seq: number;
  ts: number;
  type: string;
  snippet: string;
}

export function tsSessions(): Promise<TsSessionListResult> {
  const b = bridge()?.tsAgent;
  if (!b?.sessions) throw new Error('会话列表不可用（缺少主进程桥）');
  return b.sessions();
}

export function tsSessionRename(sessionId: string, title: string) {
  const b = bridge()?.tsAgent;
  if (!b?.sessionRename) throw new Error('会话改名不可用（缺少主进程桥）');
  return b.sessionRename(sessionId, title);
}

export function tsSessionDelete(sessionId: string) {
  const b = bridge()?.tsAgent;
  if (!b?.sessionDelete) throw new Error('会话删除不可用（缺少主进程桥）');
  return b.sessionDelete(sessionId);
}

export function tsSessionSearch(term: string, sessionId = ''): Promise<{ ok: boolean; hits?: TsSearchHit[] }> {
  const b = bridge()?.tsAgent;
  if (!b?.sessionSearch) throw new Error('会话搜索不可用（缺少主进程桥）');
  return b.sessionSearch(term, sessionId);
}

const notAvailable = (what: string): never => {
  throw new Error(`TS 智能体不可用（缺少主进程桥：${what}）。请在 Electron 内运行，或先把智能体切到 Python 版。`);
};

export function tsAgentStatus(): Promise<TsAgentStatus> {
  const b = bridge()?.tsAgent;
  if (!b) return notAvailable('tsAgent.status');
  return b.status();
}

export function startTsAgent(opts: Record<string, unknown> = {}): Promise<{ ok: boolean; reason?: string }> {
  const b = bridge()?.tsAgent;
  if (!b) return notAvailable('tsAgent.start');
  return b.start(opts);
}

export function stopTsAgent(): Promise<{ ok: boolean }> {
  const b = bridge()?.tsAgent;
  if (!b) return notAvailable('tsAgent.stop');
  return b.stop();
}

export interface TsAgentPromptArgs {
  sessionId?: string;
  prompt: string;
  workspace?: string;
  model?: string;
  maxSteps?: number;
}

export function tsAgentPrompt(args: TsAgentPromptArgs): Promise<{ ok: boolean; reason?: string; sessionId?: string }> {
  const b = bridge()?.tsAgent;
  if (!b) return notAvailable('tsAgent.prompt');
  return b.prompt({ ...args } as unknown as Record<string, unknown>);
}

export function cancelTsAgent(sessionId: string): Promise<{ ok: boolean; reason?: string }> {
  const b = bridge()?.tsAgent;
  if (!b) return notAvailable('tsAgent.cancel');
  return b.cancel({ sessionId });
}

/** T-131：回放历史会话。事件从落盘 JSONL 读——子进程不在跑也能看历史。 */
export function replayTsAgent(sessionId: string): Promise<{ ok: boolean; reason?: string; events?: unknown[] }> {
  const b = bridge()?.tsAgent;
  if (!b) return notAvailable('tsAgent.replay');
  return b.replay({ sessionId });
}

/** TS-065：上下文用量（分类明细，token 是估算值）。**没在跑也能查**：
 *  主进程会从落盘日志重投影算一份，所以回放旧会话、刚打开任务页时都能显示。 */
export function tsAgentContextUsage(sessionId: string): Promise<{ ok: boolean; reason?: string; usage?: ContextUsage }> {
  const b = bridge()?.tsAgent;
  if (!b) return notAvailable('tsAgent.contextUsage');
  return b.contextUsage({ sessionId });
}

/** 模型清单（模型广场同步）：**Python 后端废弃后的唯一来源**。
 *  agent-ts 拉平台 `/api/ai/models/square` 并映射成对话模型；tier 仍来自本地档位表
 *  （平台不提供，那是"自动选择"的裁决依据）。子进程不在跑时主进程会临时拉起。
 *  source 说明数据来自平台实时、缓存还是内置表；reason 非空就是有降级发生。 */
export interface TsModelItem {
  id: string;
  name: string;
  desc?: string;
  contextWindow?: number;
  abilities: string[];
  modelType?: string;
  provider?: string;
  tier?: string;
  thinking?: string;
  /** S-25：true＝用户自己添加的通道（id 形如 `custom:<通道 id>`），选中它走它自己的地址与 Key */
  custom?: boolean;
}
export interface TsModelList {
  ok: boolean;
  reason?: string;
  models: TsModelItem[];
  total?: number;
  source?: 'square' | 'cache' | 'local';
  fetchedAt?: number;
}
export function fetchTsModels(force = false): Promise<TsModelList> {
  const b = (bridge() as { tsAgent?: { models?: (a: Record<string, unknown>) => Promise<TsModelList> } } | undefined)
    ?.tsAgent;
  if (!b?.models) return notAvailable('tsAgent.models');
  return b.models({ force });
}

/** 订阅流式事件；返回取消订阅函数（组件卸载时要调，否则回调会继续往死组件里灌）。 */
export function onTsAgent(cb: (p: TsAgentPayload) => void): () => void {
  const b = bridge()?.tsAgent;
  if (!b) return () => {};
  return b.on(cb);
}

// ---- 智能体二选一（TS-052）----

export type AgentChoice = 'py' | 'ts';

/** 读当前选择；拿不到就当 Python（默认稳定路径，不要让新东西悄悄顶掉）。 */
export async function getAgentChoice(): Promise<{ agent: AgentChoice; running: boolean }> {
  const b = bridge()?.agentChoice;
  if (!b) return { agent: 'py', running: false };
  try {
    const r = await b.get();
    return { agent: r?.agent === 'ts' ? 'ts' : 'py', running: Boolean(r?.running) };
  } catch {
    return { agent: 'py', running: false };
  }
}

/** 切换智能体。主进程会顺手把另一套的子进程收掉/拉起，所以**不用重启应用**。 */
export async function setAgentChoice(agent: AgentChoice): Promise<{ agent: AgentChoice; running: boolean }> {
  const b = bridge()?.agentChoice;
  const v: AgentChoice = agent === 'ts' ? 'ts' : 'py';
  if (!b) return { agent: v, running: false };
  const r = await b.set(v);
  return { agent: r?.agent === 'ts' ? 'ts' : 'py', running: Boolean(r?.running) };
}
