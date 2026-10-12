/**
 * 一键 dev（T-003）：拉起 vite dev(1420) + Electron 壳。
 *
 * **不再拉起任何后端**：登录、工作区、设置、文件、目录、MCP 等能力都在主进程里，
 * 智能体是主进程拉起的 agent-ts 子进程。历史上这里还要起一个 HTTP 后端
 * （apps/desktop-api，:18765），那个包已删除。
 *
 * 用法：  pnpm dev
 * 环境变量：EVAWORK_BACKEND_PORT（默认 18765）、EVAWORK_UI_URL（默认 http://127.0.0.1:1420）
 *
 * 注意：Electron 主进程自身会轮询后端 /api/health，因此这里无需等待后端就绪。
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.EVAWORK_BACKEND_PORT || '18765';
const UI_URL = process.env.EVAWORK_UI_URL || 'http://127.0.0.1:1420';
const isWin = process.platform === 'win32';

const procs = [];

/**
 * 解析可执行文件的**绝对路径**，好让下面能用 shell:false 直接拉起。
 *
 * 为什么非要绕这一下：Windows 上 `pnpm` / `python` 多半是 .cmd/.exe 包装，不经 shell
 * 直接 spawn 名字会失败；但一经 cmd.exe 中转，就会**多出一个控制台窗口**（用户看到的就是
 * 那个伴随 evawork 一起弹出的黑框），而 windowsHide 管不到链路上新建的那些。
 */
function resolveBin(name) {
  const r = spawnSync(isWin ? 'where' : 'which', [name], { windowsHide: true });
  const first = String(r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return first || name;
}

function run(name, cmd, args, cwd, env = {}, { shell = isWin, windowsHide = true } = {}) {
  const p = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell,
    /* windowsHide 只该用在**控制台**程序上：它会给子进程设 STARTF_USESHOWWINDOW|SW_HIDE。
       用在 GUI 程序上会把它的窗口一起藏掉——electron 直接 spawn 时踩过一次：
       进程活着、后端也连上了，就是没有窗口（此前经 npm.cmd 中转，标志没传到
       electron.exe，所以一直没暴露）。日志走 inherit，隐藏控制台不影响输出。 */
    windowsHide,
  });
  p.on('exit', (code) => console.log(`[dev] ${name} exited(${code})`));
  p.on('error', (err) => console.error(`[dev] ${name} failed:`, err.message));
  procs.push(p);
  return p;
}

// 三处都**不经 shell**：控制台窗口是 cmd.exe 中转带来的，绕开它就没有多余的黑框
const uiDir = path.join(root, 'apps', 'desktop-ui');

/* 后端不再由本脚本拉起。
   登录/令牌、工作区、本机开关、内置浏览器、崩溃上报都已迁到主进程，
   主进程自己已经不依赖 18765 了。dev 与打包态行为对齐：都不再起后端。
   （`BACKEND` 地址仍会注入渲染层——渲染层那批尚未迁移的数据接口还在用它，
     没后端时它们会各自报错，这正是待办清单。） */
console.log(`[dev] ui       -> ${UI_URL}`);
// 直接 `node vite/bin/vite.js`（等价于 desktop-ui 的 dev 脚本 `vite`），
// 不走 `pnpm -F ... dev`——pnpm 是 .cmd，不经 cmd.exe 起不来。
run(
  'ui',
  process.execPath,
  [path.join(uiDir, 'node_modules', 'vite', 'bin', 'vite.js')],
  uiDir,
  {},
  { shell: false },
);

/**
 * Electron 起早了只会白屏（ERR_CONNECTION_REFUSED 后不再重试）。
 * vite 冷启动要重优化依赖，偶尔 3s+，所以这里真正等到 1420 能应答再拉壳。
 */
async function waitHttp(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const uiReady = await waitHttp(`${UI_URL}/`);
console.log(`[dev] ui ready: ${uiReady}`);

console.log(`[dev] electron -> loading ${UI_URL}`);
/* 不经 `npm start`：npm.cmd 经 cmd.exe 再经 electron 的 node 包装层层层拉起，
   每一层都可能新建控制台——用户会看到一个空的 "npm start" 黑窗挂在任务栏。
   electron.exe 本身是 GUI 子系统程序，直接 spawn（shell:false）就没有控制台。 */
const electronExe = path.join(root, 'apps', 'desktop-node', 'node_modules', 'electron', 'dist', 'electron.exe');
run(
  'electron',
  electronExe,
  ['.'],
  path.join(root, 'apps', 'desktop-node'),
  {
    EVAWORK_UI_URL: UI_URL,
    EVAWORK_BACKEND_PORT: PORT,
    // 告诉主进程：后端已由本脚本拉起，别再自己起一个（否则同端口双绑、请求被随机分发）
    EVAWORK_BACKEND_EXTERNAL: '1',
    // 不挂到 dev 的控制台上：否则会把那个控制台顶到前台（就是之前那个黑框）
    ELECTRON_NO_ATTACH_CONSOLE: '1',
  },
  { shell: false, windowsHide: false },
);

function shutdown() {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
