/**
 * 市场列表的**单一**筛选 / 排序 / 离线回退实现（T-142 / D2）。
 *
 * 之前 `localPlugins()` / `localSkills()` 各自复制了一份「按分类 + 关键词过滤」的逻辑，
 * 且离线时**没有排序**（在线由后端排），于是同一个页面在离线/在线两种状态下
 * 顺序不一致、过滤规则还可能各自漂移。这里抽成纯函数：
 * - `filterItems`  唯一的过滤实现（分类 + 关键词）；
 * - `sortItems`    与后端 `market_stats.sort_items` **同规则**（信任级 > 评分 > 安装量），
 *                  这样离线 mock 的顺序和在线一致；
 * - `resolveItems` 唯一的"在线取真数据 / 离线回退 mock"入口。
 *
 * 纯函数、无副作用、无框架依赖 → 可直接用 Node 内置测试跑（见 market.test.ts）。
 */

export type SortMode = 'trust' | 'rating' | 'downloads';

export interface MarketItem {
  name: string;
  desc?: string;
  cats?: string[];
  publisher?: string;
  verified?: boolean;
  rating?: number | null;
  downloads?: number;
}

export interface FilterOpts {
  cat?: string;
  q?: string;
}

/** 分类 + 关键词过滤（'全部' 或空 = 不限）。唯一实现。 */
export function filterItems<T extends MarketItem>(items: readonly T[], opts: FilterOpts = {}): T[] {
  const cat = (opts.cat ?? '').trim();
  const q = (opts.q ?? '').trim().toLowerCase();
  return items.filter((it) => {
    if (cat && cat !== '全部' && !(it.cats ?? []).includes(cat)) return false;
    if (q && !`${it.name ?? ''} ${it.desc ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** 信任级：官方(EvaWorks+已验证)=0，已验证=1，社区=2。与后端一致。 */
function trustTier(it: MarketItem): number {
  if (it.publisher === 'EvaWorks' && it.verified) return 0;
  if (it.verified) return 1;
  return 2;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 排序：trust=信任级>评分>安装量（默认）；rating=纯评分；downloads=纯安装量。 */
export function sortItems<T extends MarketItem>(items: readonly T[], mode: SortMode = 'trust'): T[] {
  const out = [...items];
  const byName = (a: T, b: T) => String(a.name ?? '').localeCompare(String(b.name ?? ''));
  if (mode === 'rating') {
    out.sort((a, b) => num(b.rating) - num(a.rating) || num(b.downloads) - num(a.downloads) || trustTier(a) - trustTier(b) || byName(a, b));
  } else if (mode === 'downloads') {
    out.sort((a, b) => num(b.downloads) - num(a.downloads) || num(b.rating) - num(a.rating) || trustTier(a) - trustTier(b) || byName(a, b));
  } else {
    out.sort((a, b) => trustTier(a) - trustTier(b) || num(b.rating) - num(a.rating) || num(b.downloads) - num(a.downloads) || byName(a, b));
  }
  return out;
}

export interface ResolveOpts<T extends MarketItem> extends FilterOpts {
  /** 后端可达？true 走 fetchRemote，false 用 mock（离线回退）。 */
  online: boolean;
  fetchRemote: () => Promise<T[]>;
  /** 离线兜底的本地 mock 数据。 */
  mock: readonly T[];
  sort?: SortMode;
  /** 透传给 fetchRemote（由调用方决定是否强制后端丢弃缓存）。 */
  refresh?: boolean;
}

/**
 * 唯一的列表入口：
 * - 在线 → 取后端数据（后端已按 cat/q 过滤并排好序，直接用）；
 * - 离线 → 用本地 mock，并**套用同一套过滤 + 排序**，保证顺序与在线一致。
 */
export async function resolveItems<T extends MarketItem>(opts: ResolveOpts<T>): Promise<T[]> {
  if (opts.online) {
    try {
      return await opts.fetchRemote();
    } catch {
      // 后端说了要连却连不上：如实回退到本地数据，而不是整页空白
      return sortItems(filterItems(opts.mock, opts), opts.sort);
    }
  }
  return sortItems(filterItems(opts.mock, opts), opts.sort);
}
