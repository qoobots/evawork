/**
 * 用量 API（T-041）。
 *
 * 口径说明（真相源换成**本地会话目录**后重新对齐）：
 * - 任务数、趋势、按结束原因分布：**真实统计**，来自本地会话目录；
 * - token：模型没回传 usage，只能是**估算**（字符数/4），前端必须显式标注；
 * - 产物数、自动化运行次数：本地没有对应数据，**给 0 而不是猜**——
 *   用量页是用来对账的，拿"看起来差不多"的数填比留空白更有害；
 * - 无积分 / 套餐 / 订阅：产品面向企业内部员工，只记录使用量，不计费。
 */

export interface UsagePoint {
  date: string;
  count: number;
}

export interface UsageRecord {
  time: string;
  record: string;
  model: string;
  product: string;
  cost: number;
}

export interface UsageSummary {
  days: number;
  tasks: { total: number; by_state: Record<string, number>; by_model: Record<string, number> };
  artifacts: number;
  usage_records: UsageRecord[];
  tokens: { estimated: boolean; chars: number; approx: number; method: string };
  series: UsagePoint[];
  automation_runs: { total: number; by_status: Record<string, number> };
}

export async function fetchUsage(days = 30): Promise<UsageSummary> {
  const b = (window as unknown as {
    evawork?: { usage?: (days: number) => Promise<UsageSummary & { ok?: boolean; reason?: string }> };
  }).evawork;
  const fn = b?.usage;
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），用量不可用');
  const r = await fn(days);
  if (r && r.ok === false) throw new Error(r.reason || '读取用量失败');
  return r as UsageSummary;
}
