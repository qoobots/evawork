/**
 * 自动化 API（T-013）：列表 / 新建 / 改开关 / 删除 / 执行历史 / cron 预览。
 *
 * 条目存**主进程**（store），cron 预览是**真解析**（不是假返回 ok）——
 * 那个预览存在的唯一目的就是"保存前看清会什么时候跑"。
 *
 * **不自动触发**：本地没有"应用没开也要跑"的调度器，硬做只会得到一个
 * "开着应用才偶尔生效"的假调度。执行历史如实为空，界面照实说明。
 */

export interface AutomationItem {
  id: string;
  title: string;
  product: string;
  schedule: string;
  interval_min: number;
  cron: string; // T-093：非空则按 cron 触发（优先于 interval_min）
  enabled: boolean;
  last_run: number;
  next_run: number;
  created_at: number;
  error?: string; // cron 算不出触发时刻时的原因
}

/** cron 预览：先看清楚"会什么时候跑"再保存。 */
export interface CronPreview {
  ok: boolean;
  expr: string;
  describe?: string;
  detail?: string;
  next?: number[];
}

export interface AutomationRun {
  id: string;
  automation_id: string;
  title: string;
  started_at: number;
  status: string;
  task_id: string;
  message: string;
}

interface AutomationsBridge {
  automationsList?: () => Promise<{ ok: boolean; reason?: string; items?: AutomationItem[] }>;
  automationsCreate?: (a: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string; item?: AutomationItem }>;
  automationsPatch?: (id: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string; item?: AutomationItem }>;
  automationsRemove?: (id: string) => Promise<{ ok: boolean; reason?: string; deleted?: string }>;
  automationsRuns?: (limit: number) => Promise<{ ok: boolean; reason?: string; items?: AutomationRun[] }>;
  automationsPreview?: (cron: string) => Promise<CronPreview & { reason?: string }>;
  automationsTick?: () => Promise<{ ok: boolean; reason?: string; items?: AutomationRun[] }>;
}

function bridge<K extends keyof AutomationsBridge>(key: K): AutomationsBridge[K] {
  const b = (window as unknown as { evawork?: AutomationsBridge }).evawork;
  const fn = b && b[key];
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），自动化不可用');
  return fn;
}

function must<T extends { ok?: boolean; reason?: string }>(r: T, what: string): T {
  if (!r || r.ok === false) throw new Error((r && r.reason) || `${what}失败`);
  return r;
}

export async function fetchAutomations(): Promise<AutomationItem[]> {
  const r = must(await bridge('automationsList')!(), '读取自动化');
  return r.items || [];
}

export async function createAutomation(p: {
  title: string;
  interval_min?: number;
  schedule?: string;
  product?: string;
  cron?: string;
}): Promise<AutomationItem> {
  const r = must(await bridge('automationsCreate')!(p), '新建自动化');
  return r.item as AutomationItem;
}

export async function patchAutomation(
  id: string,
  patch: { title?: string; schedule?: string; interval_min?: number; cron?: string; enabled?: boolean },
): Promise<AutomationItem> {
  const r = must(await bridge('automationsPatch')!(id, patch), '修改自动化');
  return r.item as AutomationItem;
}

export async function removeAutomation(id: string): Promise<{ deleted: string }> {
  const r = must(await bridge('automationsRemove')!(id), '删除自动化');
  return { deleted: r.deleted || id };
}

export async function fetchAutomationRuns(limit = 50): Promise<AutomationRun[]> {
  const r = await bridge('automationsRuns')!(limit);
  return (r && r.items) || [];
}

/**
 * cron 表达式预览：合法吗、中文怎么说、接下来几次什么时候跑。
 * 刻意不抛错——不合法的表达式要靠它把原因说给用户听。
 */
export async function previewCron(expr: string): Promise<CronPreview> {
  const r = await bridge('automationsPreview')!(expr);
  return { ok: Boolean(r.ok), expr: r.expr ?? expr, describe: r.describe, detail: r.detail || r.reason, next: r.next };
}

/** 手动触发一次调度检查。本地没有调度器，如实返回空（reason 由界面显示）。 */
export async function triggerAutomationTick(): Promise<{ items: AutomationRun[] }> {
  const r = await bridge('automationsTick')!();
  return { items: (r && r.items) || [] };
}
