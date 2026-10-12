/**
 * S-22：工作树（git worktree）——设置→工作树那一页的三个控件此前全是摆设
 * （保留分支开关没人读、GB 阈值写死 5、占用表写死"暂无数据"），因为后端根本没有这个能力。
 * 现在建/清/统计都是真的 `git worktree`，阈值也真的在建树前挡一道。
 *
 * 后端废弃后改由**主进程**执行：git 就在本机，主进程本来就有工作区路径，
 * 为一个只会调 git 的功能维持一个常驻服务不划算。
 * 工作区不是 git 仓库 / 没装 git 时，`supported=false` + 成句原因，界面照实显示。
 */

interface WorktreeBridge {
  worktreeState?: () => Promise<WorktreeState & { ok?: boolean }>;
  worktreeCreate?: (branch: string, base: string) => Promise<{ ok: boolean; reason?: string; item?: WorktreeItem }>;
  worktreeDelete?: (path: string, force: boolean) => Promise<{ ok: boolean; reason?: string; branchDropped?: boolean }>;
  worktreePrune?: (keep: number) => Promise<{ ok: boolean; reason?: string; removed?: unknown[]; failed?: unknown[]; kept?: number }>;
  worktreeConfig?: (patch: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>;
}

function bridge<K extends keyof WorktreeBridge>(key: K): WorktreeBridge[K] {
  const b = (window as unknown as { evawork?: WorktreeBridge }).evawork;
  const fn = b && b[key];
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），工作树不可用');
  return fn;
}

export interface WorktreeItem {
  path: string;
  name: string;
  branch: string;
  head: string;
  detached: boolean;
  /** 主工作树（仓库本身）：不算进"工作树占用"，也不能删 */
  main: boolean;
  sizeBytes: number;
  /** 文件太多没量完（数量是"已量到的"，不是精确值） */
  truncated: boolean;
  mtime: number;
}

export interface WorktreeState {
  supported: boolean;
  /** 不支持时的成句原因（不是 git 仓库 / 本机没装 git） */
  reason: string;
  repo: string;
  items: WorktreeItem[];
  totalBytes: number;
  thresholdBytes: number;
  keepBranch: boolean;
}

export async function fetchWorktrees(): Promise<WorktreeState> {
  const r = await bridge('worktreeState')!();
  return {
    supported: Boolean(r.supported),
    reason: r.reason || '',
    repo: r.repo || '',
    items: r.items || [],
    totalBytes: r.totalBytes || 0,
    thresholdBytes: r.thresholdBytes || 0,
    keepBranch: Boolean(r.keepBranch),
  };
}

export async function createWorktree(branch: string, base = ''): Promise<WorktreeItem> {
  const r = await bridge('worktreeCreate')!(branch, base);
  if (!r.ok || !r.item) throw new Error(r.reason || '建工作树失败');
  return r.item;
}

/** 删一棵工作树；分支删不删按设置里的「清理时保留分支」（未合并的分支 git 会拒绝删）。 */
export async function deleteWorktree(path: string, force = false): Promise<{ branchDropped: boolean }> {
  const r = await bridge('worktreeDelete')!(path, force);
  if (!r.ok) throw new Error(r.reason || '删不掉');
  return { branchDropped: Boolean(r.branchDropped) };
}

/** 批量清理：保留最近 keep 棵（只清本应用建的，用户手工建的不碰）。 */
export async function pruneWorktrees(keep: number): Promise<{ removed: unknown[]; failed: unknown[]; kept: number }> {
  const r = await bridge('worktreePrune')!(keep);
  if (!r.ok) throw new Error(r.reason || '清理失败');
  return { removed: r.removed || [], failed: r.failed || [], kept: r.kept ?? 0 };
}

/** 阈值（字节）与「清理时保留分支」——存主进程，以前写死 5GB 且开关没人读。 */
export async function saveWorktreeConfig(patch: { thresholdBytes?: number; keepBranch?: boolean }): Promise<void> {
  const r = await bridge('worktreeConfig')!(patch);
  if (!r.ok) throw new Error(r.reason || '保存设置失败');
}
