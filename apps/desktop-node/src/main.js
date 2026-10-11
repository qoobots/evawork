/**
 * Electron 主进程。
 *
 * **Python 后端（apps/desktop-py）已删除**：本文件不再 spawn 它，
 * `startPython` / `backendDir` / `pythonBin` 一并删除，打包配置里随包分发它的
 * extraResources 条目也已去掉。
 * 智能体只有一个内核——TS 子进程（apps/agent-ts），由 TsAgentHost 托管。
 *
 * 本进程**不再依赖后端**：
 *   - 登录与令牌：主进程自治（./iam.js）
 *   - 工作区：userData/workspace.json（IPC evawork:workspace-*）
 *   - 本机开关（保持唤醒 / 语音快捷键）：userData/toggles.json
 *   - 内置浏览器命令：渲染层直接 IPC 下发（evawork:browser-command）
 *   - 崩溃报告：只落盘
 * 剩下的 `BACKEND` 常量只是**转发给渲染层**的地址（preload 注入），
 * 渲染层那些尚未迁移的数据接口还在用它；主进程自己已经不打了。
 *
 * 职责：
 *   1. 打开窗口，加载 Vue 渲染层（dev: vite / 发布:本地 HTTP 托管 dist）
 *   2. TS 智能体子进程的拉起/重启/停止，以及它的 IPC 桥
 *   3. T-054：文件日志 + 崩溃捕获 + 自动更新（仅打包态）
 */
const { app, BrowserWindow, globalShortcut, dialog, Menu, ipcMain, powerSaveBlocker, shell, nativeTheme, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { createLogger } = require('./logger');
const { installCrashHandlers } = require('./crash');
const iam = require('./iam');
const files = require('./files');
const providers = require('./providers');
const store = require('./store');
const catalog = require('./catalog');
const automations = require('./automations');
const mcp = require('./mcp');
const worktree = require('./worktree');
const { TsAgentHost } = require('./tsAgent');

/* T-113：进程间契约与环境变量统一叫 evawork（前端桥、IPC 频道、env 前缀）。
   旧 TRAWORK_ 前缀仍作回退：scripts/dev.mjs、bundle_python.py 这些外部启动脚本
   还在传旧名，硬切会让端口/UI 地址传不进来（表现为窗口白屏、后端连不上）。
   等启动脚本全部切到 EVAWORK_ 之后，这段回退就可以删。 */
const envName = (key) => process.env[`EVAWORK_${key}`] || process.env[`TRAWORK_${key}`];

const PORT = Number(envName('BACKEND_PORT') || 18765);
const BACKEND = `http://127.0.0.1:${PORT}`;
const UI_PORT = Number(envName('UI_PORT') || 4280);

/* T-120：窗口栏（原生标题栏那一行）不再单独占一行——内容第一行自己就是窗口栏，
   最小化/最大化/关闭以系统 overlay 的形式浮在右上角。
   只在 Windows/Linux 开：macOS 的 titleBarStyle='hidden' 语义不同（红绿灯浮在内容左上角），
   会正好压在侧栏的模式切换上，而本项目发布物只有 Windows，先不动 macOS。
   改这里要同步 preload.js 的 `customTitleBar`（同一判据），否则前端会白留/漏留一条拖拽带。 */
const CUSTOM_TITLEBAR = process.platform !== 'darwin';
/** 顶部窗口栏高度。必须与前端 styles/app.css 的 --titlebar-h 同值：
 *  那边决定内容让位多少，这边决定系统窗口按钮多高，差一点按钮就会歪出那条带。 */
const TITLEBAR_H = 36;

let win = null;
let tsAgentHost = null; // TS 智能体子进程宿主
let uiServer = null;
let updater = null; // electron-updater 实例（仅打包态）
// 日志器：就绪前用控制台垫片，whenReady 后替换为落盘日志器。
let log = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  forwardRenderer() {},
};

/* 智能体选择：曾经是 py / ts 二选一，Python 后端废弃后只剩 TS。
   仍保留这个文件读写形状——老用户存的是 'py'，照读会把应用指向一个已经不存在的
   内核（表现：界面正常但一发任务就"智能体未运行"）。一律归一为 'ts'。 */
function agentChoiceFile() {
  return path.join(app.getPath('userData'), 'agent-choice.json');
}

function readAgentChoice() {
  return 'ts';
}

function writeAgentChoice() {
  const v = 'ts';
  try {
    fs.mkdirSync(path.dirname(agentChoiceFile()), { recursive: true });
    fs.writeFileSync(agentChoiceFile(), JSON.stringify({ agent: v }));
  } catch (err) {
    log.warn('[electron] agent-choice 写入失败:', String((err && err.message) || err));
  }
  return v;
}

/* 工作区根。以前存在后端（`GET/PUT /api/workspace`），后端不拉起之后，
   智能体就只剩 process.cwd() 一个兜底——用户选过的工作区会被悄悄忘掉，
   表现为"换了个目录，文件型任务全落错地方"。存 userData，本机行为。 */
function workspaceFile() {
  return path.join(app.getPath('userData'), 'workspace.json');
}

/** 没设过时的默认：用户目录下的 EvaWork。
 *  不能退回 process.cwd()——打包态 cwd 是安装目录（Program Files），
 *  智能体往那儿写文件既可能没权限，又会把产物混进程序目录。 */
function defaultWorkspace() {
  const dir = path.join(app.getPath('home'), 'EvaWork');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来就交给调用方兜底 */
  }
  return fs.existsSync(dir) ? dir : '';
}

function readWorkspace() {
  try {
    const v = JSON.parse(fs.readFileSync(workspaceFile(), 'utf8'));
    const p = String((v && v.path) || '');
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* 没存过 */
  }
  return defaultWorkspace();
}

function writeWorkspace(p) {
  const path_ = String(p || '').trim();
  try {
    fs.mkdirSync(path.dirname(workspaceFile()), { recursive: true });
    fs.writeFileSync(workspaceFile(), JSON.stringify({ path: path_ }));
  } catch (err) {
    log.warn('[workspace] 写入失败:', String((err && err.message) || err));
  }
  return path_;
}

function setupWorkspaceIpc() {
  ipcMain.handle('evawork:workspace-get', () => ({ path: readWorkspace() }));
  ipcMain.handle('evawork:workspace-set', (_e, p) => {
    const v = writeWorkspace(p);
    /* 工作区是子进程启动参数，运行中改不了：变了就重拉。
       不重拉的话用户刚选完目录，任务还写进旧工作区。 */
    if (tsAgentHost && tsAgentHost.running && tsAgentHost.lastWorkspace !== v) {
      void tsAgentHost.stop().catch(() => {}).then(async () => {
        const r = await tsAgentHost.start().catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
        log.info('[electron] ts-agent(工作区变更重启):', JSON.stringify(r));
      });
    }
    return { path: v };
  });
}

/* 我的文件 / 附件：主进程直接读写磁盘（后端废弃后没有别的地方可去）。
   统一包一层：文件系统操作会抛各种 errno，不接住就会变成 IPC 通道上的
   "Error invoking remote method"，界面只能显示一句没用的话。 */
