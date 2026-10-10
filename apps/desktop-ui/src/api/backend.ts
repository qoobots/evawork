/**
 * 渲染层 ↔ Python 后端的对接接缝（在 Electron 下生效，纯 web 预览时静默兜底）。
 *
 * 约定：
 *   - 后端地址由 Electron 主进程经 preload 注入到 window.evawork
 *   - 无后端时（vite 直接预览）所有调用抛错，调用方应回退到 data/mock
 *
 * 接入真实功能时，只需在本文件或各 view 里用 getJSON('/api/...') 取代 mock 数据。
 */

type BackendListener = (url: string) => void;

export interface ShortcutMessage {
  /** S-20：`voice` = 语音输入快捷键（Alt+V），渲染层据此开关录音 */
  action: 'new-task' | 'mode' | 'voice';
  payload?: 'work' | 'code' | 'design';
}
type ShortcutListener = (msg: ShortcutMessage) => void;

/** T-119：主进程「检查更新」的结果契约（preload 的 checkUpdates ↔ evawork:check-updates）。 */
export interface UpdateCheck {
  status: 'latest' | 'available' | 'unsupported' | 'error';
  /** status=available 时的新版本号 */
  version?: string;
  /** unsupported / error 时给人看的原因 */
  message?: string;
}

interface EvaworkGlobal {
  evawork?: {
    getBackendURL: () => string;
    onBackend: (cb: BackendListener) => void;
    onShortcut?: (cb: ShortcutListener) => void;
    checkUpdates?: () => Promise<UpdateCheck>;
    /** T-120：窗口栏颜色上报（主进程 setTitleBarOverlay） */
    setTitleBarTheme?: (theme: { color: string; symbolColor: string }) => void;
    /** S-04：保持电脑唤醒（主进程 powerSaveBlocker） */
    setKeepAwake?: (on: boolean) => void;
    /** S-20：语音转录快捷键（Alt+V）立即注册/注销（主进程 globalShortcut） */
    setVoiceHot?: (on: boolean) => void;
    /** S-15：真实版本号（app.getVersion()） */
    appInfo?: () => Promise<{ version: string; packaged: boolean }>;
    /** T-120：主进程是否启用了自定义标题栏（Windows/Linux） */
    customTitleBar?: boolean;
    /** 对话附件：系统多选文件框（取消返回 []） */
    pickFiles?: () => Promise<string[]>;
    /** 对话附件：唤起框选截图工具，返回临时 PNG 的绝对路径；用户取消返回空字符串。
        hideWindow：截图前是否先隐藏应用窗口 */
    captureScreen?: (hideWindow?: boolean) => Promise<string>;
    /** TS-011：第二套智能体（TS）——调用走 invoke，流式事件走 tsAgent.on */
    tsAgent?: {
      status: () => Promise<TsAgentStatus>;
      start: (opts?: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>;
      prompt: (args: { sessionId?: string; prompt: string; workspace?: string; policy?: string; model?: string }) => Promise<{ ok: boolean; reason?: string; sessionId?: string }>;
      answer: (args: { requestId: string; granted: boolean }) => Promise<{ answered: boolean }>;
      cancel: (args: { sessionId: string }) => Promise<{ ok: boolean; reason?: string }>;
      stop: () => Promise<{ ok: boolean }>;
      replay: (args: { sessionId: string }) => Promise<{ ok: boolean; reason?: string; events?: unknown[] }>;
      checkpoints: (args: { sessionId: string }) => Promise<{ ok: boolean; reason?: string; available?: boolean; checkpoints?: unknown[] }>;
      contextUsage: (args: { sessionId: string }) => Promise<{ ok: boolean; reason?: string; usage?: unknown }>;
      undoCheckpoint: (args: { sessionId: string; checkpointId: string }) => Promise<{ ok: boolean; reason?: string; restored?: string[]; skipped?: unknown[] }>;
      rewind: (args: { sessionId: string; toTurn: number }) => Promise<{ ok: boolean; reason?: string; rewoundTo?: number }>;
      isolate: (args: { method: string; sessionId?: string; name?: string }) => Promise<{ ok: boolean; reason?: string }>;
      on: (cb: (payload: TsAgentPayload) => void) => () => void;
    };
    /** TS-052：智能体二选一（py / ts），主进程持久化 */
    agentChoice?: {
      get: () => Promise<{ agent: 'py' | 'ts'; running: boolean }>;
      set: (agent: string) => Promise<{ agent: 'py' | 'ts'; running: boolean }>;
    };
  };
}

/** TS-011/052：TS 智能体的状态与事件形状（与 preload.js、tsAgent.js 同源）。 */
export interface TsAgentStatus {
  running: boolean;
  ready: boolean;
  reason?: string;
  workspace?: string;
  policy?: string;
}

export interface TsAgentPayload {
  kind: 'ready' | 'event' | 'status' | 'text' | 'usage' | 'exit';
  sessionId?: string;
  event?: unknown;
  /** 流式正文片段（不落会话日志，只在界面上"打字"） */
  text?: string;
  /** TS-065：上下文用量（派生值，不落盘）。形状见 tasks.ts 的 `ContextUsage`。 */
  usage?: unknown;
  requestId?: string;
  tool?: string;
  action?: string;
  args?: unknown;
  reason?: string;
  status?: string;
  error?: string;
}

function g(): EvaworkGlobal {
  return window as unknown as EvaworkGlobal;
}

/**
 * 后端地址优先级：
 *   1. Electron 主进程经 preload 注入的 window.evawork
 *   2. 开发环境变量 VITE_BACKEND_URL（无 Electron 时也能直连后端联调）
 */
/* 后端地址仍会注入（主进程 did-finish-load 时发），但它**只说明地址是什么**，
   不再说明"后端在跑"——后端已经不拉起了。它现在的作用只有一个：
   `onBackend` 是渲染层拿到注入后的就绪信号，各处拿它当加载触发点。 */
export function backendURL(): string {
  return g().evawork?.getBackendURL?.() || (import.meta.env.VITE_BACKEND_URL as string) || '';
}

/**
 * **这些接口还能不能调**——判据是**主进程桥在不在**，不是后端地址在不在。
 *
 * 以前各处用 `backendAvailable()`（地址非空即"在线"）。后端不拉起之后它要么恒真
 * （打包态地址照旧注入，于是界面显示"在线"，其实数据全来自本地桥——名不副实），
 * 要么恒假（哪天不再注入地址，整片界面直接变离线，哪怕本地能力全都好好的）。
 * 现在所有数据接口都走主进程桥，前置条件就是桥在不在：有桥就能用，没桥就是
 * 纯 vite 预览，那时候这些功能确实一个都跑不了。
 */
export function bridgeAvailable(): boolean {
  return Boolean(g().evawork);
}

export function onBackend(cb: BackendListener): void {
  g().evawork?.onBackend?.(cb);
}

/**
 * T-119：触发一次更新检查（设置→关于）。
 * 没有 Electron 桥（纯 vite 预览）时也返回一个真结果，界面照样把话说清楚——
 * 不能变成"点了没反应"。
 */
/**
 * T-120：把窗口栏颜色告诉主进程（系统画的三个窗口按钮得跟内容一个色）。
 * 无 Electron 桥时是空操作——纯 web 预览里根本没有窗口栏。
 */
export function setTitleBarTheme(theme: { color: string; symbolColor: string }): void {
  g().evawork?.setTitleBarTheme?.(theme);
}

/**
 * S-15：关于页的版本号。
 * 主进程 `app.getVersion()` 是唯一真相源；纯 web 预览拿不到就返回空串，
 * 由界面显示"不可用"——写死一个版本号比不显示更有害（排障时报出来的号是假的）。
 */
export async function fetchAppVersion(): Promise<{ version: string; packaged: boolean }> {
  const fn = g().evawork?.appInfo;
  if (!fn) return { version: '', packaged: false };
  try {
    const r = await fn();
    return { version: r?.version || '', packaged: !!r?.packaged };
  } catch {
    return { version: '', packaged: false };
  }
}

/**
 * S-04：把「保持电脑唤醒」立即交给主进程（powerSaveBlocker）。
 * 无 Electron 桥（纯 vite 预览）时是空操作——浏览器里没有"阻止系统休眠"这回事。
 */
export function setKeepAwake(on: boolean): void {
  g().evawork?.setKeepAwake?.(on);
}

/**
 * S-20：把「语音转录快捷键」立刻交给主进程（注册/注销 Alt+V）。
 * 无 Electron 桥（纯 vite 预览）时是空操作——浏览器里注册不了全局快捷键。
 */
export function setVoiceHot(on: boolean): void {
  g().evawork?.setVoiceHot?.(on);
}

/**
 * T-120：是否需要给自定义标题栏留出顶部拖拽带。
 * 无桥（纯 web 预览 / 测试）时按"需要"处理，跟打包态对齐；macOS 主进程不开自定义标题栏。
 */
export function hasCustomTitleBar(): boolean {
  return g().evawork?.customTitleBar ?? true;
}

export async function checkUpdates(): Promise<UpdateCheck> {
  const fn = g().evawork?.checkUpdates;
  if (!fn) return { status: 'unsupported', message: '当前环境不支持自动更新（仅桌面安装版）' };
  try {
    return await fn();
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** 接住主进程全局快捷键（T-055）：新建任务。 */
export function onShortcut(cb: ShortcutListener): void {
  g().evawork?.onShortcut?.(cb);
}

export async function getJSON<T = unknown>(path: string): Promise<T> {
  const base = backendURL();
  if (!base) throw new Error('no-backend');
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`backend ${res.status}`);
  return (await res.json()) as T;
}
