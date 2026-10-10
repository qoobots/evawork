/**
 * S-25：自定义模型通道（自带 Key / BYOK）。
 * 设置→模型页「添加模型」以前是摆设：没有地方录 Key，录了也没人用。
 * 这里给的是真通道——录入后模型清单会带上它，任务里选它就用它自己的地址与 Key 发请求，
 * 因此**不登录也能跑任务**。
 *
 * 通道与 Key 由**主进程**持有（userData/providers.json）：它们本来就不该离开本机，
 * 以前存在后端 kv 表里，后端一废弃用户录的 Key 就跟着没了。
 * 列表里只回显后 4 位——界面要的是"录了没"，不是原文。
 */

export interface ProviderItem {
  id: string;
  name: string;
  base_url: string;
  model: string;
  enabled: boolean;
  has_key: boolean;
  key_hint: string;
  created: number;
}

export interface ProviderDraft {
  name: string;
  base_url: string;
  model: string;
  api_key?: string;
  enabled?: boolean;
}

export interface TestResult {
  ok: boolean;
  output?: string;
  error?: string;
  status?: number;
}

interface ProvidersBridge {
  providersList?: () => Promise<{ ok: boolean; reason?: string; items?: ProviderItem[] }>;
  providersAdd?: (draft: ProviderDraft) => Promise<{ ok: boolean; reason?: string; item?: ProviderItem }>;
  providersUpdate?: (id: string, patch: Partial<ProviderDraft>) => Promise<{ ok: boolean; reason?: string; item?: ProviderItem }>;
  providersDelete?: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  providersTest?: (a: { id?: string } & Partial<ProviderDraft>) => Promise<TestResult & { reason?: string }>;
}

function bridge<K extends keyof ProvidersBridge>(key: K): ProvidersBridge[K] {
  const b = (window as unknown as { evawork?: ProvidersBridge }).evawork;
  const fn = b && b[key];
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），自定义通道不可用');
  return fn;
}

function must<T extends { ok?: boolean; reason?: string }>(r: T, what: string): T {
  if (!r || r.ok === false) throw new Error((r && r.reason) || `${what}失败`);
  return r;
}

/** 剥掉 Vue 的响应式外壳再递给 IPC。
 *  `ref` 的对象值是 **Proxy**，而 Electron 的 IPC 走结构化克隆，Proxy 克隆不了——
 *  直接把 `draft.value` 传过去会抛 "An object could not be cloned."（界面上就一句
 *  看不懂的英文报错）。入参几乎都来自 `ref`，所以在这一层统一拆成纯对象，
 *  免得每个调用点各自记得 `{ ...draft.value }`。
 *  Spread 只做浅拷贝——这里的字段全是原始值，够用。 */
function plain<T extends object>(v: T): T {
  return { ...v };
}

export async function fetchProviders(): Promise<{ items: ProviderItem[] }> {
  const r = must(await bridge('providersList')!(), '读取通道');
  return { items: r.items || [] };
}

export async function addProvider(draft: ProviderDraft): Promise<{ ok: boolean; item: ProviderItem }> {
  const r = must(await bridge('providersAdd')!(plain(draft)), '添加通道');
  return { ok: true, item: r.item as ProviderItem };
}

export async function updateProvider(id: string, patch: Partial<ProviderDraft>): Promise<{ ok: boolean; item: ProviderItem }> {
  const r = must(await bridge('providersUpdate')!(id, plain(patch)), '更新通道');
  return { ok: true, item: r.item as ProviderItem };
}

export async function deleteProvider(id: string): Promise<{ ok: boolean }> {
  must(await bridge('providersDelete')!(id), '删除通道');
  return { ok: true };
}

/** 真发一次请求验证这条通道（主进程用 GET /models，不烧 token）。 */
export async function testProvider(id: string): Promise<TestResult> {
  const r = await bridge('providersTest')!({ id });
  return { ok: Boolean(r.ok), output: r.output, error: r.error || r.reason, status: r.status };
}

export async function testProviderDraft(draft: ProviderDraft): Promise<TestResult> {
  const r = await bridge('providersTest')!(plain(draft));
  return { ok: Boolean(r.ok), output: r.output, error: r.error || r.reason, status: r.status };
}
