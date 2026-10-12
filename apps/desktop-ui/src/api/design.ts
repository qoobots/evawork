/**
 * 设计系统 API（T-010 读取 + T-033 副本/自定义）。
 *
 * 存**主进程**（store 的 design-systems 集合）。后端原先把它放在 kv 表里，
 * 后端不拉起之后用户建的设计系统会全部消失——它只是本机的一份 JSON。
 *
 * 关于 `source`：后端只有"自建/副本"两种来源（都标 custom），没有内置种子，
 * 所以这里不会产生 builtin 条目；字段保留是为了界面区分编辑权限时不用改类型。
 */

export interface DesignTokenItem {
  name: string;
  hex: string;
}

export interface DesignTokenGroup {
  name: string;
  items: DesignTokenItem[];
}

export interface DesignDTO {
  id: string;
  name: string;
  hue: string;
  tokens: DesignTokenGroup[];
  fonts: { name: string; label: string }[];
  source: 'builtin' | 'user';
  origin: string;
  created_at?: number | null;
  graphicIcons?: string[];
  changed?: number;
}

export interface TokenPatch {
  group: string;
  token: string;
  hex: string;
}

const COLLECTION = 'design-systems';

interface StoreBridge {
  storeList?: (name: string) => Promise<{ ok: boolean; reason?: string; items?: unknown[] }>;
  storeGet?: (name: string, id: string) => Promise<{ ok: boolean; reason?: string; item?: unknown }>;
  storePut?: (name: string, item: unknown) => Promise<{ ok: boolean; reason?: string; item?: unknown }>;
  storeDelete?: (name: string, id: string) => Promise<{ ok: boolean; reason?: string }>;
}

function bridge<K extends keyof StoreBridge>(key: K): StoreBridge[K] {
  const b = (window as unknown as { evawork?: StoreBridge }).evawork;
  const fn = b && b[key];
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），设计系统不可用');
  return fn;
}

function must<T extends { ok?: boolean; reason?: string }>(r: T, what: string): T {
  if (!r || r.ok === false) throw new Error((r && r.reason) || `${what}失败`);
  return r;
}

export async function fetchDesignSystems(): Promise<DesignDTO[]> {
  const r = must(await bridge('storeList')!(COLLECTION), '读取设计系统');
  return (r.items || []) as DesignDTO[];
}

export async function fetchDesignSystem(id: string): Promise<DesignDTO> {
  const r = await bridge('storeGet')!(COLLECTION, id);
  if (!r.ok || !r.item) throw new Error(r.reason || '设计系统不存在');
  return r.item as DesignDTO;
}

/** 副本：读原条目 → 换 id 与名字 → 存一份新的。原来这一步在后端做，逻辑就这几行。 */
export async function duplicateDesignSystem(id: string, name = ''): Promise<DesignDTO> {
  const src = await fetchDesignSystem(id);
  const r = must(
    await bridge('storePut')!(COLLECTION, {
      ...src,
      id: '', // 空 id → 主进程生成新的
      name: name || `${src.name} 副本`,
      source: 'user',
      origin: src.id,
      created_at: Math.floor(Date.now() / 1000),
    }),
    '复制设计系统',
  );
  return r.item as DesignDTO;
}

export async function createDesignSystem(name: string, base = ''): Promise<DesignDTO> {
  if (!name.trim()) throw new Error('name 必填');
  const r = must(
    await bridge('storePut')!(COLLECTION, {
      id: '',
      name: name.trim(),
      base: base || '',
      source: 'user',
      origin: base || '',
      tokens: {},
      fonts: [],
      created_at: Math.floor(Date.now() / 1000),
    }),
    '新建设计系统',
  );
  return r.item as DesignDTO;
}

/** 改色：patches 按 group/token 落到 tokens 的嵌套结构里。 */
export async function updateDesignSystem(id: string, patches: TokenPatch[], name?: string): Promise<DesignDTO> {
  const cur = await fetchDesignSystem(id);
  const tokens = JSON.parse(JSON.stringify(cur.tokens || [])) as DesignTokenGroup[];
  for (const p of patches || []) {
    const g = tokens.find((x) => x.name === p.group);
    if (!g) continue;
    const item = g.items.find((x) => x.name === p.token);
    if (item) item.hex = p.hex;
  }
  const r = must(
    await bridge('storePut')!(COLLECTION, { ...cur, tokens, ...(name ? { name } : {}), changed: Date.now() }),
    '更新设计系统',
  );
  return r.item as DesignDTO;
}

export async function deleteDesignSystem(id: string): Promise<{ deleted: string }> {
  must(await bridge('storeDelete')!(COLLECTION, id), '删除设计系统');
  return { deleted: id };
}
