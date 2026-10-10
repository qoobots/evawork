/**
 * T-070：消费 SSE 里的工具调用事件（tool_call → tool_result）。
 *
 * 工具由模型自主发起，前端职责只有两个：如实记录"调了什么"、如实展示"结果如何"。
 * 新建任务页与模板运行弹窗共用这一份逻辑，避免同一套东西两边各写一遍走样。
 */
import { ref } from 'vue';
import type { SubagentTrace, ToolCall, ToolDiff, ToolResult } from '@/api/tasks';

export interface ToolRun {
  id: string;
  name: string;
  args: string;
  status: 'running' | 'ok' | 'fail';
  output: string;
  error: string;
  /** T-089：写类工具的改动前后原文（有值 → 面板里渲染 diff 供审阅） */
  diff?: ToolDiff;
  /** T-090：子代理轨迹（派了活就得让人看见它到底干了什么） */
  subagent?: SubagentTrace;
  /** T-074：耗时（毫秒）与执行模式（parallel/exclusive） */
  elapsed?: number;
  mode?: string;
  open: boolean;
}

export function useToolRuns() {
  const toolRuns = ref<ToolRun[]>([]);

  function resetToolRuns() {
    toolRuns.value = [];
  }

  /**
   * T-108：返回新建的那条（响应式代理），调用方把它追加进过程时间线——后续 tool_result
   * 就地回填的是同一个对象，时间线里那条会跟着更新。同 id 重复到达（续跑）返回
   * undefined，调用方据此不重复入线。
   */
  function pushToolCall(c: ToolCall): ToolRun | undefined {
    // T-074：续跑时同一调用会收到第二次 tool_call（同 id）——去重，别出现两行
    if (toolRuns.value.some((t) => t.id === c.id)) return undefined;
    toolRuns.value.push({
      id: c.id,
      name: c.name,
      args: c.arguments || '',
      status: 'running',
      output: '',
      error: '',
      open: false,
    });
    return toolRuns.value[toolRuns.value.length - 1];
  }

  /** T-108：命中已有条目就地回填并返回 undefined；补条（结果先到）时返回新条目供入线 */
  function patchToolResult(r: ToolResult): ToolRun | undefined {
    const patch = {
      status: (r.ok ? 'ok' : 'fail') as ToolRun['status'],
      output: r.output || '',
      error: r.error || '',
      elapsed: r.elapsed_ms,
      mode: r.mode,
      diff: r.diff,
      subagent: r.subagent,
    };
    const hit = toolRuns.value.find((t) => t.id === r.call_id);
    if (hit) {
      Object.assign(hit, patch);
      return undefined;
    }
    // 结果早于调用事件到达（如重连续跑）时不静默丢弃，补一条
    toolRuns.value.push({ id: r.call_id, name: r.name, args: '', ...patch, open: false });
    return toolRuns.value[toolRuns.value.length - 1];
  }

  return { toolRuns, resetToolRuns, pushToolCall, patchToolResult };
}