function setupFilesIpc() {
  const wrap = (fn) => async (_e, args) => {
    try {
      return { ok: true, ...fn(args || {}) };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  };
  ipcMain.handle('evawork:files-roots', wrap(() => files.roots()));
  ipcMain.handle('evawork:files-scan', wrap((a) => files.scan(a)));
  ipcMain.handle('evawork:files-tree', wrap((a) => files.tree(a)));
  ipcMain.handle('evawork:files-content', wrap((a) => files.content(a)));
  ipcMain.handle('evawork:files-write', wrap((a) => files.write(a)));
  ipcMain.handle('evawork:files-save', wrap((a) => files.saveArtifact(a)));
  ipcMain.handle('evawork:files-attach', wrap((a) => files.attach(a)));
  ipcMain.handle('evawork:files-attach-remove', wrap((a) => files.attachRemove(a)));
  /* 用系统默认程序打开文件。路径先过 files 的越界校验再交给 shell——
     shell.openPath 拿到什么就开什么，不校验等于给渲染层一个任意文件执行口。 */
  ipcMain.handle('evawork:files-open', async (_e, a) => {
    try {
      const p = files.resolveForOpen(a || {});
      const err = await shell.openPath(p);
      return err ? { ok: false, reason: err } : { ok: true, path: p };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  });
}

/* 设置（T-015）：通用 KV，落在 userData/settings.json。
   以前存后端的 kv 表；后端不拉起之后，改过的设置一重启就回默认值，
   而且界面会一直报"未连接后端"。本机偏好本来就该存本机。 */
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    const v = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function setupSettingsIpc() {
  ipcMain.handle('evawork:settings-get', () => ({ ok: true, items: readSettings() }));
  ipcMain.handle('evawork:settings-put', (_e, patch) => {
    const next = { ...readSettings(), ...(patch && typeof patch === 'object' ? patch : {}) };
    try {
      fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
      fs.writeFileSync(settingsFile(), JSON.stringify(next));
      return { ok: true, items: next };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  });
}

/* S-25：BYOK 通道。Key 只存本机、只回显后 4 位，测试请求走主进程的 fetch。 */
function setupProvidersIpc() {
  ipcMain.handle('evawork:providers-list', () => providers.list());
  const guard = (fn) => async (_e, a) => {
    try {
      return await fn(a);
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  };
  ipcMain.handle('evawork:providers-add', guard((a) => providers.add(a)));
  ipcMain.handle('evawork:providers-update', guard((a) => providers.update(String((a && a.id) || ''), (a && a.patch) || {})));
  ipcMain.handle('evawork:providers-delete', guard((a) => providers.remove(String((a && a.id) || ''))));
  ipcMain.handle('evawork:providers-test', async (_e, a) => await providers.test((a && a.id) || a || {}));
}

/* 用量统计：真相源是**本地会话目录**（后端任务库已经没有了）。
   统计口径照旧但只报**算得出来的**：任务数、趋势、按结束原因分布都来自会话；
   产物数、自动化运行、token 精算这三项本地没有数据，给 0 并标注 estimated，
   不拿"看起来差不多"的假数字填——用量页是用来对账的，假数比空白有害。 */
function setupUsageIpc() {
  ipcMain.handle('evawork:usage', async (_e, a) => {
    const days = Math.min(Math.max(Number((a && a.days) || 30), 1), 365);
    let sessions = [];
    if (tsAgentHost) {
      const r = await tsAgentHost.listSessions().catch(() => ({ ok: false, sessions: [] }));
      sessions = r.sessions || [];
    }
    const cutoff = Date.now() - days * 86400000;
    const recent = sessions.filter((s) => (s.lastTs || 0) >= cutoff);

    const byState = {};
    let chars = 0;
    for (const s of recent) {
      const stop = String(s.stop || '').toLowerCase();
      const key = !stop ? 'running' : stop.includes('error') || stop.includes('fail') ? 'failed' : 'done';
      byState[key] = (byState[key] || 0) + 1;
      chars += String(s.goal || '').length + String(s.title || '').length;
    }
    // 按天聚合（本地时区）
    const dayCount = new Map();
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 86400000);
      dayCount.set(d.toISOString().slice(0, 10), 0);
    }
    for (const s of recent) {
      const k = new Date(s.lastTs || 0).toISOString().slice(0, 10);
      if (dayCount.has(k)) dayCount.set(k, dayCount.get(k) + 1);
    }
    return {
      ok: true,
      days,
      tasks: { total: recent.length, by_state: byState, by_model: {}, by_approval: {} },
      artifacts: 0,
      usage_records: [],
      tokens: { estimated: true, chars, approx: Math.round(chars / 4), method: '按字符数/4 估算（模型未回传 usage）' },
      series: [...dayCount.entries()].map(([date, count]) => ({ date, count })),
      automation_runs: { total: 0, by_status: {} },
    };
  });
}

/* 目录（插件/技能/模板）与自动化：前者读随包分发的静态 JSON，后者存本机 store。
   cron 预览是真解析——那个预览存在的唯一目的就是"保存前看清会什么时候跑"。 */
function setupCatalogIpc() {
  const guard = (fn) => async (_e, a) => {
    try {
      return await fn(a || {});
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  };
  ipcMain.handle('evawork:catalog-meta', () => catalog.meta());
  ipcMain.handle('evawork:catalog-items', guard((a) => catalog.items(a)));
  ipcMain.handle('evawork:catalog-reload', () => catalog.reload());
  ipcMain.handle('evawork:templates-meta', () => catalog.templateMeta());
  ipcMain.handle('evawork:templates-list', guard((a) => catalog.templates(a)));
  ipcMain.handle('evawork:template-get', guard((a) => catalog.template(String(a.title || ''))));
  ipcMain.handle('evawork:favorites-get', () => ({ ok: true, items: catalog.favorites() }));
  /* 本地技能：目录顺序/命名与 agent-ts 的 skill.ts 一致，
     否则界面列的和内核能加载的不是同一批。 */
  ipcMain.handle('evawork:skills-installed', () => catalog.installedSkills(readWorkspace()));
  ipcMain.handle('evawork:skill-detail', guard((a) => catalog.skillDetail(readWorkspace(), String(a.name || ''))));
  ipcMain.handle('evawork:favorites-set', guard((a) => catalog.setFavorite(String(a.title || ''), Boolean(a.faved))));

  ipcMain.handle('evawork:automations-list', () => automations.list());
  ipcMain.handle('evawork:automations-create', guard((a) => automations.create(a)));
  ipcMain.handle('evawork:automations-patch', guard((a) => automations.patch(String(a.id || ''), a.patch || {})));
  ipcMain.handle('evawork:automations-remove', guard((a) => automations.remove(String(a.id || ''))));
  ipcMain.handle('evawork:automations-runs', guard((a) => automations.runs(a.limit)));
  ipcMain.handle('evawork:automations-preview', guard((a) => automations.preview(String(a.cron || ''))));
  /* MCP 服务：写的是 agent-ts 真正读的那份 mcp.json，不是另起一份配置。
     另起一份会让"界面里加好了、智能体看不见"变成静默的坑。 */
  ipcMain.handle('evawork:mcp-list', () => mcp.list());
  ipcMain.handle('evawork:mcp-create', guard((a) => mcp.create(a)));
  ipcMain.handle('evawork:mcp-patch', guard((a) => mcp.patch(String(a.id || ''), a.patch || {})));
  ipcMain.handle('evawork:mcp-delete', guard((a) => mcp.remove(String(a.id || ''))));
  ipcMain.handle('evawork:mcp-tools', async (_e, a) => await mcp.tools(String(a.id || ''), Boolean(a.refresh)).catch((e) => ({ ok: false, tools: [], error: String((e && e.message) || e) })));
  /* S-22 工作树：真的 git worktree。git 就在本机，没必要为一个只会调 git 的
     功能维持一个常驻服务。 */
  ipcMain.handle('evawork:worktree-state', async () => await worktree.state().catch((e) => ({ supported: false, reason: String((e && e.message) || e), repo: '', items: [], totalBytes: 0, thresholdBytes: 0, keepBranch: false })));
  ipcMain.handle('evawork:worktree-create', guard((a) => worktree.create(String(a.branch || ''), String(a.base || ''))));
  ipcMain.handle('evawork:worktree-delete', guard((a) => worktree.remove(String(a.path || ''), Boolean(a.force))));
  ipcMain.handle('evawork:worktree-prune', guard((a) => worktree.prune(a.keep)));
  ipcMain.handle('evawork:worktree-config', guard((a) => worktree.saveCfg(a)));
  ipcMain.handle('evawork:automations-tick', () => ({
    ok: true,
    items: [],
    reason: '本地暂无调度器：条目可保存与预览，但不会自动触发',
  }));
}

/* 本机集合存储：控制台配置 / 设计系统 / 模板 / 自动化这类"只是存 JSON"的数据。
   以前各存后端的 kv 或表，后端不拉起之后全丢；现在统一落到 userData/store/。 */
function setupStoreIpc() {
  const guard = (fn) => async (_e, a) => {
    try {
      return await fn(a || {});
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  };
  ipcMain.handle('evawork:store-list', guard((a) => store.list(String(a.name || ''))));
  ipcMain.handle('evawork:store-get', guard((a) => store.get(String(a.name || ''), String(a.id || ''))));
  ipcMain.handle('evawork:store-put', guard((a) => store.put(String(a.name || ''), a.item)));
  ipcMain.handle('evawork:store-delete', guard((a) => store.remove(String(a.name || ''), String(a.id || ''))));
  ipcMain.handle('evawork:store-replace', guard((a) => store.replaceAll(String(a.name || ''), a.items)));
}

/* 长期记忆（S-21）：正文落在**应用数据区**的 memory/user_profile.md，
   不是用户工作区——它属于用户本人，不该被工作区沙箱约束，也不该占用
   "写用户文件"的审批额度。以前这份文件由后端读写，现在归主进程。 */
const MEMORY_LIMIT = 20000; // 字符上限：再大就会天天挤占上下文

function memoryFile() {
  return path.join(app.getPath('userData'), 'memory', 'user_profile.md');
}

function setupMemoryIpc() {
  const read = () => {
    const file = memoryFile();
    let content = '';
    let exists = false;
    let mtime = 0;
    try {
      const st = fs.statSync(file);
      content = fs.readFileSync(file, 'utf8');
      exists = true;
      mtime = Math.floor(st.mtimeMs / 1000);
    } catch {
      /* 还没写过：exists=false，content 空 */
    }
    return {
      ok: true,
      enabled: readToggles().memory !== false,
      path: file,
      exists,
      chars: content.length,
      updated: mtime,
      limit: MEMORY_LIMIT,
      content,
    };
  };
  ipcMain.handle('evawork:memory-get', () => read());
  ipcMain.handle('evawork:memory-save', (_e, content) => {
    const text = String(content || '');
    if (text.length > MEMORY_LIMIT) {
      return { ok: false, reason: `记忆超过 ${MEMORY_LIMIT} 字（当前 ${text.length} 字），请先精简` };
    }
    try {
      const file = memoryFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, 'utf8');
      return read();
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('evawork:memory-clear', () => {
    try {
      fs.unlinkSync(memoryFile());
    } catch {
      /* 本来就没有，也算清掉了 */
    }
    return { ok: true };
  });
}

function setupAgentChoiceIpc() {
  ipcMain.handle('evawork:agent-choice-get', () => {
    const agent = readAgentChoice();
    return { agent, running: tsAgentHost ? tsAgentHost.status().running : false };
  });

  ipcMain.handle('evawork:agent-choice-set', async (_e, agent) => {
    const v = writeAgentChoice(agent);
    /* 切换立刻生效，不重启应用。Python 后端废弃后只剩 TS 一个内核，
       这里等价于"确保它在跑"；令牌由主进程 IAM 提供，未登录就如实回报未运行。 */
    if (tsAgentHost) {
      const r = await tsAgentHost.start().catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
      log.info('[electron] ts-agent:', JSON.stringify(r));
    }
    return { agent: 'ts', running: tsAgentHost ? tsAgentHost.status().running : false };
  });
}

// T-004：本地 HTTP 托管 UI（file:// 会 CORS 拦截 ES module，打包态必须用 HTTP）。
function startUiServer() {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'ui')
    : path.join(__dirname, '..', '..', 'desktop-ui', 'dist');
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };
  uiServer = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        // SPA：未知路径回退 index.html（hash 路由实际都落在 /）
        fs.readFile(path.join(root, 'index.html'), (e2, html) => {
          if (e2) {
            res.writeHead(404);
            res.end('not found');
          } else {
            res.writeHead(200, { 'Content-Type': mime['.html'] });
            res.end(html);
          }
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  uiServer.listen(UI_PORT, '127.0.0.1', () => {
    log.info('[ui-server]', root, '->', `http://127.0.0.1:${UI_PORT}`);
  });
}

/**
 * T-120：窗口栏的初始颜色——渲染层还没挂载（还没上报主题）时的兜底。
 * 用系统的深浅色猜一个，笔亮带总比"深色界面顶上横一条亮条"好；渲染层上报后会立刻纠正。
 * 色值对应前端 styles/app.css 的 --bg / --t1（主进程读不到 CSS 变量，只能同值硬写）。
 */
function initialTitleBar() {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#16171a', symbolColor: '#e6e8ea' }
    : { color: '#f5f6f7', symbolColor: '#212429' };
}

/* ---- 窗口尺寸/位置记忆 ----
   Electron 不像 VS Code / Chrome 那样默认记住窗口大小，所以自己记一份
   （沿用 approval-mode.json 那种"userData 下一个小 json"的既有做法）。

   只记尺寸不够，**位置也要记**——但位置有陷阱：拔掉扩展屏、换分辨率、投影切换之后，
   存下来的坐标可能落在所有显示器之外，窗口就会"开在屏幕外"，
   用户看到的不是"位置没记住"，而是"应用坏了"。所以恢复前必须把 bounds
   夹回当前显示器布局里（safeWindowBounds）。

   这几条是同一个功能的完整要求：记住尺寸 + 记住位置 + 夹回可见区 + 记住最大化。 */
const WIN_DEFAULT = { width: 1280, height: 820 };
const WIN_MIN = { width: 960, height: 640 };

function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState() {
  try {
    const v = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    return v && typeof v.width === 'number' && typeof v.height === 'number' ? v : null;
  } catch {
    return null; // 没记过（或记坏了）→ 用默认值，不追问
  }
}

function writeWindowState(st) {
  try {
    fs.mkdirSync(path.dirname(windowStateFile()), { recursive: true });
    fs.writeFileSync(windowStateFile(), JSON.stringify(st), 'utf8');
  } catch (err) {
    log.warn('[window] 窗口尺寸写入失败', err && err.message);
  }
}

/**
 * 把存下来的 bounds 夹到**当前**显示器布局里。
 * - 与任一显示器 workArea 有交集 → 用那块屏，并把位置夹进去（标题栏必须可见）
 * - 一块都不沾（屏被拔了/分辨率改了）→ 居中，尺寸夹进 workArea
 */
function safeWindowBounds(saved) {
  const displays = screen.getAllDisplays();
  const hit = saved
    ? displays.find((d) => {
        const a = d.workArea;
        return (
          saved.x < a.x + a.width && saved.x + saved.width > a.x &&
          saved.y < a.y + a.height && saved.y + saved.height > a.y
        );
      })
    : null;
  const area = (hit ? displays.find((d) => d.id === hit.id) : displays[0]).workArea;
  const width = Math.min(
    Math.max(Math.round(saved?.width || WIN_DEFAULT.width), WIN_MIN.width),
    area.width,
  );
  const height = Math.min(
    Math.max(Math.round(saved?.height || WIN_DEFAULT.height), WIN_MIN.height),
    area.height,
  );
  const hasPos = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y);
  return {
    x: hasPos
      ? Math.min(Math.max(Math.round(saved.x), area.x), area.x + area.width - width)
      : Math.round(area.x + (area.width - width) / 2),
    y: hasPos
      ? Math.min(Math.max(Math.round(saved.y), area.y), area.y + area.height - height)
      : Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    maximized: Boolean(saved?.maximized),
  };
}

let winStateTimer = null;

/** 最小化时 getBounds 是被系统挪走的怪尺寸，别记；最大化时记的是"还原后"的尺寸。 */
function persistWindowState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  const maximized = win.isMaximized();
  const b = maximized ? win.getNormalBounds() : win.getBounds();
  writeWindowState({ x: b.x, y: b.y, width: b.width, height: b.height, maximized });
}

/** 拖动窗口会连续触发 resize/move，不防抖会一路狂写盘。 */
function schedulePersistWindowState() {
  if (winStateTimer) clearTimeout(winStateTimer);
  winStateTimer = setTimeout(() => {
    winStateTimer = null;
    persistWindowState();
  }, 400);
}

function createWindow() {
  const { maximized: wantMaximized, ...bounds } = safeWindowBounds(readWindowState());
  win = new BrowserWindow({
    ...bounds,
    minWidth: WIN_MIN.width,
    minHeight: WIN_MIN.height,
    backgroundColor: '#f5f6f7',
    /* T-120：去掉原生标题栏（否则顶部是"标题栏 + 内容第一行"两层）。
       titleBarOverlay 只画三个窗口按钮，颜色/高度由渲染层按当前主题上报后动态对齐
       （见 setupTitleBarIpc）——不用 frame:false 全部自绘：自绘按钮会丢掉系统的
       窗口吸附预览（Win11 把鼠标悬在最大化上弹的分屏面板）和按钮的可达性。 */
    ...(CUSTOM_TITLEBAR
      ? { titleBarStyle: 'hidden', titleBarOverlay: { ...initialTitleBar(), height: TITLEBAR_H } }
      : {}),
    /* T-119：原生菜单栏默认收起。
       中文产品顶部挂一排 Chromium 自带的英文 File/Edit/View/Window/Help：既跟应用自己的
       侧栏导航重复，又白占一条约 28px 的横带（顶部"栏"变成两层）。Windows 上的通行做法
       就是收起 + Alt 唤出（VS Code / Chrome 都这么干）。
       不写 Menu.setApplicationMenu(null)：菜单没了，它的快捷键加速器也一起没了
       （Ctrl+R 重载、F12 开发者工具、缩放），那些是排障要用的，不能跟着消失。 */
    autoHideMenuBar: true,
    // 等首帧渲染完再 show，避免后端就绪前闪白屏/空白窗
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => {
    // 上次是最大化关的：先按"还原尺寸"建窗再最大化，反过来会看到一次闪动
    if (wantMaximized) win.maximize();
    win.show();
  });

  /* 记住尺寸与位置。close 时也落一次：resize 的 400ms 防抖可能还没到就退出了，
     只靠防抖的话，"改完大小立刻关掉"这一种最常见的操作会丢。 */
  win.on('resize', schedulePersistWindowState);
  win.on('move', schedulePersistWindowState);
  win.on('maximize', schedulePersistWindowState);
  win.on('unmaximize', schedulePersistWindowState);
  win.on('close', () => {
    if (winStateTimer) {
      clearTimeout(winStateTimer);
      winStateTimer = null;
    }
    persistWindowState();
  });
  /* 渲染层的 console 转发进主日志：界面"看起来卡住/不渲染"这类问题，
     病根往往是渲染层抛了错，而它的 console 用户看不见、日志里也没有——
     排障时只能两眼一抹黑。转发 error 级别就够（debug/info 噪音太大）。 */
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 3) log.warn('[renderer]', String(message).slice(0, 300), `(${sourceId}:${line})`);
  });

  /* S-20：麦克风权限。Electron **默认拒绝**未经处理的权限请求（不像浏览器会弹窗问用户），
     不写这段，getUserMedia 直接抛 NotAllowedError，语音输入等于没做。
     只放行本应用自己的界面（本地 UI 服务 / 开发期 vite），其它来源一律拒——
     窗口里若将来加载了外部页面，不该顺带拿到麦克风。 */
  const ownOrigin = (u) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(String(u || ''));
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb, details) => {
    if (permission === 'media' && ownOrigin(details && details.requestingUrl)) {
      log.info('[settings] 已放行麦克风请求：', details && details.requestingUrl);
      return cb(true);
    }
    return cb(false);
  });
  win.webContents.session.setPermissionCheckHandler((_wc, permission, origin) =>
    permission === 'media' && ownOrigin(origin),
  );

  // T-004：打包态从本地 HTTP 服务加载 UI；开发期走 vite（EVAWORK_UI_URL，默认 4173）。
  const uiUrl = envName('UI_URL');
  if (app.isPackaged && !uiUrl) {
    win.loadURL(`http://127.0.0.1:${UI_PORT}/`);
  } else {
    win.loadURL(uiUrl || 'http://127.0.0.1:4173');
  }

  // T-054：转发渲染层 error/warn 到主进程日志。
  log.forwardRenderer(win);
  // 窗口级崩溃兜底（'render-process-gone' 已在 app 级覆盖，这里再补一次）。
  win.webContents.on('crashed', () => {
    log.error('[crash] renderer webContents crashed');
  });

  // T-113：频道名必须与 preload.js 监听、渲染层 window.evawork 三方一致，
  // 改一处而漏另外两处 = 后端地址注入不到，前端会一直显示"未连接后端"。
  //
  // T-116：用 on 而不是 once。preload 里缓存 url 的变量是**每次导航重建**的（刷新会
  // 重建隔离世界，缓存清零），而 did-finish-load 只在首次加载时有过一次监听：
  // 于是任何一次整页刷新之后（Vite HMR full-reload、帮助菜单的 reload、Ctrl+R、
  // 渲染进程崩溃后自动恢复）再没人注入 → window.evawork.getBackendURL() 恒为空串 →
  // 界面"未连接后端"、下方账号永远"未登录"、登录按钮被 disabled（点了毫无反应）。
  // 每次加载都注入，刷新才和启动等价。
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('evawork:backend', BACKEND);
  });
}

