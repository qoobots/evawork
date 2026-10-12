/**
 * MCP 服务管理：真相源是 **agent-ts 自己的 `mcp.json`**，不是另起一份配置。
 *
 * 这一点是刻意的：agent-ts 的 `loadMcpConfig()` 只读 `~/.evawork/ts-agent/mcp.json`
 * （可被 EVA_TS_HOME 覆盖）。如果界面把服务存到别处，用户在界面里加了一个 MCP
 * 服务、智能体却根本看不到它——那比直接报错更糟，是个"看着配好了其实没生效"的坑。
 *
 * 所以这里的写操作做两件事：
 *   1. 完整列表（含禁用项）存在主进程 store，供界面列举；
 *   2. 把**启用中**的项投影回 mcp.json —— 这才是智能体真正读的东西。
 * 禁用之所以要"投影"而不是加个 enabled 字段：agent-ts 的过滤只看 name+command，
 * 不认识 enabled，留在文件里就等于照样启用。
 *
 * 首次使用会把 mcp.json 里已有的服务导入 store，用户手改过的配置不会丢。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const store = require('./store');
// 复用 agent-ts 那套"找真 Node"的策略（TS-054），见 nodeRuntime()
const { findNode } = require('./tsAgentCore');

const COLLECTION = 'mcp-servers';
let imported = false;

/** 与 agent-ts 的 homeDir() 保持一致（含 EVA_TS_HOME 覆盖）。 */
function agentHome() {
  const env = (process.env.EVA_TS_HOME || '').trim();
  return env || path.join(os.homedir(), '.evawork', 'ts-agent');
}

function mcpFile() {
  return path.join(agentHome(), 'mcp.json');
}

/** 读 agent 侧配置（它认的字段只有 name/command/args/env）。 */
function readAgentConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(mcpFile(), 'utf8'));
    return Array.isArray(raw && raw.servers) ? raw.servers : [];
  } catch {
    return [];
  }
}

/** 把启用中的服务投影进 mcp.json。禁用的不写——写了 agent 照样会加载。 */
function syncToAgent() {
  const items = store.list(COLLECTION).items || [];
  const servers = items
    .filter((s) => s && s.enabled !== false && String(s.command || '').trim())
    .map((s) => {
      const out = { name: String(s.name || '').trim(), command: String(s.command || '').trim() };
      if (Array.isArray(s.args) && s.args.length) out.args = s.args.map((x) => String(x));
      if (s.env && typeof s.env === 'object' && Object.keys(s.env).length) out.env = s.env;
      return out;
    });
  const dir = path.dirname(mcpFile());
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(mcpFile(), JSON.stringify({ servers }, null, 2));
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
  return { ok: true, written: servers.length };
}

/** 首次使用时把已有 mcp.json 的服务导入，避免覆盖用户手改过的配置。 */
function ensureImported() {
  if (imported) return;
  imported = true;
  if ((store.list(COLLECTION).items || []).length) return;
  const existing = readAgentConfig();
  if (!existing.length) return;
  existing.forEach((s) => {
    store.put(COLLECTION, {
      id: '',
      name: String((s && s.name) || '').trim(),
      command: String((s && s.command) || '').trim(),
      args: Array.isArray(s && s.args) ? s.args : [],
      env: s && s.env && typeof s.env === 'object' ? s.env : {},
      transport: 'stdio',
      source: 'imported',
      enabled: true,
      created_at: Math.floor(Date.now() / 1000),
    });
  });
}

function list() {
  ensureImported();
  const items = store.list(COLLECTION).items || [];
  /* 标出"存着但智能体用不了"的情况：agent-ts 只会 spawn stdio，
     http/sse 目前没有消费方。不说就是个静默的坑。 */
  const out = items.map((s) => ({
    ...s,
    note:
      s.enabled !== false && !String(s.command || '').trim()
        ? '非 stdio 传输：当前智能体只会拉起本地命令，这项不会被加载'
        : '',
  }));
  return { ok: true, items: out };
}

