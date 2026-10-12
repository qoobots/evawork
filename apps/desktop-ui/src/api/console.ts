/**
 * 管理账户控制台 API：规则 / 命令 / 外部授权 / MCP 的通用集合读写。
 * 四类数据结构不同但语义一致（一个列表），故共用一个集合接口。
 *
 * 数据落在**主进程**的本地集合存储（userData/store/console-<key>.json）。
 * 以前存后端 kv；后端不拉起之后这些配置一重启就空，而它们全是本机行为配置。
 */

export type ConsoleKey = 'rules' | 'commands' | 'integrations' | 'mcp';

interface StoreBridge {
  storeList?: (name: string) => Promise<{ ok: boolean; reason?: string; items?: unknown[] }>;
  storeGet?: (name: string, id: string) => Promise<{ ok: boolean; reason?: string; item?: unknown }>;
  storePut?: (name: string, item: unknown) => Promise<{ ok: boolean; reason?: string; item?: unknown }>;
  storeDelete?: (name: string, id: string) => Promise<{ ok: boolean; reason?: string }>;
  storeReplace?: (name: string, items: unknown[]) => Promise<{ ok: boolean; reason?: string; items?: unknown[] }>;
}

function bridge<K extends keyof StoreBridge>(key: K): StoreBridge[K] {
  const b = (window as unknown as { evawork?: StoreBridge }).evawork;
  const fn = b && b[key];
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），控制台不可用');
  return fn;
}

/** 四类各自的命名空间，互不覆盖。 */
function nameOf(key: ConsoleKey): string {
  return `console-${key}`;
}

export async function fetchConsole<T>(key: ConsoleKey): Promise<T[]> {
  const r = await bridge('storeList')!(nameOf(key));
  if (!r.ok) throw new Error(r.reason || '读取控制台配置失败');
  return (r.items || []) as T[];
}

/** 整表写入（整体替换）。 */
export async function saveConsole<T>(key: ConsoleKey, items: T[]): Promise<T[]> {
  const r = await bridge('storeReplace')!(nameOf(key), items);
  if (!r.ok) throw new Error(r.reason || '保存控制台配置失败');
  return (r.items || []) as T[];
}
