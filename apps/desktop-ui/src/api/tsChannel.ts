// TS 智能体的**任务通道**（TS-052 收尾）。
//
// 任务页原本只会走 Python 后端的 SSE（`api/tasks.ts` 的 `streamTask`）。
// 这里做的事只有一件：把 TS 智能体的事件流**翻译成同一套 `StreamEvent`**，
// 于是任务页那套（步骤 / 工具 / 叙述 / 终态）不用重写一遍——
// 换的是数据源，不是界面。
//
// 两条必须说清的边界：
//   1. **TS 会话不在后端库里**：侧栏列表、智能跟进都是后端能力，TS 模式下这些
//      一律不调（各自独立存储，不能假装两边是同一份数据）。
//      **例外**：撤销回滚点两边都有——TS 侧用自己的影子仓库（TS-060），
//      撤销走主进程而不是后端接口，但界面上那张卡是同一张。
//   2. **TS 智能体不再有人工确认环节**（见 agent-ts 精简）：对应 UI 已整体移除，
//      历史任务回显仍走这套 StreamEvent，只是不再产生 `approval` / `approval_unattended` 帧。

import type { ContextUsage, StreamEvent, Step, SubagentTrace, Task } from './tasks';
import { cancelTsAgent, onTsAgent, replayTsAgent, tsAgentPrompt, type TsAgentPromptArgs } from './tsAgent';
import type { TsAgentPayload } from './backend';

/**
 * TS 会话 id **自带** `ts-` 前缀（见 agent-ts 的 `newSessionId`：`ts-<base36>-<rand>`），
 * 所以任务页里的任务 id 直接用会话 id，**不再叠一层**。
 *
 * 以前这里又加一个 `ts-`，本地条目就成了 `ts-ts-…`，与 `fetchTaskList` 返回的原始会话 id
 * 对不上：同一条会话在侧栏以两条出现，且 `tsSessionOf` 多剥一层导致回放/回滚点
 * 全指向一个不存在的会话。
 */
const TS_PREFIX = 'ts-';

/** 会话 id → 任务页任务 id。二者同值；万一会话 id 没带前缀就补一次，保证能认出来。 */
export function tsTaskId(sessionId: string): string {
  return isTsTaskId(sessionId) ? sessionId : `${TS_PREFIX}${sessionId}`;
}
export function isTsTaskId(id: string): boolean {
  return id.startsWith(TS_PREFIX);
}
/** 任务 id → 会话 id。同值返回——`ts-` 是会话 id 本身的一部分，剥掉就指向不存在的会话。 */
export function tsSessionOf(taskId: string): string {
  return isTsTaskId(taskId) ? taskId : '';
}

/** 停止一轮（协作式：TS 侧在本步边界停下）。传任务页里的 taskId。 */
export async function cancelTsAgentFor(taskId: string): Promise<void> {
  const sid = tsSessionOf(taskId);
  if (!sid) return;
  await cancelTsAgent(sid).catch(() => undefined);
}

function fakeTask(sessionId: string, title: string, state: string): Task {
  return {
    id: tsTaskId(sessionId),
    title,
    mode: 'ts',
    model: 'ts-agent',
    state,
    steps: [],
    artifacts: [],
    error: '',
  };
}

function stepOf(id: string, title: string, status: Step['status']): Step {
  return { id, title, status, action: '', detail: '' };
}

/**
 * 跑一轮 TS 智能体，事件形状与后端 SSE 一致（可直接喂给任务页的 `applyEvent`）。
 *
 * `onSession` 在拿到真实会话 id 时回调一次——任务页靠它把"这一轮"绑到会话上
 * （追问要发回同一个会话，否则每问一次就换一个上下文）。
 *
 * 注意：**工作区与沙箱档位是主进程拉起 TS 智能体时定好的**，不随每一轮改
 * （改了就得重启子进程，代价远大于收益）。因此 `workspace` / `policy` 在这里
 * 只是"带过去给人看"，真正生效的是启动时的那一份。
 */
