/**
 * 插件（MCP）端到端测试。
 *
 * 测的是**整条链**，不是某个函数：
 *   界面新增服务 → 主进程存储 → 投影进 agent-ts 真正读的 mcp.json
 *   → 真 spawn 一次 JSON-RPC 握手拿到工具 → 禁用/启用 → 卸载
 *   → 最后让 agent-ts 自己加载同一份配置，确认**它真的能用到这些工具**
 *
 * 最后一步是重点：前面全绿但智能体用不了，是最容易静默发生的一类故障
 * （"界面里装好了、AI 看不见"）。Windows 上 `npx` 是 .cmd 垫片、裸 spawn 直接
 * ENOENT 那次就是这个盲区——本机没有任何测试覆盖它。
 *
 * 用法：
 *   pnpm test:plugins          # 需要能访问 npm（要真拉一个 MCP 包）
 *
 * 退出码：0 全通过；1 有失败；2 环境不满足（没网 / 拉不到包）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Windows 上 `new URL(...).pathname` 会给出 `/D:/...`，拼出 `D:\D:\...`；必须走 fileURLToPath
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = '@modelcontextprotocol/server-memory';

/* 全程用**临时 home**：测试不能碰用户真实的 ~/.evawork/ts-agent，
   否则跑一次就往人家配置里塞一条服务。 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-e2e-plugins-'));
process.env.EVA_TS_HOME = home;

const storeMod = (await import(pathToFileURL(path.join(REPO, 'apps/desktop-node/src/store.js')).href)).default;
storeMod.init(path.join(home, 'store'));
const mcp = (await import(pathToFileURL(path.join(REPO, 'apps/desktop-node/src/mcp.js')).href)).default;
const spawnMod = await import(pathToFileURL(path.join(REPO, 'apps/agent-ts/src/spawn.ts')).href);

const agentCfg = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'mcp.json'), 'utf8')).servers || [];
  } catch {
    return [];
  }
};

let failed = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

console.log(`临时 home: ${home}`);
console.log(`测试包: ${PKG}\n`);

// ---- 1. 新增一个 npx 型 MCP 服务 ----
const created = mcp.create({
  name: 'Memory',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', PKG],
  enabled: true,
});
check('新增服务', created.ok, created.reason || created.item?.id);
const id = created.item?.id;

// ---- 2. 投影：智能体读的那份配置里必须有它 ----
const afterCreate = agentCfg();
check('投影进 mcp.json', afterCreate.some((s) => s.name === 'Memory'), JSON.stringify(afterCreate.map((s) => s.name)));

// ---- 2.5 npx 配置必须解析到本地已分发包（不再去 npm 下载）----
const rc = spawnMod.resolveCommand('npx', ['-y', PKG]);
check(
  'npx 配置解析到本地分发包',
  /mcp-bundle[\\/]node_modules/.test(rc.file) || /mcp-bundle[\\/]/.test(rc.argv[0] || ''),
  rc.file,
);

// ---- 2.6 模拟主进程环境：本地分发的包也必须真能"发现工具" ----
/* 守的是"拿 electron.exe 当 node 去跑 JS 入口"那个坑：进程**立刻退出（code=0）且一句协议
   都不回**，界面显示"没有发现工具"，可工具其实一个都不缺。触发条件就是主进程的
   `process.execPath` 是 electron.exe——而本地分发的包**全走这条路径**，一挂就是整片插件一起挂，
   还看着像"已经装上了"。这里把 execPath 临时换成真的 electron.exe 复现该条件。
   位置刻意放在其它握手之前：运行时选择有缓存，第一次算出是哪份 node 就定下来了。
   用已分发的包跑，不依赖 npm 下载。 */
const BUNDLE = path.join(REPO, 'apps', 'mcp-bundle', 'node_modules');
const LOCAL_PKG = '@playwright/mcp';
const ELECTRON_EXE = path.join(REPO, 'apps', 'desktop-node', 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(path.join(BUNDLE, LOCAL_PKG))) {
  console.log(`SKIP  本地分发包握手 — 未分发 ${LOCAL_PKG}（先跑 pnpm install）`);
} else {
  const sim = fs.existsSync(ELECTRON_EXE);
  const realExec = process.execPath;
  const realElectron = process.versions.electron;
  if (sim) {
    process.versions.electron = '31.7.7';
    process.execPath = ELECTRON_EXE;
  }
  const local = mcp.create({
    name: 'LocalBundle',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', LOCAL_PKG],
    enabled: true,
  });
  const localTools = await mcp.tools(local.item?.id, true);
  if (sim) {
    process.execPath = realExec;
    process.versions.electron = realElectron;
  }
  check(
    `本地分发包握手拿到工具${sim ? '（execPath 模拟成 electron.exe）' : ''}`,
    localTools.ok && (localTools.tools || []).length > 0,
    localTools.ok ? `${(localTools.tools || []).length} 个工具` : localTools.error,
  );
  mcp.remove(local.item?.id);
}

// ---- 3. 真握手（会真去 npm 拉包）----
const toolsRes = await mcp.tools(id, true);
if (!toolsRes.ok) {
  console.error(`\n环境不满足：握手失败 — ${toolsRes.error || ''}`);
  console.error('（本测试需要能访问 npm；离线环境请联网后重跑）');
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(2);
}
check('真握手拿到工具', (toolsRes.tools || []).length > 0, `${(toolsRes.tools || []).length} 个工具`);

// ---- 4. 禁用：界面还能看见，但不能进 agent 配置 ----
mcp.patch(id, { enabled: false });
check('禁用后不进 agent 配置', !agentCfg().some((s) => s.name === 'Memory'));
check('禁用后界面仍列得出', mcp.list().items.some((s) => s.id === id));

// ---- 5. 启用：回到 agent 配置 ----
mcp.patch(id, { enabled: true });
check('启用后回到 agent 配置', agentCfg().some((s) => s.name === 'Memory'));

// ---- 6. agent-ts 自己加载这份配置（最关键的一环）----
const agentMod = await import(pathToFileURL(path.join(REPO, 'apps/agent-ts/src/tools.ts')).href);
// 测试里给足预算：默认是 10s（为了不拖慢智能体就绪），这里要的是**确定性**不是快
const installed = await agentMod.installMcpTools(undefined, 60_000);
const names = (agentMod.allTools() || []).map((t) => t.name);
const memTools = names.filter((n) => n.startsWith('mcp__Memory__'));
check(
  'agent-ts 真的注册了它的工具',
  memTools.length > 0,
  `共安装 ${installed} 个工具，其中 ${memTools.length} 个来自 Memory：${memTools.slice(0, 3).join(', ')}`,
);

// ---- 7. 卸载：两边都干净 ----
mcp.remove(id);
check('卸载后不在 agent 配置', !agentCfg().some((s) => s.name === 'Memory'));
check('卸载后不在 store', !mcp.list().items.some((s) => s.id === id));

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
