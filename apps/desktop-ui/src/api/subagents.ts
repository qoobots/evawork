/**
 * T-142 / T17：Sub-agent 编排（发现 + 委派）。
 *
 * 后端废弃后本地没有承载方：agent-ts 会在任务内部自己派生子代理（事件里能看到
 * SubagentTrace），但**没有对外暴露"列出子代理 / 按名字委派"的接口**——
 * sdk 的允许方法里没有这一项。所以发现返回空、委派如实报错；
 * 不拿"列几个名字出来但委派必失败"的假清单糊弄。
 */

export interface SubAgent {
  name: string;
  display_name: string;
  description: string;
  owner: string;
  owner_kind: string;
  tools: string[];
  entry_tool: string;
  modes: string[];
  issues: string[];
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
}

export interface DelegateResult {
  subagent: string;
  owner: string;
  mode: string;
  ok: boolean;
  output: Record<string, unknown>;
  output_warnings: string[];
  tools_allowed: string[];
  rounds?: number;
  calls?: number;
}

export function fetchSubAgents(): Promise<{ items: SubAgent[] }> {
  return Promise.resolve({ items: [] });
}

export function delegateTask(
  _name: string,
  _task: string,
  _inputs: Record<string, unknown>,
  _mode = 'auto',
  _approved = true,
): Promise<DelegateResult> {
  return Promise.reject(
    new Error('委派暂不可用：智能体没有对外暴露子代理编排接口'),
  );
}