export async function* streamTsTask(
  args: TsAgentPromptArgs,
  onSession?: (sessionId: string) => void,
): AsyncGenerator<StreamEvent> {
  const waiters: ((p: TsAgentPayload | null) => void)[] = [];
  const queue: TsAgentPayload[] = [];
  const push = (p: TsAgentPayload | null) => {
    const w = waiters.shift();
    if (w) w(p);
    else if (p) queue.push(p);
  };
  const off = onTsAgent(push);

  let sessionId = args.sessionId || '';
  let ended = false;
  // 合并重复的 notice（如后端每步都推的"已压缩"）：相同文案只放一遍，避免执行过程里刷一屏。
  let lastNotice = '';
  const finish = (): void => {
    if (ended) return;
    ended = true;
    off();
    push(null);
  };

  try {
    const r = await tsAgentPrompt(args);
    if (!r.ok) throw new Error(r.reason || 'TS 智能体未接受该请求');
    sessionId = r.sessionId || sessionId;
    onSession?.(sessionId);
    yield { type: 'status', state: 'running' };
    // TS 侧不做规划：合成一步，界面上的"执行过程"才有落点（不假装它有 plan）
    yield { type: 'plan', steps: [stepOf('ts-1', 'TS 智能体执行中', 'running')] };

    for (;;) {
      /* **不设通道静默上限**：长任务（委派子代理跑满几分钟、长命令、长思考）本来就会
         长时间一帧不发，按秒猜死活只会把正常任务误杀成"已停止等待"。
         这一轮何时结束，只由 TS 侧的终态帧、停止信号与子进程退出决定。 */
      const p = queue.length
        ? queue.shift()!
        : await new Promise<TsAgentPayload | null>((res) => waiters.push(res));
      if (!p) break;
      if (p.sessionId && sessionId && p.sessionId !== sessionId) continue;

      if (p.kind === 'text') {
        if (p.text) yield { type: 'token', content: p.text, step: null };
        continue;
      }

      /* TS-065：上下文用量（派生值、不落盘）。**不参与任务状态机**——不改 phase、不 commit，
         只驱动输入框下方那条监控，所以直接转出去就完事。 */
      if (p.kind === 'usage') {
        if (p.usage) yield { type: 'usage', usage: p.usage as ContextUsage };
        continue;
      }

      if (p.kind === 'event') {
        const e = (p.event || {}) as { type?: string; step?: number; [k: string]: unknown };
        const step = e.step ? String(e.step) : null;
        switch (e.type) {
          case 'tool/call': {
            const name = String(e.tool || 'tool');
            // call id 用 SDK 的 tool_call_id（事件里的 e.call）：一轮可以并发调多个
            // 同名工具，拿 step+tool 拼 id 会撞车——结果回填错行、去重误杀。
            const cid = String(e.call || `c${String(e.step ?? 0)}-${name}`);
            yield {
              type: 'tool_call',
              step,
              call: { id: cid, name, arguments: JSON.stringify(e.args ?? {}) },
            };
            break;
          }
          case 'tool/result': {
            const name = String(e.tool || 'tool');
            const ok = e.ok !== false;
            const out = typeof e.content === 'string' ? e.content : '';
            const cid = String(e.call || `c${String(e.step ?? 0)}-${name}`);
            yield {
              type: 'tool_result',
              step,
              result: {
                call_id: cid,
                name,
                ok,
                output: ok ? out : '',
                error: ok ? '' : String(e.error || out || '工具执行失败'),
                // TS-064：子代理轨迹 → 复用界面已有的那张卡（T-090），形状刻意同形
                subagent: (e.subagent as SubagentTrace | undefined) ?? undefined,
              },
            };
            break;
          }
          // 模型要调工具了：此前流出的正文是过程叙述，不是答案（与后端 narration 帧同义）
          case 'agent/continuation':
            yield { type: 'narration', step };
            break;
          case 'context/compact': {
            const msg = '上下文接近预算，已压缩早期轮次（最近的内容保留）';
            if (msg !== lastNotice) { lastNotice = msg; yield { type: 'notice', message: msg }; }
            break;
          }
          /* TS-066：步数进度。以前这一步的标题永远写着"TS 智能体执行中"——
             跑到第 90 步和刚起步长得一模一样，用户没法判断"是不是卡住了"。
             没有"共几步"那半句：步数由模型自己决定，没有上限可显示。
             id 仍是 ts-1，界面按 id 原地更新，不会堆出一串步骤。 */
          case 'agent/step': {
            const n = Number(e.step || 0);
            if (n > 0) {
              yield {
                type: 'step',
                step: stepOf('ts-1', `TS 智能体执行中（第 ${n} 步）`, 'running'),
              };
            }
            break;
          }
          case 'step/error':
            yield { type: 'notice', message: String(e.error || '本步出错') };
            break;
          default:
            break;
        }
        continue;
      }

      if (p.kind === 'status') {
        const st = String(p.status || '');
        if (st === 'running') continue;
        if (st === 'error') {
          yield { type: 'error', message: String(p.error || p.reason || 'TS 智能体执行失败') };
          break;
        }
        // idle：本轮结束。stop 说明它是怎么结束的——**终止方式必须如实呈现**：
        // - cancelled → "已中断"
        // - 预算类（deadline / timeout / stalled）→ 已做的产出都在
        //   上下文里：按"limit"呈现，界面给"继续"，**不给"重试"**（那暗示从头重来）
        // - 真失败类（guard 死循环 / error / killed 进程退出）→ 按"出错"呈现并给"重试"，
        //   正文已流出的部分保留
        // - completed → "已完成"，但若本轮有工具调用没做成，任务状态标 partial，
        //   界面显示"完成（有失败）"——不能三个命令全失败还挂绿色"已完成"
        const fin = p as { stop?: string; note?: string; failed?: number };
        const stop = String(fin.stop || 'completed');
        const failed = Number(fin.failed || 0);
        const task = fakeTask(sessionId, '', stop === 'cancelled' ? 'cancelled' : failed > 0 ? 'partial' : 'done');
        if (stop === 'cancelled') {
          yield { type: 'cancelled', task, reason: '已停止' };
        } else if (stop !== 'completed') {
          yield { type: 'step', step: stepOf('ts-1', 'TS 智能体执行中', 'failed') };
          yield { type: 'error', message: String(fin.note || `未正常结束（${stop}）`) };
        } else {
          yield {
            type: 'step',
            step: stepOf('ts-1', failed > 0 ? `TS 智能体执行中（${failed} 个调用未成功）` : 'TS 智能体执行中', 'done'),
          };
          yield { type: 'done', task };
        }
        break;
      }

      if (p.kind === 'exit') {
        // 子进程没了却没收到终态帧：如实报错，不要停在"执行中"
        yield { type: 'error', message: 'TS 智能体进程已退出（未收到完成帧）' };
        break;
      }
    }
  } finally {
    finish();
  }
}