/** T-055：全局快捷键——即便焦点在别的软件也能唤起本应用。
 *  Cmd/Ctrl+Shift+N 新建任务。
 *  （T-142：原 Cmd/Ctrl+1·2·3 切 Work/Code/Design 的三个键已摘掉——侧栏那一行
 *   模式切换换成了品牌标识，没有入口也不该再留一个"按下去界面偷偷变"的键。） */
function registerShortcuts() {
  const send = (msg) => {
    if (!win) return;
    win.show();
    win.focus();
    win.webContents.send('evawork:shortcut', msg);
  };
  const reg = (accel, msg) => {
    try {
      if (!globalShortcut.register(accel, () => send(msg))) {
        log.warn('[electron] 快捷键注册失败（可能已被系统占用）：', accel);
      }
    } catch (e) {
      log.warn('[electron] 快捷键注册异常：', accel, e && e.message);
    }
  };
  reg('CommandOrControl+Shift+N', { action: 'new-task' });
}

/** T-054：自动更新（仅打包态）。配置见 package.json 的 build.publish（GitHub releases）。 */
function setupUpdater() {
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    log.warn('[updater] electron-updater 未安装，跳过自动更新');
    return;
  }
  updater = autoUpdater;
  autoUpdater.logger = {
    info: (m) => log.info('[updater]', m),
    warn: (m) => log.warn('[updater]', m),
    error: (m) => log.error('[updater]', m),
    debug: () => {},
  };
  autoUpdater.autoDownload = false; // 默认不自动下载，提示后由用户确认
  autoUpdater.on('update-available', (i) => log.info('[updater] 有新版本', i && i.version));
  autoUpdater.on('update-not-available', () => log.info('[updater] 已是最新'));
  autoUpdater.on('error', (e) => log.error('[updater] 检查失败', e && e.message));
  autoUpdater.on('download-progress', (p) => log.info('[updater] 下载进度', Math.round(p.percent), '%'));

  // 启动后静默检查一次
  autoUpdater
    .checkForUpdatesAndNotify()
    .catch((e) => log.error('[updater] 初始检查失败', e && e.message));
}

