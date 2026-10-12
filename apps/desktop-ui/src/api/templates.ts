/**
 * 模板库 API（T-012）：列表筛选 + 收藏。
 *
 * 模板**元数据**是随版本发布的静态数据（主进程 data/catalog.json，由前端 mock 生成，
 * 单一数据源）；**收藏**是用户数据，存主进程 store。两者以前都在后端，
 * 后端不拉起之后模板页会整个空掉——而它根本不需要一个常驻进程。
 */

export interface TemplateItem {
  title: string;
  hue: string;
  deco: string;
  cat: string;
  desc: string;
}

export interface TemplateDetail extends TemplateItem {
  prompt: string;
}

export interface TemplateMeta {
  cats: string[];
  counts: { templates: number };
}

interface CatalogBridge {
  templatesMeta?: () => Promise<{ ok: boolean; reason?: string; cats?: string[]; counts?: { templates: number } }>;
  templatesList?: (a: { cat?: string; q?: string; fav?: boolean }) => Promise<{ ok: boolean; reason?: string; items?: TemplateItem[]; total?: number }>;
  templateGet?: (a: { title: string }) => Promise<{ ok: boolean; reason?: string; item?: TemplateDetail }>;
  favoritesGet?: () => Promise<{ ok: boolean; reason?: string; items?: string[] }>;
  favoritesSet?: (a: { title: string; faved: boolean }) => Promise<{ ok: boolean; reason?: string; items?: string[] }>;
}

function bridge<K extends keyof CatalogBridge>(key: K): CatalogBridge[K] {
  const b = (window as unknown as { evawork?: CatalogBridge }).evawork;
  const fn = b && b[key];
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），模板库不可用');
  return fn;
}

function must<T extends { ok?: boolean; reason?: string }>(r: T, what: string): T {
  if (!r || r.ok === false) throw new Error((r && r.reason) || `${what}失败`);
  return r;
}

export async function fetchTemplates(p: { cat?: string; q?: string; fav?: boolean } = {}): Promise<{ items: TemplateItem[]; total: number }> {
  const r = must(await bridge('templatesList')!({ cat: p.cat || '', q: p.q || '', fav: Boolean(p.fav) }), '读取模板');
  return { items: r.items || [], total: r.total ?? (r.items || []).length };
}

export async function fetchTemplateMeta(): Promise<TemplateMeta> {
  const r = must(await bridge('templatesMeta')!(), '读取模板分类');
  return { cats: r.cats || ['全部'], counts: r.counts || { templates: 0 } };
}

export async function fetchTemplate(title: string): Promise<TemplateDetail> {
  const r = await bridge('templateGet')!({ title });
  if (!r.ok || !r.item) throw new Error(r.reason || '模板不存在');
  return r.item;
}

export async function fetchFavorites(): Promise<{ items: string[] }> {
  const r = must(await bridge('favoritesGet')!(), '读取收藏');
  return { items: r.items || [] };
}

export async function setFavorite(title: string, faved: boolean): Promise<{ items: string[] }> {
  const r = must(await bridge('favoritesSet')!({ title, faved }), '更新收藏');
  return { items: r.items || [] };
}