function create(p) {
  ensureImported();
  const body = p || {};
  const name = String(body.name || '').trim();
  if (!name) throw new Error('名称必填');
  const transport = String(body.transport || 'stdio') || 'stdio';
  if (transport === 'stdio' && !String(body.command || '').trim()) throw new Error('stdio 传输必须填命令');
  if (transport !== 'stdio' && !String(body.url || '').trim()) throw new Error('非 stdio 传输必须填地址');
  const r = store.put(COLLECTION, {
    id: '',
    name,
    transport,
    command: String(body.command || '').trim(),
    args: Array.isArray(body.args) ? body.args.map((x) => String(x)) : [],
    url: String(body.url || '').trim(),
    headers: body.headers && typeof body.headers === 'object' ? body.headers : {},
    env: body.env && typeof body.env === 'object' ? body.env : {},
    source: String(body.source || 'user').trim() || 'user',
    enabled: body.enabled !== false,
    created_at: Math.floor(Date.now() / 1000),
  });
  const sync = syncToAgent();
  if (!sync.ok) return sync;
  return { ok: true, item: r.item };
}

function patch(id, p) {
  ensureImported();
  const cur = store.get(COLLECTION, String(id || ''));
  if (!cur.item) throw new Error('服务不存在');
  const body = p || {};
  const next = { ...cur.item };
  for (const k of ['name', 'command', 'url', 'transport', 'source']) {
    if (body[k] !== undefined) next[k] = String(body[k] || '').trim();
  }
  if (Array.isArray(body.args)) next.args = body.args.map((x) => String(x));
  if (body.headers !== undefined) next.headers = body.headers || {};
  if (body.env !== undefined) next.env = body.env || {};
  if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
  const r = store.put(COLLECTION, next);
  const sync = syncToAgent();
  if (!sync.ok) return sync;
  return { ok: true, item: r.item };
}

function remove(id) {
  ensureImported();
  const r = store.remove(COLLECTION, String(id || ''));
  if (!r.ok) return r;
  const sync = syncToAgent();
  if (!sync.ok) return sync;
  return { ok: true, deleted: String(id || '') };
}

/**
 * 工具发现：真去握手一次。stdio 服务由主进程 spawn 走 JSON-RPC initialize/tools/list，
 * 而不是猜它会提供什么工具——猜出来的工具列表点下去必然失败。
 * 失败带成句原因（命令不存在 / 超时 / 握手失败），不返回空列表假装成功。
 */
async function tools(id, refresh = false) {
  ensureImported();
  const cur = store.get(COLLECTION, String(id || ''));
  const s = cur.item;
  if (!s) throw new Error('服务不存在');
  if (String(s.transport || 'stdio') !== 'stdio') {
    return { ok: false, tools: [], error: '当前只有 stdio 传输会真握手，http/sse 未接入' };
  }
  const command = String(s.command || '').trim();
  if (!command) return { ok: false, tools: [], error: '缺少命令' };
  const cached = refresh ? null : s.tools || null;
  if (cached && Array.isArray(cached) && cached.length) return { ok: true, tools: cached };
  try {
    const found = await handshake(command, s.args || [], s.env || {});
    store.put(COLLECTION, { ...s, tools: found, tools_at: Math.floor(Date.now() / 1000) });
    return { ok: true, tools: found };
  } catch (e) {
    return { ok: false, tools: [], error: String((e && e.message) || e) };
  }
}

/* 本地已分发的 MCP 服务在哪（见 agent-ts/src/spawn.ts，两边必须一致）。
   优先 EVA_MCP_BUNDLE 显式指定；打包态用 process.resourcesPath；
   开发态用 materialize 的**实体化产物**（.mcp-bundle，与打包同构）——
   不能用 apps/mcp-bundle/node_modules：那是 pnpm 符号链接布局，顶层只有
   @evawork/* 薄包，第三方包全在 .pnpm 里，按包名找不到（详见 spawn.ts）。 */
function mcpBundleNodeModules() {
  const explicit = process.env.EVA_MCP_BUNDLE;
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'mcp-bundle', 'node_modules');
    if (fs.existsSync(p)) return p;
  }
  const dev = path.resolve(__dirname, '..', '.mcp-bundle', 'node_modules');
  if (fs.existsSync(dev)) return dev;
  return path.resolve(__dirname, '..', '..', 'mcp-bundle', 'node_modules');
}