/**
 * T-119：检查更新（设置→关于 的「检查更新」按钮用）。
 *
 * 以前这里是 `ipcMain.on('evawork:check-updates')`——发了不管，渲染层拿不到任何结果，
 * 界面就只能"点了没反应"。改成返回结构化结果：dev、缺组件、检查失败都要说得出话。
 */
async function checkForUpdates() {
  if (!app.isPackaged) return { status: 'unsupported', message: '开发模式不检查更新，请使用安装版' };
  if (!updater) return { status: 'unsupported', message: '更新组件未就绪，请重新安装正式版' };
  try {
    const r = await updater.checkForUpdates();
    const version = (r && r.updateInfo && r.updateInfo.version) || '';
    // 判断依据是 feed 里的版本号，不是"有没有 result"：electron-updater 在"已是最新"时
    // 同样会正常 resolve。另外 autoDownload=false，这里不会顺手把包下下来。
    if (version && version !== app.getVersion()) return { status: 'available', version };
    return { status: 'latest' };
  } catch (e) {
    log.error('[updater] 手动检查失败', e && e.message);
    return { status: 'error', message: (e && e.message) || '未知错误' };
  }
}

/** T-119：把检查更新接成能返回结果的 IPC（契约对应 preload 的 checkUpdates）。 */
function setupUpdateIpc() {
  ipcMain.handle('evawork:check-updates', () => checkForUpdates());
}

