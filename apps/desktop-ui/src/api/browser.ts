/**
 * S-23：内置浏览器——窗口是 Electron 的 BrowserWindow（独立 partition `persist:evawork-inner`）。
 *
 * 命令下发改成**渲染层直接 IPC 调主进程**：以前是"后端入队 → 主进程每 1s 轮询取走 → 回执"，
 * 后端不拉起之后这条链就断了，而且它本来就绕了一圈（窗口就在主进程里）。
 * 命令执行失败一律带成句原因，不说"已打开"。
 */

export interface BrowserShot {
  name: string;
  bytes: number;
  mtime: number;
}

export interface BrowserState {
  /** 主进程窗口是否还活着（最近 10s 内来取过命令） */
  connected: boolean;
  lastSeen: number | null;
  /** 设置里的「AI 任务默认浏览器」：inner=内置浏览器 / outer=系统默认浏览器 */
  mode: 'inner' | 'outer';
  innerEnabled: boolean;
  outerEnabled: boolean;
  autoScreenshot: boolean;
  shotsDir: string;
  shots: BrowserShot[];
}

interface BrowserBridge {
  browserState?: () => Promise<BrowserStateResult>;
  browserCommand?: (cmd: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; result?: Record<string, unknown> }>;
  browserShot?: (name: string) => Promise<{ ok: boolean; reason?: string; url?: string }>;
}

type BrowserStateResult = { ok: boolean; reason?: string } & Partial<BrowserState>;

function bridge<K extends keyof BrowserBridge>(key: K): BrowserBridge[K] {
  const b = (window as unknown as { evawork?: BrowserBridge }).evawork;
  const fn = b && b[key];
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），内置浏览器不可用');
  return fn;
}

export async function fetchBrowser(): Promise<BrowserState> {
  const r = await bridge('browserState')!();
  if (!r.ok) throw new Error(r.reason || '读取内置浏览器状态失败');
  return {
    connected: Boolean(r.connected),
    lastSeen: r.lastSeen ?? null,
    mode: r.mode === 'outer' ? 'outer' : 'inner',
    innerEnabled: r.innerEnabled !== false,
    outerEnabled: r.outerEnabled !== false,
    autoScreenshot: r.autoScreenshot !== false,
    shotsDir: r.shotsDir || '',
    shots: r.shots || [],
  };
}

/** 在内置浏览器里真打开网址（shot=true 时顺带自动截图）。 */
export async function openInBrowser(url: string, shot = true): Promise<{ url: string; title: string }> {
  const r = await bridge('browserCommand')!({ op: 'open', args: { url, shot } });
  if (!r.ok) throw new Error(r.error || '打开失败');
  const res = (r.result || {}) as { url?: string; title?: string };
  return { url: res.url || url, title: res.title || '' };
}

/** 真清掉内置浏览器的站点数据（只清它自己的 partition，不碰应用登录态）。 */
export async function clearBrowserData(): Promise<{ cleared: boolean }> {
  const r = await bridge('browserCommand')!({ op: 'clear', args: {} });
  if (!r.ok) throw new Error(r.error || '清理失败');
  return { cleared: Boolean((r.result || {}).cleared) };
}

/** 自动截图的可用地址（data URL）。读不到返回空串，由界面退回占位图。
 *  没有后端可拼 URL 了，所以直接把图带回来。 */
export async function browserShotURL(name: string): Promise<string> {
  const r = await bridge('browserShot')!(name).catch(() => null);
  return r?.ok && r.url ? r.url : '';
}