/**
 * 跑本地分发的 MCP 入口该用哪个 node（返回 `{ file, env }`）。
 *
 * **不能直接用 `process.execPath`**：在 Electron 主进程里它是 `electron.exe`。拿它去跑一个
 * JS 入口，Electron 会当成"启动一个应用"，进程**立刻退出（code=0）且一句协议都不回**——
 * 表现就是界面里"没有发现工具 / 进程退出（code=0），握手未完成"这种"看着装上了其实没装上"
 * 的假结果。本地分发的包全走这条路径，所以是**整片插件一起不可用**，不是某一个包的问题。
 * （TS-054 拉起 agent-ts 时踩过同一个坑，那边的解法就是 findNode()，这里复用同一套策略，
 * 顺带保证界面与智能体用同一个运行时。）
 *
 * 顺序：真 Node（EVA_TS_NODE / PATH）→ 都没有才退回 `electron.exe + ELECTRON_RUN_AS_NODE=1`，
 * 让它以纯 Node 模式跑。退回那份是 Electron 自带的 Node 20，个别包（如 chrome-devtools-mcp
 * 要求 20.19+）可能仍起不来——但失败原因会照常成句带出去，不假装成功。
 */
let runtimeCache = null;
function nodeRuntime() {
  if (runtimeCache) return runtimeCache;
  if (!process.versions.electron) {
    // 纯 Node 下（脚本 / 测试）execPath 就是 node 本身，原样用
    runtimeCache = { file: process.execPath, env: {} };
    return runtimeCache;
  }
  const node = findNode();
  runtimeCache = node.bin
    ? { file: node.bin, env: {} }
    : { file: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  return runtimeCache;
}

/** 把 `npx -y <pkg>` 解析成本地已分发包的入口；不是这种形态或本地没有就返回 null。 */
function tryLocalNpx(argv) {
  let i = 0;
  if (argv[0] === '-y' || argv[0] === '--yes') i += 1;
  else return null;
  const pkg = argv[i];
  if (!pkg) return null;
  if (argv[i + 1] === '-c' || argv[i + 1] === '--call') return null;
  const rest = argv.slice(i + 1);
  const pkgDir = path.join(mcpBundleNodeModules(), pkg);
  if (!fs.existsSync(pkgDir)) return null;
  const bin = resolvePkgBin(pkgDir, pkg);
  if (!bin) return null;
  // 用真 Node 跑，不能拿 electron.exe 顶（见 nodeRuntime）
  const rt = nodeRuntime();
  return { file: rt.file, argv: [bin, ...rest], env: rt.env };
}

function resolvePkgBin(pkgDir, pkg) {
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const pick = (bin) => {
    if (typeof bin === 'string') return bin;
    if (bin && typeof bin === 'object') {
      const scope = pkg.startsWith('@') ? pkg.split('/')[1] : pkg;
      return bin[scope] || Object.values(bin)[0];
    }
    return undefined;
  };
  for (const b of [pick(meta.bin), meta.main]) {
    if (typeof b === 'string') {
      const abs = path.join(pkgDir, b);
      if (fs.existsSync(abs)) return abs;
    }
  }
  return null;
}

/* Windows 命令解析。**必须与 agent-ts/src/spawn.ts 的 resolveCommand 同行为**：
   界面"发现工具"用这里，智能体真正跑用那边；两边解析不一致就会出现
   "界面列得出工具、智能体却起不来"（或反过来）——那是最难查的一类不一致。
   主进程是 CommonJS 没法 import .ts，所以在这里复述一份，改一处要同步改另一处。

   唯一的**刻意**差异是"用哪个 node 跑"：agent-ts 是被真 Node 拉起来的（TS-054），它的
   `process.execPath` 本来就是 node；主进程的 `process.execPath` 是 electron.exe，必须换掉
   （见 nodeRuntime）。"解析到哪个入口"的部分仍要严格一致。 */
function resolveCommand(cmd, args) {
  const command = String(cmd || '').trim();
  const argv = (args || []).map(String);

  // 本地已分发的 MCP 服务：npx -y <pkg> 直接跑 node_modules 里的本地副本，免去下载。
  // 与 agent-ts 同行为：界面"发现工具"也用本地副本，避免两边解析不一致。
  if (command === 'npx') {
    const local = tryLocalNpx(argv);
    if (local) return local;
  }

  if (process.platform !== 'win32') return { file: command, argv };

  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const hit = (base) => {
    try {
      return fs.existsSync(base) && !fs.statSync(base).isDirectory();
    } catch {
      return false;
    }
  };
  let found = '';
  // 先按 PATHEXT 找：无扩展名的同名文件（npm 放的 npx）在 Windows 上跑不起来，
  // 被它先命中就是 ENOENT。真正入口是 npx.cmd / npx.exe。
  const scan = (base) => {
    for (const e of exts) if (hit(base + e)) return base + e;
    return path.extname(base) && hit(base) ? base : '';
  };
  if (command.includes('/') || command.includes('\\')) {
    found = scan(command);
  } else {
    for (const d of dirs) {
      found = scan(path.join(d, command));
      if (found) break;
    }
  }
  // 1) 能直接跑的（非批处理）→ 原样
  if (found && !/\.(cmd|bat)$/i.test(found)) return { file: found, argv };

  // 2) node 系垫片（npx/npm）→ `node <npm>/bin/xxx-cli.js`，不经 shell
  const stem = path.basename(command).toLowerCase().replace(/\.(cmd|bat|exe)$/i, '');
  const cli = stem === 'npx' ? 'npx-cli.js' : stem === 'npm' ? 'npm-cli.js' : '';
  if (cli) {
    const entry = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', cli);
    if (hit(entry)) return { file: process.execPath, argv: [entry].concat(argv) };
  }

  // 3) 确实是 .cmd/.bat → 交给 cmd，命令行自己加引号
  const q = (s) => (/[\s"^&|<>();,]/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));
  const line = [q(found || command)].concat(argv.map(q)).join(' ');
  return { file: 'cmd.exe', argv: ['/d', '/s', '/c', line] };
}

/** 与 agent-ts/mcp.ts 同一套握手：spawn → initialize → tools/list。 */
function handshake(command, args, env) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    let proc;
    try {
      const r = resolveCommand(command, args);
      proc = spawn(r.file, r.argv, {
        // r.env 是运行时自己的开关（ELECTRON_RUN_AS_NODE），放最后合：
        // 服务配置里的同名键不该把它打翻，否则又是一次"看着装上了其实没装上"
        env: { ...process.env, ...(env || {}), ...(r.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(new Error(`起不了这个命令：${String((e && e.message) || e)}`));
      return;
    }
    let buf = '';
    let done = false;
    // `npx -y` 类服务冷启动要先从 npm 下载包（本机实测单个就要几十秒），
    // 15s 必然超时。放宽到 90s：首次冷启能撑住，进缓存后秒级完成。
    const timer = setTimeout(() => finish(new Error('握手超时（90s）')), 90000);
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc.kill();
      } catch {
        /* 已经退了 */
      }
      if (err) reject(err);
      else resolve(val);
    };

    proc.stdout.on('data', (d) => {
      buf += d.toString();
      // 取出所有完整的一行 JSON-RPC 帧
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) {
            finish(new Error(`tools/list 失败：${msg.error.message || JSON.stringify(msg.error)}`));
            return;
          }
          const list0 = (msg.result && msg.result.tools) || [];
          finish(null, list0.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema })));
          return;
        }
      }
    });
    proc.on('error', (e) => finish(new Error(`起不了这个命令：${String((e && e.message) || e)}`)));
    proc.on('exit', (code) => {
      if (!done) finish(new Error(`进程退出（code=${code}），握手未完成`));
    });

    const send = (obj) => {
      try {
        proc.stdin.write(`${JSON.stringify(obj)}\n`);
      } catch {
        /* 管道已关 */
      }
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'evawork-desktop', version: '1.0' },
      },
    });
  });
}

module.exports = { list, create, patch, remove, tools, mcpFile };