/**
 * S-15：关于页的版本号。
 *
 * 以前界面上写死 "0.1.64 / 2026-09-08"——装的是 0.2.x，关于页还说是 0.1.64，
 * 排障时用户报上来的版本号永远不可信。版本号只有一个真相源：`app.getVersion()`
 * （读的是打包时的 package.json）。纯 web 预览没有主进程，那一侧前端自己显示"不可用"。
 */
function setupAppInfoIpc() {
  ipcMain.handle('evawork:app-info', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
}

/**
 * T-120：窗口栏颜色跟随内容（契约对应 preload 的 setTitleBarTheme）。
 *
 * 为什么由渲染层上报而不是主进程自己决定：主题是应用自管的（不跟系统走，见 stores/theme.ts），
 * "和内容一致"这件事只有渲染层看得见——它能读到真实的计算样式，主进程读不到 CSS 变量。
 * 除主题外，管理控制台是另一套常驻深色令牌，路由切过去时渲染层也会重报。
 */
function setupTitleBarIpc() {
  ipcMain.on('evawork:titlebar-theme', (_e, theme) => {
    if (!CUSTOM_TITLEBAR || !win || win.isDestroyed()) return;
    const color = (theme && theme.color) || '';
    const symbolColor = (theme && theme.symbolColor) || '';
    if (!color || !symbolColor) return;
    try {
      win.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_H });
      // 窗口底色一起跟主题：最大化/还原重绘、以及圆角外露底都取这个值，
      // 深色主题配浅色底会在窗口边缘露一条白边。
      win.setBackgroundColor(color);
    } catch (e) {
      log.warn('[titlebar] 设置窗口栏颜色失败', e && e.message);
    }
  });
}

/**
 * S-04：设置里「保持电脑唤醒」→ `powerSaveBlocker`。
 *
 * 以前这个开关只写进后端 KV，主进程根本不认识它：勾了"保持唤醒"，跑长任务时照样休眠。
 * 休眠会**静默中断**任务通道（SSE 断连、工具调用超时），比报错更难查，所以这里必须真接。
 * 只管这一个开关：语音快捷键（voiceHot）依赖尚未实现的语音输入，不做半截（见 07 文档）。
 */
let keepAwakeId = null;

