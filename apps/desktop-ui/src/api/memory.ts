/**
 * 长期记忆（S-21）。
 *
 * 记忆正文落在**应用数据区**的 `memory/user_profile.md`（不是用户工作区）：
 * 它属于用户本人，不该被工作区沙箱约束，也不该占用"写用户文件"的配额。
 *
 * 契约要点：
 * - `enabled` 由设置里的「记忆」开关决定（主进程 toggles.json 的 `memory`），
 *   关掉时不注入上下文——前端据此显示状态；
 * - `content` 就是文件原文，保存＝整份覆盖；超限返回成句原因，前端照实显示。
 *
 * 读写都在**主进程**（userData/memory/user_profile.md），不再经后端。
 */

export interface MemoryState {
  enabled: boolean;
  path: string;
  exists: boolean;
  chars: number;
  updated: number;
  limit: number;
  content: string;
}

interface MemoryBridge {
  memoryGet?: () => Promise<MemoryResult>;
  memorySave?: (content: string) => Promise<MemoryResult>;
  memoryClear?: () => Promise<{ ok: boolean; reason?: string }>;
}

type MemoryResult = { ok: boolean; reason?: string } & Partial<MemoryState>;

function bridge<K extends keyof MemoryBridge>(key: K): MemoryBridge[K] {
  const b = (window as unknown as { evawork?: MemoryBridge }).evawork;
  const fn = b && b[key];
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），记忆功能不可用');
  return fn;
}

function unwrap(r: MemoryResult): MemoryState {
  if (!r.ok) throw new Error(r.reason || '记忆操作失败');
  return {
    enabled: r.enabled !== false,
    path: r.path || '',
    exists: Boolean(r.exists),
    chars: r.chars ?? 0,
    updated: r.updated ?? 0,
    limit: r.limit ?? 0,
    content: r.content || '',
  };
}

export async function fetchMemory(): Promise<MemoryState> {
  return unwrap(await bridge('memoryGet')!());
}

export async function saveMemory(content: string): Promise<MemoryState> {
  return unwrap(await bridge('memorySave')!(content));
}

export async function clearMemory(): Promise<{ ok: boolean }> {
  const r = await bridge('memoryClear')!();
  if (!r.ok) throw new Error(r.reason || '清空失败');
  return { ok: true };
}
