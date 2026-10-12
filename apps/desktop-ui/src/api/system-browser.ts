/**
 * 「这个 MCP 服务该驱动哪个浏览器」。
 *
 * 背景：Playwright MCP 默认要驱动**自己那份** Chromium，本机没装就得联网下载
 * （全量约 705MB，只 headless shell 也要约 270MB），随应用分发同样要背这个体积。
 * 而用户机器上通常本来就装了 Edge 或 Chrome——直接指给它用，包体一分不涨。
 *
 * 做法：安装这类插件时，把"用哪个浏览器"以**环境变量**写进 MCP 服务配置
 * （主进程会把 env 一起投影进 agent 的 `mcp.json`，见 desktop-node/src/mcp.js）。
 * 用 env 而不是 args，是因为用户还能在弹层里自己填额外参数，args 追加容易撞车，
 * env 则由各自服务自己读、互不干扰。
 *
 * 探测不到就是探测不到：不假装有、也不猜路径，如实给一句说明，让用户知道后果。
 */

interface SystemBrowserBridge {
  browserDetect?: (a?: { force?: boolean }) => Promise<SystemBrowserInfo>;
}

export interface SystemBrowserInfo {
  ok?: boolean;
  /** 首选浏览器（Edge 优先）；一个都没有就是 null */
  browser?: 'msedge' | 'chrome' | null;
  executablePath?: string | null;
  /** 全部命中的（按 Edge→Chrome 排序）；有些服务只认其中一种 */
  available?: { browser: string; executablePath: string }[];
  reason?: string;
}

function bridge<K extends keyof SystemBrowserBridge>(key: K): SystemBrowserBridge[K] {
  const b = (window as unknown as { evawork?: SystemBrowserBridge }).evawork;
  return b && b[key];
}

/** 探测系统浏览器。不在桌面运行环境（没有主进程桥）时返回"探测不到"，不抛。 */
export async function detectSystemBrowser(force = false): Promise<SystemBrowserInfo> {
  const fn = bridge('browserDetect');
  if (!fn) return { ok: false, reason: '当前不是桌面运行环境（缺少主进程桥）', browser: null, available: [] };
  try {
    return (await fn({ force })) || { ok: false, browser: null, available: [] };
  } catch (e) {
    return { ok: false, reason: String((e as Error).message || e), browser: null, available: [] };
  }
}

export interface BrowserPlan {
  /** 最终选用的浏览器；没得用就是 null */
  browser: string | null;
  /** 要写进 MCP 服务配置的环境变量（可能为空对象） */
  env: Record<string, string>;
  /** 给人看的一句说明（可能为空） */
  notice: string;
}

const PLAYWRIGHT = '@playwright/mcp';
const CHROME_DEVTOOLS = 'chrome-devtools-mcp';

/** 去掉 spec 尾部的版本（`@playwright/mcp@0.0.83` → `@playwright/mcp`）。
 *  不带 `@` 的（chrome-devtools-mcp）原样返回——正则要求 @ 后直到结尾无 `/`。 */
function bareSpec(spec: string): string {
  return String(spec || '').trim().replace(/@[^@/]+$/, '');
}

/** 这条 MCP 服务是不是"要驱动真实浏览器"的那类。安装时注入 env 用，
 *  管理面板要给它显示"无头/有头"开关也用——判定只此一处，别处不要各写一遍。 */
export type BrowserKind = 'playwright' | 'chrome-devtools' | null;

export function browserKindOf(spec: string): BrowserKind {
  const s = String(spec || '').trim();
  for (const tok of s.split(/\s+/)) {
    const t = bareSpec(tok);
    if (t === PLAYWRIGHT) return 'playwright';
    if (t === CHROME_DEVTOOLS) return 'chrome-devtools';
  }
  return null;
}

/**
 * 按"选哪个浏览器 + 要不要无头"生成 env。
 * 无头靠**有没有这个键**表达，所以关掉时是删除键、不是写 '0'——
 * 非空字符串照样被当成 true（这是最容易踩空的一处）。
 */
export function browserEnvOf(kind: BrowserKind, browser: string | null, headless: boolean): Record<string, string> {
  if (kind !== 'playwright' || !browser) return {};
  const env: Record<string, string> = { PLAYWRIGHT_MCP_BROWSER: browser };
  if (headless) env.PLAYWRIGHT_MCP_HEADLESS = '1';
  return env;
}

const LABEL: Record<string, string> = { msedge: 'Edge', chrome: 'Chrome' };

/**
 * 按包名给出"用哪个浏览器 + 注入什么 env"。
 *
 * - `@playwright/mcp`：官方支持 `--browser` 及同义 env `PLAYWRIGHT_MCP_BROWSER`
 *   （可取 msedge / chrome / firefox / webkit），headless 用 `PLAYWRIGHT_MCP_HEADLESS`。
 *   默认无头：AI 自动化不该弹一个浏览器窗口抢用户的屏。
 * - `chrome-devtools-mcp`：官方明确"只支持 Google Chrome 与 Chrome for Testing"，
 *   它自己会去找 Chrome，没有可注入的"选浏览器"开关。所以**不注入 env**——
 *   硬塞它不认的参数只会被当成非法参数拒绝；但探测不到 Chrome 时要如实提示。
 */
export async function planBrowserForSpec(spec: string): Promise<BrowserPlan> {
  const kind = browserKindOf(spec);
  if (!kind) return { browser: null, env: {}, notice: '' };

  if (kind === 'playwright') {
    const info = await detectSystemBrowser();
    const b = info.browser || null;
    if (!b) {
      return {
        browser: null,
        env: {},
        notice: '未检测到 Edge/Chrome：Playwright 将改用自带 Chromium，首次启动需联网下载（约 700MB）',
      };
    }
    return {
      browser: b,
      // 安装默认无头：AI 自动化不该弹一个浏览器窗口抢用户的屏；要看过程可在管理面板切有头
      env: browserEnvOf('playwright', b, true),
      notice: `已指定使用系统 ${LABEL[b] || b}（无头），无需下载 Chromium`,
    };
  }

  // kind === 'chrome-devtools'
  const info = await detectSystemBrowser();
  const hasChrome = (info.available || []).some((x) => x.browser === 'chrome');
  return hasChrome
    ? { browser: 'chrome', env: {}, notice: '本机已装 Chrome，Chrome DevTools MCP 会自动找到它' }
    : {
        browser: null,
        env: {},
        notice: 'Chrome DevTools MCP 官方只支持 Google Chrome：本机未检测到 Chrome，它可能起不来浏览器',
      };
}