function applyKeepAwake(on) {
  writeToggle('keepAwake', on); // 重启后仍生效：本机行为，不能再依赖后端 KV
  try {
    if (on) {
      if (keepAwakeId === null) {
        keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
        log.info('[settings] 已阻止系统休眠，id=', keepAwakeId);
      }
    } else if (keepAwakeId !== null) {
      powerSaveBlocker.stop(keepAwakeId);
      log.info('[settings] 已恢复系统休眠，id=', keepAwakeId);
      keepAwakeId = null;
    }
  } catch (e) {
    log.warn('[settings] 保持唤醒设置失败：', e && e.message);
  }
}

/** 渲染层改动即时上报（比"后端就绪时读一次"更跟手；后端重启后那份 KV 也还在）。 */
function setupKeepAwakeIpc() {
  ipcMain.on('evawork:keep-awake', (_e, on) => applyKeepAwake(!!on));
}

/* S-20：语音转录快捷键（Alt+V）。
   以前它是禁用的——因为语音输入没实现，注册一个按了没反应的组合键纯属骗人。
   现在麦克风真能用（后端 ASR），这个键才有目标：按下即唤起/结束录音，
   焦点在别的软件里也照样生效（globalShortcut 而不是页面 keydown）。 */
let voiceHotRegistered = false;

function applyVoiceHot(on) {
  writeToggle('voiceHot', on);
  try {
    if (on && !voiceHotRegistered) {
      const ok = globalShortcut.register('Alt+V', () => {
        if (!win || win.isDestroyed()) return;
        win.show();
        win.focus();
        win.webContents.send('evawork:shortcut', { action: 'voice' });
      });
      voiceHotRegistered = ok;
      if (!ok) log.warn('[settings] Alt+V 注册失败（可能已被系统占用）');
      else log.info('[settings] 已注册语音快捷键 Alt+V');
    } else if (!on && voiceHotRegistered) {
      globalShortcut.unregister('Alt+V');
      voiceHotRegistered = false;
      log.info('[settings] 已注销语音快捷键 Alt+V');
    }
  } catch (e) {
    log.warn('[settings] 语音快捷键设置失败：', e && e.message);
  }
}

function setupVoiceHotIpc() {
  ipcMain.on('evawork:voice-hot', (_e, on) => applyVoiceHot(!!on));
}

/* ===== S-23：内置浏览器 =====
   以前「允许 AI 控制内置浏览器 / 清除数据 / 自动截图」点了没反应——后端没有窗口可用。
   能力就是 Electron 自己的 BrowserWindow（不用再往里塞 CEF/Playwright 内核），
   独立 partition `persist:evawork-inner` 让它有自己的站点数据：
   "清除"清的是内置浏览器的 Cookies/本地存储，**不会碰掉应用自己的登录态**，
   也不碰用户系统浏览器里的数据。

   命令下发：渲染层直接 IPC（`evawork:browser-command`）→ 主进程执行 → 同步回结果。
   原来是主进程每 1s 轮询后端队列，后端不拉起之后那条路就断了，
   而且它本来就绕了一圈——窗口就在本进程里，直接调用还少一秒延迟。 */
const BROWSER_PARTITION = 'persist:evawork-inner';
let browserWin = null;