/** 回放流里的一帧：正常 StreamEvent 之外，`ts_turn` 标记一轮的开始（带用户的问题），
 *  调用方在轮边界做提交（与 Python 侧 openTask 的分段重建同一套节奏）。 */
export type ReplayEvent = StreamEvent | { type: 'ts_turn'; user: string };


/**
 * T-131：回放一个 TS 会话——从落盘事件日志重建任务页事件流。
 *
 * 事件日志是真相源（TS-042），侧栏那些 TS 条目点了就靠它还原：模型答了什么、
 * 调了哪些工具、成败如何、有没有被压缩/中断。映射规则与 `streamTsTask` 保持一致——
 * 换的是数据源（落盘 JSONL，子进程不在跑也能读），不是界面。
 */
export async function* replayTsTask(sessionId: string): AsyncGenerator<ReplayEvent> {
  const r = await replayTsAgent(sessionId);
  if (!r.ok || !r.events?.length) throw new Error(r.reason || '没有可回放的会话记录');
  // 回放同样合并重复 notice（重放的事件流里也可能连续出现"已压缩"）
  let lastNotice = '';
  for (const raw of r.events) {
    const e = (raw || {}) as { type?: string; [k: string]: unknown };
    const step = e.step ? String(e.step) : null;
    switch (e.type) {
      case 'turn/start': {
        yield { type: 'ts_turn', user: String(e.prompt ?? '') } as ReplayEvent;
        yield { type: 'plan', steps: [stepOf('ts-1', 'TS 智能体执行中', 'running')] };
        break;
      }
      case 'assistant/message': {
        const text = String(e.text ?? '');
        if (text) yield { type: 'token', content: text, step: null };
        break;
      }
      case 'tool/call': {
        const name = String(e.tool || 'tool');
        const cid = String(e.call || `c${String(e.step ?? 0)}-${name}`);
        yield {
          type: 'tool_call',
          step,
          call: { id: cid, name, arguments: JSON.stringify(e.args ?? {}) },
        };
        break;
      }
      case 'tool/result': {
        const name = String(e.tool || 'tool');
        const ok = e.ok !== false;
        const out = typeof e.content === 'string' ? e.content : '';
        const cid = String(e.call || `c${String(e.step ?? 0)}-${name}`);
        yield {
          type: 'tool_result',
          step,
          result: {
            call_id: cid,
            name,
            ok,
            output: ok ? out : '',
            error: ok ? '' : String(e.error || out || '工具执行失败'),
              subagent: (e.subagent as SubagentTrace | undefined) ?? undefined,
          },
        };
        break;
      }
      case 'agent/continuation':
        yield { type: 'narration', step };
        break;
      // 回放同样要显示"第 N 步"：看历史任务时也得能看出它跑到哪停的
      case 'agent/step': {
        const n = Number(e.step ?? 0);
        if (n > 0) {
          yield { type: 'step', step: stepOf('ts-1', `TS 智能体执行中（第 ${n} 步）`, 'running') };
        }
        break;
      }
      case 'context/compact': {
        const msg = '上下文接近预算，已压缩早期轮次（最近的内容保留）';
        if (msg !== lastNotice) { lastNotice = msg; yield { type: 'notice', message: msg }; }
        break;
      }
      case 'step/error': {
        const msg = String(e.error || '本步出错');
        if (msg !== lastNotice) { lastNotice = msg; yield { type: 'notice', message: msg }; }
        break;
      }
        break;
      case 'turn/end': {
        // 与 streamTsTask 的终态分支同一套语义：怎么结束的、有几个调用没做成，都如实呈现
        const stop = String(e.stop || 'completed');
        const failed = Number(e.failedTools || 0);
        const task = fakeTask(sessionId, '', stop === 'cancelled' ? 'cancelled' : failed > 0 ? 'partial' : 'done');
        if (stop === 'cancelled') {
          yield { type: 'cancelled', task, reason: String(e.note || '已停止') };
        } else if (stop !== 'completed') {
          yield { type: 'step', step: stepOf('ts-1', 'TS 智能体执行中', 'failed') };
          yield { type: 'error', message: String(e.note || `未正常结束（${stop}）`) };
        } else {
          yield {
            type: 'step',
            step: stepOf('ts-1', failed > 0 ? `TS 智能体执行中（${failed} 个调用未成功）` : 'TS 智能体执行中', 'done'),
          };
          yield { type: 'done', task };
        }
        break;
      }
      default:
        break;
    }
  }
}
