/**
 * 探测系统里已安装的 Chromium 系浏览器（Edge / Chrome）。
 *
 * 为什么需要它：Playwright MCP 默认驱动**自己那份** Chromium——本机没装就得联网下
 * （全量约 705MB、只 headless shell 也要 270MB），随包分发同理。而主流机器上本来就
 * 装了 Edge 或 Chrome，让 MCP 直接驱动它们，安装包就不用带浏览器内核（0 体积）。
 *
 * 两个实测坑，代码里都绕开了：
 *  1. **注册表会骗人**。本机 `HKLM\...\App Paths\msedge.exe` 还在，指向的 exe
 *     却已被删除（Edge 卸载留了残留项）。只信注册表就会把不存在的路径交给
 *     Playwright，要到启动阶段才报 "Executable doesn't exist"，很难查。
 *     所以注册表拿到的路径**必须再校验一次文件存在**。
 *  2. **不能只找 Edge**。同一台机器上 Edge 缺失、Chrome 存在是真实存在的组合，
 *     所以两个都探，`available` 全量返回，由调用方按各自支持面决定用哪个
 *     （例如 chrome-devtools-mcp 官方只认 Chrome，Edge 帮不上它）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

/** `App Paths` 注册表项：装没装、装在哪，问它比猜路径准（含用户级安装 HKCU）。 */
const APP_PATHS = '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\';
const REG_KEYS = {
  msedge: [`HKLM${APP_PATHS}msedge.exe`, `HKCU${APP_PATHS}msedge.exe`],
  chrome: [`HKLM${APP_PATHS}chrome.exe`, `HKCU${APP_PATHS}chrome.exe`],
};

/** 注册表默认值的取法：`reg query <key> /ve` 输出的第二行形如
 *  `    (Default)    REG_SZ    C:\...\msedge.exe`（中文系统显示"（默认）"，
 *  所以按 `REG_SZ` 切，不按 "(Default)" 匹配）。 */
function regDefault(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/ve'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      if (err) return resolve('');
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const i = line.indexOf('REG_SZ');
        if (i >= 0) {
          const v = line.slice(i + 'REG_SZ'.length).trim().replace(/^"|"$/g, '');
          if (v) return resolve(v);
        }
      }
      resolve('');
    });
  });
}

/** 常见安装路径（注册表查不到时的兜底，也用于非 Windows）。 */
function candidates(name) {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'win32') {
    return name === 'msedge'
      ? [
          path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ]
      : [
          path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ];
  }
  if (process.platform === 'darwin') {
    const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
    return name === 'msedge'
      ? roots.map((d) => path.join(d, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'))
      : roots.map((d) => path.join(d, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
  }
  return name === 'msedge'
    ? ['/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge', '/opt/microsoft/msedge/msedge']
    : ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium'];
}

function firstExisting(files) {
  for (const f of files) {
    try {
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    } catch {
      /* 权限/损坏的路径当不存在 */
    }
  }
  return null;
}

async function findOne(name) {
  if (process.platform === 'win32') {
    for (const key of REG_KEYS[name] || []) {
      const v = await regDefault(key);
      const hit = v ? firstExisting([v]) : null;
      if (hit) return hit;
    }
  }
  return firstExisting(candidates(name));
}

let cache = null;

/**
 * 探测结果：`browser` 是**首选**（Edge 优先，因为 Windows 自带率高），
 * `available` 是全部命中的（按 Edge→Chrome 排序），调用方按需挑选。
 * 结果进程内缓存；`force=true` 重探（用户刚装完浏览器时用）。
 */
async function detectSystemBrowser(force = false) {
  if (cache && !force) return cache;
  const available = [];
  for (const name of ['msedge', 'chrome']) {
    const executablePath = await findOne(name);
    if (executablePath) available.push({ browser: name, executablePath });
  }
  cache = {
    ok: true,
    platform: process.platform,
    browser: available.length ? available[0].browser : null,
    executablePath: available.length ? available[0].executablePath : null,
    available,
  };
  return cache;
}

module.exports = { detectSystemBrowser };