function ensureBrowserWindow() {
  if (browserWin && !browserWin.isDestroyed()) return browserWin;
  browserWin = new BrowserWindow({
    width: 1100,
    height: 760,
    title: '内置浏览器',
    parent: win && !win.isDestroyed() ? win : undefined,
    webPreferences: {
      partition: BROWSER_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  // 弹窗广告不另开窗口：就地导航，免得一个页面弹出一堆窗口
  browserWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void browserWin.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  browserWin.on('closed', () => {
    browserWin = null;
  });
  return browserWin;
}

/** 真打开一个网址（可选：加载完自动截一张——**加载完之前截出来是白屏，等于没截**）。 */
async function openInBrowser(url, shotPath) {
  const w = ensureBrowserWindow();
  await w.loadURL(url); // loadURL 的 promise 在页面加载完成后才 resolve
  w.show();
  const out = { url: w.webContents.getURL(), title: w.getTitle(), shot: null };
  if (shotPath) {
    try {
      const img = await w.webContents.capturePage();
      const buf = img.toPNG();
      fs.mkdirSync(path.dirname(shotPath), { recursive: true });
      fs.writeFileSync(shotPath, buf);
      out.shot = { path: shotPath, bytes: buf.length };
    } catch (err) {
      // 截图失败不能把"打开"也判失败：如实带回原因，让后端说清楚
      out.shot = { error: String((err && err.message) || err) };
    }
  }
  return out;
}

/** 自动截图的落点。以前这个目录由后端给（命令里带完整路径），
 *  命令改走 IPC 后得由主进程自己定——统一放 userData，跟别的用户数据一处。 */
function browserShotsDir() {
  const d = path.join(app.getPath('userData'), 'browser-shots');
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {
    /* 建不出来时截图会如实失败，不影响打开网页 */
  }
  return d;
}

async function handleBrowserCommand(cmd) {
  const args = cmd.args || {};
  if (cmd.op === 'open') {
    const url = String(args.url || '');
    if (!/^https?:\/\//i.test(url)) throw new Error('拒绝打开非 HTTP(S) 地址');
    /* shot 只接受"要不要截"或"文件名"；文件名一律 basename——
       命令来自渲染层，直接拼进路径就是目录穿越。 */
    let shot = '';
    if (args.shot === true || args.shot === 'true' || args.shot === 1) {
      shot = path.join(browserShotsDir(), `shot-${Date.now()}.png`);
    } else if (typeof args.shot === 'string' && args.shot.endsWith('.png')) {
      shot = path.join(browserShotsDir(), path.basename(args.shot));
    }
    return await openInBrowser(url, shot);
  }
  if (cmd.op === 'clear') {
    const s = session.fromPartition(BROWSER_PARTITION);
    await s.clearStorageData();
    await s.clearCache().catch(() => {});
    return { cleared: true };
  }
  if (cmd.op === 'close') {
    if (browserWin && !browserWin.isDestroyed()) browserWin.destroy();
    browserWin = null;
    return { closed: true };
  }
  throw new Error(`未知命令：${cmd.op}`);
}

/* 命令下发改成**渲染层直接 IPC 调主进程**，不再经后端队列轮询。
   原来主进程每 1s 去后端取一次待办命令再回写结果；后端不拉起之后这条链就断了，
   而它本来也没必要绕一圈——窗口就在本进程里，直接调用即可，还少一秒延迟。 */
function setupBrowserIpc() {
  ipcMain.handle('evawork:browser-command', async (_e, cmd) => {
    try {
      const result = await handleBrowserCommand(cmd || {});
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  /* 状态与截图列表（以前由后端持有）。窗口就在本进程里，"连没连上"直接看它在不在。 */
  ipcMain.handle('evawork:browser-state', () => {
    const dir = browserShotsDir();
    let shots = [];
    try {
      shots = fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.png'))
        .map((n) => {
          const st = fs.statSync(path.join(dir, n));
          return { name: n, bytes: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      /* 目录都还没有 = 没截过图 */
    }
    return {
      ok: true,
      connected: !!(browserWin && !browserWin.isDestroyed()),
      lastSeen: Date.now(),
      mode: 'inner',
      innerEnabled: true,
      outerEnabled: true,
      autoScreenshot: true,
      shotsDir: dir,
      shots,
    };
  });
  /* 截图内容：渲染层要的是能直接塞进 <img src> 的东西。
     以前是后端给一个 URL；现在没有后端，就直接给 data URL。 */
  ipcMain.handle('evawork:browser-shot', (_e, name) => {
    try {
      const file = path.join(browserShotsDir(), path.basename(String(name || '')));
      const b64 = fs.readFileSync(file).toString('base64');
      return { ok: true, url: `data:image/png;base64,${b64}` };
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
  });
}

/* 本机开关（保持唤醒 / 语音快捷键）落在主进程自己的文件里。
   以前这些开关只写进后端 KV，主进程启动时再去后端读回来——后端不拉起之后，
   重启应用就会丢状态（勾了"保持唤醒"也无效）。本地存一份才是真的持久化。 */
function togglesFile() {
  return path.join(app.getPath('userData'), 'toggles.json');
}

function readToggles() {
  try {
    const v = JSON.parse(fs.readFileSync(togglesFile(), 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeToggle(key, on) {
  const cur = readToggles();
  cur[key] = !!on;
  try {
    fs.mkdirSync(path.dirname(togglesFile()), { recursive: true });
    fs.writeFileSync(togglesFile(), JSON.stringify(cur));
  } catch (err) {
    log.warn('[settings] toggles 写入失败:', String((err && err.message) || err));
  }
}

/** 启动时按本地开关恢复本机行为，替代原来的 syncSettingsFromBackend。 */
function syncLocalToggles() {
  const t = readToggles();
  applyKeepAwake(!!t.keepAwake);
  applyVoiceHot(!!t.voiceHot);
}

/**
 * EVA 账号登录（浏览器 SSO）：渲染层点「登录」→ 主进程开回环监听 + 拉起浏览器，
 * 回调后用一次性 code 换令牌，结果经 `evawork:account` 推回所有窗口。
 *
 * 登录链路在**主进程**自治（`./iam.js`）：PKCE verifier、令牌换取、令牌存储、
 * refresh 轮换都在这里，不再经过后端。渲染层拿到的始终是登录态结果，
 * 看不到 PKCE verifier，也碰不到令牌。
 */
function setupIamAuth() {
  const push = (state) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('evawork:account', state);
    }
  };
  ipcMain.handle('evawork:iam-login', async () => {
    return await iam.startLogin(push, log);
  });
  // 登录态、登出、EVA 服务配置：全部由主进程持有（后端废弃后它是唯一真相源）
  ipcMain.handle('evawork:iam-account', async () => {
    return await iam.accountState();
  });
  ipcMain.handle('evawork:iam-logout', async () => {
    iam.logout();
    const st = await iam.accountState();
    push(st);
    return st;
  });
  ipcMain.handle('evawork:iam-config', async () => {
    return iam.config();
  });
  ipcMain.handle('evawork:iam-config-save', async (_e, patch) => {
    return iam.saveConfig(patch || {});
  });
  ipcMain.handle('evawork:iam-open-external', async (_e, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('拒绝打开非 HTTP(S) 地址');
    }
    await shell.openExternal(url);
    return true;
  });
  // 工作区「更换文件夹」：系统目录选择对话框（真正的校验在后端 PUT /api/workspace）
  ipcMain.handle('evawork:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择工作区文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? '' : r.filePaths[0];
  });

  /* 对话附件（+ 菜单「添加文件 / 截图」）。
     这里只做两件事：拿到用户在系统对话框里亲自选中的路径、截一张屏。
     **落盘与校验全在后端**（POST /api/files/attach → 工作区 .evawork/attachments/）：
     主进程不知道工作区在哪，复制/越界/体积这些判断放在后端才有一份事实源。 */
  ipcMain.handle('evawork:pick-files', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '添加附件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '全部文件', extensions: ['*'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: '文档', extensions: ['pdf', 'txt', 'md', 'csv', 'json', 'log', 'docx', 'xlsx', 'pptx'] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });

  /* 截图工具（electron-screenshots，MIT，仓库 nashaofu/screenshots）。
     自带一个全屏标注窗：框选区域 + 马赛克/画笔/箭头/矩形/椭圆/文字 + 撤销重做 + 放大镜 +
     多显示器，确认后通过 'ok' 事件把 PNG Buffer 交回来。选它是因为自己写一遍这些交互
     （尤其多屏与 Windows DPI 缩放的换算）成本高得多，而它恰好是 Electron 专用的。

     它依赖 node-screenshots（NAPI 原生模块，按平台 optional 包分发 .node），这是唯一的代价：
     **原生二进制必须从 asar 里解出来才能加载**，所以 package.json 的 build.asarUnpack 带上它
     （漏了会在打包成品里静默失效——装好的 exe 点截图毫无反应，还不报错）。

     延迟 require：原生模块万一加载失败，也不该拖垮启动，让用户点截图时看到明确原因。 */
  let shotsHost = null;
  function getScreenshots() {
    if (shotsHost) return shotsHost;
    const Screenshots = require('electron-screenshots');
    shotsHost = new Screenshots({
      // 界面是中文的，工具栏提示也一并给中文（库默认是英文）
      lang: {
        magnifier_position_label: '放大镜位置',
        operation_ok_title: '确定',
        operation_cancel_title: '取消',
        operation_save_title: '保存',
        operation_redo_title: '重做',
        operation_undo_title: '撤销',
        operation_mosaic_title: '马赛克',
        operation_text_title: '文字',
        operation_brush_title: '画笔',
        operation_arrow_title: '箭头',
        operation_ellipse_title: '椭圆',
        operation_rectangle_title: '矩形',
      },
    });
    /* Esc 取消得自己接：库没实现（react-screenshots 包里唯一的 "Escape" 只是 React 的按键名
       映射表，跟取消毫无关系）。挂 $view 而不是 $win——标注 UI 渲染在 BrowserView 里，
       按键事件进的是 view 的 webContents。endCapture() 会销毁窗口 → 'windowClosed'
       → 走到下面 awaitShotResult 的取消分支。 */
    shotsHost.$view.webContents.on('before-input-event', (ev, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return;
      ev.preventDefault();
      shotsHost.endCapture();
    });
    return shotsHost;
  }

  /* 等用户在截图窗里给结果：确定/保存 → PNG Buffer；取消 / 按 Esc / 窗口被关掉 → null。
     一次性的 Promise：拿到结果立刻摘监听，免得多次截图互相串味（第二次把第一次的图带上）。 */
  function awaitShotResult(shots) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const off = () => {
        shots.off('ok', onOk);
        shots.off('save', onSave);
        shots.off('cancel', onCancel);
        shots.off('windowClosed', onClosed);
        clearTimeout(timer);
      };
      const onOk = (_e, buf) => { off(); resolve(buf); };
      // 库默认的"保存"会另存一份到别处；这里接管掉，跟"确定"一样交给后端入库，避免重复落盘
      const onSave = (e, buf) => { e.preventDefault(); off(); resolve(buf); };
      const onCancel = () => { off(); resolve(null); };
      const onClosed = () => { off(); resolve(null); };
      timer = setTimeout(() => { off(); reject(new Error('截图超时：窗口没回来结果')); }, 5 * 60 * 1000);
      shots.on('ok', onOk);
      shots.on('save', onSave);
      shots.on('cancel', onCancel);
      shots.on('windowClosed', onClosed);
    });
  }

  ipcMain.handle('evawork:capture-screen', async (_e, hideWindow = false) => {
    const shots = getScreenshots();
    /* 「隐藏窗口截图」：截图前先把自己藏起来，否则每张图里都糊着一个 EvaWork 窗口。
       用 try/finally 兜底：无论成功、取消还是报错都得把窗口放回来——
       漏一次就是"窗口凭空消失"，用户只能杀进程重开。 */
    if (hideWindow && win) {
      win.hide();
      // 给窗口管理器重绘的时间，不然偶发还能抓到残影
      await new Promise((r) => setTimeout(r, 300));
    }
    let buffer;
    let escArmed = false;
    try {
      await shots.startCapture();
      /* Esc 取消改走**全局快捷键**：库没实现 Esc（react-screenshots 里唯一的 Escape 只是 React
         的按键名映射表），而且它建完窗就 $win.blur() —— 鼠标没落进截图窗之前焦点不在这儿，
         挂在 view 上的按键监听收不到事件。表现就是：框选过再按 Esc 有效、一进来直接按无效。
         全局快捷键跟焦点无关；只在本次截图期间接管，出来立刻摘掉，不影响别的软件。 */
      escArmed = globalShortcut.register('Escape', () => {
        shots.endCapture().catch(() => {});
      });
      if (!escArmed) log.warn('[electron] Esc 快捷键注册失败（可能被系统占用），截图只能用右键取消');
      buffer = await awaitShotResult(shots);
    } finally {
      // 只摘 Escape：unregisterAll() 会顺手把新建任务 / 切视图那几个也干掉
      if (escArmed) globalShortcut.unregister('Escape');
      if (hideWindow && win && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
    }
    if (!buffer || !buffer.length) return ''; // 用户取消，渲染层按空串处理
    const out = path.join(app.getPath('temp'), `evawork-shot-${Date.now()}.png`);
    fs.writeFileSync(out, buffer);
    // 临时文件由后端复制进工作区后就没用了；到点删掉自己这份，免得 temp 越堆越多
    setTimeout(() => {
      try {
        fs.unlinkSync(out);
      } catch {
        /* 已被清理/占用就留着，后端复制失败会自己报错 */
      }
    }, 60_000);
    return out;
  });
}

/**
 * T-054：应用菜单。
 *
 * T-119：这一栏默认收起（见 createWindow 的 autoHideMenuBar），收起后它只剩两个用处：
 * Alt 唤出给人看、以及承载快捷键加速器。所以：
 *   - 顶层标签改中文：Alt 唤出时不该还是一排英文；
 *   - dev 态也装同一份：否则 dev 走 Electron 默认的英文菜单，Alt 唤出又是英文；
 *   - 「检查更新」从菜单里拿掉：菜单收起后它藏得太深，而且点完只能说一句话。
 *     入口搬到 设置→关于（用户真正会去找更新的地方），并把真实结果写在界面上。
 */
function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    // label 覆盖 role 的默认英文名；子菜单内容与快捷键仍由 role 提供
    { role: 'fileMenu', label: '文件' },
    { role: 'editMenu', label: '编辑' },
    { role: 'viewMenu', label: '视图' },
    { role: 'windowMenu', label: '窗口' },
    {
      label: '帮助',
      submenu: [
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'reload', label: '重新加载' },
        { type: 'separator' },
        { role: 'about', label: '关于 EvaWork' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // T-054：日志与崩溃捕获尽早就位（捕获早期异常）
  log = createLogger({ dir: path.join(app.getPath('userData'), 'logs') });
  // IAM 存储目录：会话与配置落 userData，跟 approval-mode.json 同一套做法
  iam.init(app.getPath('userData'));
  installCrashHandlers({
    logger: log,
    crashDir: path.join(app.getPath('userData'), 'crash'),
  });

  // Python 后端已废弃：不再拉起，也不再等它的 health。
  if (app.isPackaged) {
    startUiServer();
    setupUpdater();
  }
  // T-119：菜单与更新入口不再只在打包态装——dev 也要同一份中文菜单（否则 Alt 唤出的是
  // Electron 默认英文菜单），更新入口在 dev 也要能回答"开发模式不检查更新"而不是报错。
  setupUpdateIpc();
  setupAppInfoIpc();
  setupTitleBarIpc();
  setupKeepAwakeIpc();
  setupVoiceHotIpc();
  buildMenu();
  // 窗口立即创建，不等后端：打包态 Python/FastAPI 导入要数秒，阻塞式等待
  // 会显著拖慢首窗。渲染层已有三态加载，后端就绪前展示加载态即可。
  createWindow();
  registerShortcuts();
  setupIamAuth();

  /* TS 智能体：唯一的内核。
     不再等任何后端就绪信号——令牌来自主进程自己的 IAM（./iam.js）。
     此前要等，是因为令牌得问后端 /api/iam/access-token，那条链已经迁走了。 */
  tsAgentHost = new TsAgentHost({
    log,
    getWindow: () => win,
    getWorkspace: readWorkspace,
  });
  tsAgentHost.setupIpc();
  setupAgentChoiceIpc();
  setupWorkspaceIpc();
  files.init({ getWorkspace: readWorkspace });
  setupFilesIpc();
  setupMemoryIpc();
  setupSettingsIpc();
  providers.init(app.getPath('userData'));
  setupProvidersIpc();
  store.init(app.getPath('userData'));
  setupStoreIpc();
  setupUsageIpc();
  catalog.init({ dir: path.join(__dirname, '..', 'data'), store, getWorkspace: readWorkspace });
  setupCatalogIpc();
  worktree.init({ dir: app.getPath('userData'), getWorkspace: readWorkspace });

  // S-04：本机行为（保持唤醒 / 语音快捷键）按主进程自己存的开关恢复，不再问后端
  syncLocalToggles();
  // S-23：内置浏览器命令改由渲染层直接经 IPC 下发，不再经后端轮询
  setupBrowserIpc();

  const r = await tsAgentHost.start().catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
  log.info('[electron] ts-agent:', JSON.stringify(r));
});

app.on('window-all-closed', () => {
  if (tsAgentHost) void tsAgentHost.stop(); // 子进程要跟着退出，不能残留
  if (uiServer) uiServer.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (tsAgentHost) void tsAgentHost.stop();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (uiServer) uiServer.close();
});
