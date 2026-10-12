/**
 * TS 智能体在 Electron 侧的挂载（TS-011）：取令牌 → 拉起子进程 → 把协议桥成 IPC。
 *
 * 分工：
 *   tsAgentCore.js  纯进程/协议逻辑（可单测，不含 electron）
 *   本文件         electron 相关：取令牌、工作区、IPC 暴露、生命周期挂在窗口上
 *
 * 两条刻意的取舍：
 *  1. **令牌只在启动子进程那一刻注入环境变量**，主进程不留副本、不落盘。
 *     TS agent 自始至终不自持登录态（两套智能体的存储必须分开）。
 *  2. 未登录就**不启动**并把原因说清楚，而不是起一个"能跑但一调用就报错"的空壳——
 *     后者最坑：界面上看着是活的，实际每次都说模型不可用。
 *
 * 令牌来源：主进程自己的 IAM（./iam.js），**不再问后端**。
 * 后端正在废弃，而它是令牌的唯一持有者，不搬过来就等于"后端一停、智能体就死"。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcMain, shell, app } = require('electron');
const { TsAgent, findNode } = require('./tsAgentCore');
const iam = require('./iam');
const providers = require('./providers');

/** TS 智能体源码目录：打包态在 resources/agent-ts，开发期回退到仓库里的 apps/agent-ts。 */
function agentDir() {
  const packed = path.join(process.resourcesPath || '', 'agent-ts');
  if (packed && fs.existsSync(packed)) return packed;
  // apps/desktop-node/src → ../../agent-ts（同一个 apps/ 下的兄弟包）
  return path.resolve(__dirname, '..', '..', 'agent-ts');
}

/** 会话日志目录。与 agent-ts `query.ts` 的 sessionsDir() 必须指向同一处，
 *  否则主进程读到的历史和子进程写下的就不是同一份。 */
function sessionsHome() {
  const os = require('os');
  const home = String(process.env.EVA_TS_HOME || '').trim() || path.join(os.homedir(), '.evawork', 'ts-agent');
  return path.join(home, 'sessions');
}

/**
 * 调试模式（trace）开关：与 UI「上下文与记忆」页的开关是同一份设置。
 * 落在通用 KV（settings.json）的 `trace` 或 `toggles.trace` 上——UI 深度 watch 自动写回，
 * 这里只负责**读**：UI 先把新值落盘再重拉子进程，所以读到的总是最新值。
 */
function traceEnabledBySetting() {
  try {
    const file = path.join(app.getPath('userData'), 'settings.json');
    const s = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    return !!(s && s.trace) || !!(s && s.toggles && s.toggles.trace);
  } catch {
    return false;
  }
}

/**
 * trace 目录：必须与 agent-ts `llm.ts` 的 `traceRequest` **逐字一致**，否则打开的是
 * 另一个目录（用户会以为没留痕）。EVA_TS_TRACE_DIR 优先，否则 homeDir()/trace
 * （homeDir = EVA_TS_HOME 或 ~/.evawork/ts-agent）。
 */
function traceDirForShell() {
  const dir = (process.env.EVA_TS_TRACE_DIR || '').trim();
  if (dir) return dir;
  const home = (process.env.EVA_TS_HOME || '').trim() || path.join(os.homedir(), '.evawork', 'ts-agent');
  return path.join(home, 'trace');
}

/** 用户自带的通道（BYOK）→ 模型清单条目：id 用 `custom:<通道 id>`，
 *  选中它就按这条通道自己的地址与 Key 发请求（见 customRoute）。
 *  它们排在平台精选**之前**——用户自己加的，是用户最想看见的那几个。 */
function customModels() {
  try {
    return providers
      .list()
      .items.filter((p) => p.enabled)
      .map((p) => ({
        id: `custom:${p.id}`,
        name: p.name || p.model || p.base_url,
        desc: [p.model, p.base_url].filter(Boolean).join(' · ') || '自带通道',
        abilities: ['text'],
        custom: true,
      }));
  } catch {
    return []; // 读不到通道就当没有——不该因为一个坏文件让整份清单不可用
  }
}

/** `custom:<id>` → 该通道的地址 / Key / 真实模型名。
 *  通道不在或没配全就**抛成句的错**，而不是把 `custom:xxx` 当模型名发给平台
 *  （那样只会得到一句莫名其妙的 400，用户查不出是自己这儿没配好）。 */
function customRoute(model) {
  const m = String(model || '');
  if (!m.startsWith('custom:')) return null;
  const id = m.slice('custom:'.length);
  const p = providers.get(id);
  if (!p) throw new Error(`自定义通道不存在：${id}（可能已被移除）`);
  if (p.enabled === false) throw new Error(`自定义通道「${p.name || id}」已停用`);
  if (!p.base_url) throw new Error(`自定义通道「${p.name || id}」缺少接口地址`);
  if (!p.model) throw new Error(`自定义通道「${p.name || id}」还没填模型名`);
  return { baseUrl: p.base_url, token: p.api_key || '', model: p.model };
}

/** 读一个会话的日志；坏行跳过（写到一半崩了的行不该让整份历史报废）。
 *  读不到返回 null，由调用方决定"跳过"还是"报错"。 */
async function readSessionEvents(file) {
  let raw = '';
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

class TsAgentHost {
  constructor({ log, getWindow, getWorkspace }) {
    this.log = log;
    this.getWindow = getWindow || (() => null);
    this.getWorkspace = getWorkspace || (() => '');
    this.agent = null;
    this.reason = '未启动';
    this.lastWorkspace = '';
  }

  get running() {
    return !!(this.agent && this.agent.running);
  }

  /** 把子进程事件推给渲染层（窗口可能还没建/已销毁，两种情况都要容忍）。 */
  push(payload) {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('evawork:ts-agent', payload);
      } catch (e) {
        this.log.warn('[ts-agent] 推送事件失败：', e && e.message);
      }
    }
  }

  async start(opts = {}) {
    if (this.running) return { ok: true, alreadyRunning: true };

    // 1. 取令牌与模型通道（主进程自己的 IAM，不再问后端）
    let cred = { token: '', base_url: '', model: '', routes: [], reason: '' };
    try {
      const r = await iam.resolveForAgent();
      if (r.ok) {
        cred = {
          token: r.token || '',
          base_url: r.base_url || '',
          model: r.model || '',
          routes: r.routes || [],
          reason: '',
        };
      } else {
        cred.reason = r.reason || '模型通道未就绪';
      }
    } catch (e) {
      cred.reason = `取令牌失败：${(e && e.message) || e}`;
    }
    if (!cred.token) {
      this.reason = cred.reason || '未登录 EVA 账号';
      this.log.warn('[ts-agent] 未启动：', this.reason);
      return { ok: false, reason: this.reason };
    }

    // 2. 工作区：主进程自己存的那份（不再问后端），没设过就退回当前目录
    const workspace = opts.workspace || this.getWorkspace() || process.cwd();
    this.lastWorkspace = workspace;

    const entry = path.join(agentDir(), 'src', 'cli.ts');
    if (!fs.existsSync(entry)) {
      this.reason = `找不到 TS 智能体入口：${entry}`;
      this.log.error('[ts-agent]', this.reason);
      return { ok: false, reason: this.reason };
    }

    /* TS-054：先确认**有能跑它的 Node**，再谈启动。
       顺序刻意放在入口检查之后：入口都没有时，"缺 Node"只是次要噪音。 */
    const node = findNode();
    if (!node.bin) {
      this.reason = node.reason;
      this.log.warn('[ts-agent] 未启动：', this.reason);
      return { ok: false, reason: this.reason };
    }
    this.nodeVersion = node.version;

    const agent = new TsAgent({
      entry,
      workspace,
      nodeBin: node.bin, // TS-054：必须是真 Node，不能用 Electron 自己
      // 令牌只从这里进子进程，主进程不留副本
      env: {
        EVA_AI_BASE_URL: cred.base_url,
        EVA_AI_TOKEN: cred.token,
        // TS-058：模型由**后端裁决**后递过来（不是这里拼的，也没有硬编码兜底），
        // 降级链一并注入——备用模型只在请求阶段失败时才轮到，且只换同通道的模型。
        ...(cred.model ? { EVA_AI_MODEL: cred.model } : {}),
        ...(Array.isArray(cred.routes) && cred.routes.length
          ? { EVA_AI_ROUTES: cred.routes.join(',') }
          : {}),
        /* 调试模式（trace）：勾上「调试模式」开关＝给 agent 注入 EVA_TS_TRACE，
           每次模型调用的完整请求体（system 提示词 + 压缩后的消息 + 工具）落盘到
           trace 目录，调提示词时复盘用。环境变量只在**启动那一刻**读取，
           所以开关要生效必须由 UI 侧重拉子进程（restart）——这里只在拉起时读一次。 */
        ...(traceEnabledBySetting() ? { EVA_TS_TRACE: '1' } : {}),
      },
    });

    agent.on('stderr', (s) => this.log.info('[ts-agent]', String(s).trim().slice(0, 400)));
    agent.on('protocol-error', (s) => this.log.error('[ts-agent] 协议帧损坏：', s));
    agent.on('event', (p) => this.push({ kind: 'event', ...p }));
    agent.on('status', (p) => this.push({ kind: 'status', ...p }));
    agent.on('text', (p) => this.push({ kind: 'text', ...p }));
    /* 上下文用量（TS-065）：派生值、不落盘，只推给界面做输入框下方那条监控 */
    agent.on('usage', (p) => this.push({ kind: 'usage', ...p }));
    agent.on('exit', (code) => {
      this.push({ kind: 'exit', code });
      this.log.info('[ts-agent] 子进程退出', code);
    });
    agent.on('error', (e) => this.log.error('[ts-agent] 进程错误：', e && e.message));

    agent.start();
    try {
      const info = await agent.waitReady(15000);
      this.agent = agent;
      this.reason = 'ok';
      this.log.info('[ts-agent] 就绪 | 工作区:', workspace);
      this.push({ kind: 'ready', protocol: info.protocolVersion, workspace });
      return { ok: true, workspace, protocol: info.protocolVersion };
    } catch (e) {
      this.reason = `就绪超时：${(e && e.message) || e}`;
      try { await agent.stop(1000); } catch { /* 已经没救了 */ }
      this.log.error('[ts-agent]', this.reason);
      return { ok: false, reason: this.reason };
    }
  }

  async ensureSession(sessionId) {
    if (!this.running) throw new Error(`TS 智能体未运行（${this.reason}）`);
    if (sessionId) return sessionId;
    const r = await this.agent.newSession();
    return r.sessionId;
  }

  async prompt({ sessionId, prompt, model }) {
    if (!this.running) {
      const r = await this.start().catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
      if (!r || !r.ok) throw new Error((r && r.reason) || 'TS 智能体启动失败');
    }
    const sid = await this.ensureSession(sessionId);
    /* S-25：自带通道（`custom:<id>`）用它自己的地址与 Key——凭据由主进程持有
       （userData/providers.json），只在**这一轮**经协议递给子进程：
       子进程不自持登录态、不落盘，EVA 令牌也不必为此暴露。 */
    const route = customRoute(model);
    const r = await this.agent.prompt(sid, prompt, route ? { ...route } : { model });
    /* SDK 的 session/prompt 应答是 {sessionId, accepted:true}，**没有 ok 字段**；
       而渲染层契约（tsChannel.ts）查的是 r.ok——不在这里补上映射，
       每条消息都会被当成"未接受该请求"。这个断层从 TS-052 起就在：
       脚本直连 SDK 的验证永远测不到它，只有从界面真发一条才会现形。 */
    return { ok: true, ...r, sessionId: sid };
  }

  async cancel({ sessionId }) {
    if (!this.running) throw new Error('TS 智能体未运行');
    return await this.agent.cancel(sessionId);
  }

  /**
   * 撤销回滚点（TS-060）、隔离操作（TS-061）、模型清单（models/list）都要走 SDK，
   * 而子进程可能没在跑（用户切走过、或任务早结束了）。这时**临时拉起**——
   * 拉不起来才如实说不能做，而不是甩一句"未运行"。
   */
  async ensureSubprocess() {
    if (this.running) return { ok: true };
    const r = await this.start().catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
    if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || `TS 智能体未运行（${this.reason}）` };
    return { ok: true };
  }

  /**
   * 上下文用量（TS-065）：**没在跑的时候也要能看**（回放旧会话、刚打开任务页），
   * 所以跟回滚点一样按需临时拉起子进程——它是从落盘日志重投影算出来的，
   * 与真实请求用的是同一份口径，所以界面上的数字不会和实际占用对不上。
   */
  async contextUsage({ sessionId }) {
    const sid = String(sessionId || '').trim();
    /* 空 sessionId 照查：新建任务页还没有会话，但"系统提示词 + 工具/MCP"的占用是实打实的，
       算出来就是这次请求的基线。拦在这里等于让界面永远拿不到数据、画不出那个圆环。 */
    const up = await this.ensureSubprocess();
    if (!up.ok) return { ok: false, reason: up.reason };
    try {
      const r = await this.agent.request('context/usage', { sessionId: sid });
      return { ok: true, usage: r };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  /**
   * 模型清单（模型广场同步）：界面打开输入框就要能选模型，**不该先跑一个任务**才有，
   * 所以同样按需临时拉起子进程——子进程持有 EVA_AI_BASE_URL/EVA_AI_TOKEN。
   * Python 后端废弃后，这是模型清单的唯一来源。
   */
  async models({ force } = {}) {
    const custom = customModels();
    const up = await this.ensureSubprocess();
    if (!up.ok) {
      /* 子进程起不来（典型是未登录 EVA）时，用户**自带**的通道仍要能用——
         它们本来就是"不登录也能跑"那条路，不该被 EVA 通道的失败一起带走。 */
      if (custom.length) {
        return { ok: true, models: custom, source: 'local', reason: `EVA 模型清单不可用：${up.reason}` };
      }
      return { ok: false, reason: up.reason, models: [] };
    }
    try {
      const r = await this.agent.request('models/list', { force: !!force });
      return { ok: true, ...r, models: [...custom, ...(Array.isArray(r.models) ? r.models : [])] };
    } catch (e) {
      const reason = String((e && e.message) || e);
      if (custom.length) return { ok: true, models: custom, source: 'local', reason: `EVA 模型清单不可用：${reason}` };
      return { ok: false, reason, models: [] };
    }
  }

  async stop() {
    if (!this.agent) return { ok: true };
    await this.agent.stop();
    this.agent = null;
    this.reason = '已停止';
    return { ok: true };
  }

  /**
   * 重拉子进程：调试（trace）开关改了要立刻生效，而 EVA_TS_TRACE 只在启动时注入，
   * 只能重拉。会话全部落盘，重启不掉数据；正在跑的请求由调用方自行处理
   * （设置页极少在任务进行中切开关）。
   */
  async restart() {
    await this.stop();
    return await this.start();
  }

  status() {
    return { running: this.running, ready: !!(this.agent && this.agent.ready), reason: this.reason, workspace: this.lastWorkspace };
  }

  /** 回放一个 TS 会话（TS-051）：**直接读落盘 JSONL**，不依赖子进程在不在跑——
   *  事件日志是真相源，回看就是从它重建；就算用户已切回 Python 智能体、
   *  TS 子进程早已退出，历史也必须能看。 */
  async replay(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(sid)) return { ok: false, reason: '会话 id 不合法' };
    const file = path.join(sessionsHome(), `${sid}.jsonl`);
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const events = raw.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      return { ok: true, events };
    } catch {
      return { ok: false, reason: '找不到该会话的本地记录（可能已被清理）' };
    }
  }

  /**
   * 侧栏会话列表。**直接读落盘目录**，跟 replay 同源——
   *
   * 后端废弃后侧栏的真相源就是这份会话目录（以前是后端库）。
   * 刻意不走子进程 RPC：用户没登录、子进程没拉起来时，侧栏也得能翻旧账；
   * 走 RPC 的话那种情况下侧栏就是空的，看着像"历史丢了"。
   *
   * 摘要逻辑与 agent-ts `query.ts` 的 summarize() 保持一致
   * （标题取最后一条改名记录，否则取首个目标的首行），两边不同步就会
   * 出现"列表里叫 A、点进去叫 B"。
   */
  async listSessions() {
    const dir = sessionsHome();
    let names = [];
    try {
      names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return { ok: true, sessions: [] }; // 还没有任何会话
    }
    const flat = [];
    for (const n of names) {
      const id = n.replace(/\.jsonl$/, '');
      const events = await readSessionEvents(path.join(dir, n));
      if (!events) continue;
      const tsList = events.map((e) => Number(e && e.ts) || 0).filter((x) => x > 0);
      const first = events.find((e) => e && e.type === 'turn/start');
      const lastEnd = [...events].reverse().find((e) => e && e.type === 'turn/end');
      const goal = first ? String(first.prompt || '') : '';
      const renamed = [...events].reverse().find((e) => e && e.type === 'session/renamed');
      /* 空壳会话：只落了 session/meta、还没写 turn/start 就崩了（例如技能目录解析失败）。
         它既没目标也没标题，侧栏只能回退显示 id（ts-xxx），看着像凭空多出一个任务——
         没有内容可看的条目不进列表。 */
      if (!goal.trim() && !renamed && events.length <= 1) continue;
      // 层级关系：优先读 session/meta，旧会话按 `-sub-<n>` 文件名兜底（与 agent-ts query.ts 同逻辑）
      const meta = events.find((e) => e && e.type === 'session/meta');
      let parentId = meta ? (meta.parentId || null) : null;
      let kind = meta ? String(meta.kind || 'root') : 'root';
      if (!parentId && /-sub-\d+$/.test(id)) {
        parentId = id.replace(/-sub-\d+$/, '');
        kind = 'subtask';
      }
      flat.push({
        id,
        title: renamed ? String(renamed.title || '') : goal.split('\n')[0],
        goal,
        events: events.length,
        firstTs: tsList.length ? Math.min(...tsList) : 0,
        lastTs: tsList.length ? Math.max(...tsList) : 0,
        stop: lastEnd ? String(lastEnd.stop || '') : '',
        steps: lastEnd ? Number(lastEnd.steps || 0) : 0,
        parentId,
        kind,
        children: [],
        childCount: 0,
      });
    }
    // 构建父子树：默认只把根任务放进列表，子任务作为 children 嵌套（24 号方案 G2）
    const byId = new Map(flat.map((s) => [s.id, s]));
    const roots = [];
    for (const s of flat) {
      if (s.parentId && byId.has(s.parentId)) {
        byId.get(s.parentId).children.push(s);
      } else {
        roots.push(s);
      }
    }
    for (const s of flat) s.childCount = s.children.length;
    const byTs = (a, b) => b.lastTs - a.lastTs;
    for (const s of roots) s.children.sort(byTs);
    roots.sort(byTs); // 最近用的在最前
    return { ok: true, sessions: roots, tree: true };
  }

  /** 改名：追加一条 `session/renamed` 事件（与 agent-ts renameSession 同形状）。 */
  async renameSession(sessionId, title) {
    const sid = String(sessionId || '').trim();
    const t = String(title || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(sid)) return { ok: false, reason: '会话 id 不合法' };
    if (!t) return { ok: false, reason: '标题不能为空' };
    const file = path.join(sessionsHome(), `${sid}.jsonl`);
    try {
      await fs.promises.appendFile(file, `${JSON.stringify({ type: 'session/renamed', title: t, ts: Date.now() })}\n`);
      return { ok: true, sessionId: sid, title: t };
    } catch (e) {
      return { ok: false, reason: `改名失败：${(e && e.message) || e}` };
    }
  }

  /** 删除会话日志。正在跑的会话由调用方先停——这里只如实回报删没删成。 */
  async deleteSession(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(sid)) return { ok: false, reason: '会话 id 不合法' };
    try {
      await fs.promises.unlink(path.join(sessionsHome(), `${sid}.jsonl`));
      return { ok: true, sessionId: sid, deleted: true };
    } catch (e) {
      /* 文件本就不在（从未落盘 / 已被删过）：删除是**幂等**的——目标是"它不在了"，
         这一点已经达成，不能报成失败。否则侧栏那条没有会话文件的幽灵任务永远删不掉。 */
      if (e && e.code === 'ENOENT') return { ok: true, sessionId: sid, deleted: true };
      return { ok: false, reason: `删除失败：${(e && e.message) || e}` };
    }
  }

  /** 全文搜索会话（跨会话 / 限会话内）。命中带上下文片段，方便一眼看懂。 */
  async searchSessions(term, sessionId) {
    const q = String(term || '').trim().toLowerCase();
    if (!q) return { ok: true, hits: [] };
    const dir = sessionsHome();
    let ids = [];
    if (String(sessionId || '').trim()) {
      ids = [String(sessionId).trim()];
    } else {
      try {
        ids = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.jsonl')).map((n) => n.replace(/\.jsonl$/, ''));
      } catch {
        ids = [];
      }
    }
    const hits = [];
    for (const id of ids) {
      const events = await readSessionEvents(path.join(dir, `${id}.jsonl`));
      if (!events) continue;
      for (const e of events) {
        const text = JSON.stringify(e);
        const at = text.toLowerCase().indexOf(q);
        if (at < 0) continue;
        hits.push({
          id,
          seq: Number(e && e.seq) || 0,
          ts: Number(e && e.ts) || 0,
          type: String((e && e.type) || ''),
          snippet: text.slice(Math.max(0, at - 60), at + q.length + 120),
        });
        if (hits.length >= 200) break;
      }
      if (hits.length >= 200) break;
    }
    return { ok: true, hits };
  }

  /** 注册 IPC。渲染层一律走 invoke（有返回值），事件走 'evawork:ts-agent' 推送。 */
  setupIpc() {
    ipcMain.handle('evawork:ts-agent-status', () => this.status());
    ipcMain.handle('evawork:ts-agent-start', (_e, opts) => this.start(opts || {}));
    ipcMain.handle('evawork:ts-agent-prompt', (_e, a) => this.prompt(a || {}));
    ipcMain.handle('evawork:ts-agent-cancel', (_e, a) => this.cancel(a || {}));
    ipcMain.handle('evawork:ts-agent-stop', () => this.stop());
    ipcMain.handle('evawork:ts-agent-replay', (_e, a) => this.replay(String((a && a.sessionId) || '')));
    /* 侧栏历史：列表 / 改名 / 删除 / 搜索，全部直接读写落盘会话目录，
       不经子进程——历史回看不该依赖"子进程这一刻在不在"。 */
    ipcMain.handle('evawork:ts-agent-sessions', () => this.listSessions());
    ipcMain.handle('evawork:ts-agent-session-rename', (_e, a) => this.renameSession(String((a && a.sessionId) || ''), String((a && a.title) || '')));
    ipcMain.handle('evawork:ts-agent-session-delete', (_e, a) => this.deleteSession(String((a && a.sessionId) || '')));
    ipcMain.handle('evawork:ts-agent-session-search', (_e, a) => this.searchSessions(String((a && a.term) || ''), (a && a.sessionId) || ''));
    ipcMain.handle('evawork:ts-agent-context-usage', (_e, a) => this.contextUsage(a || {}));
    /* 模型清单（模型广场同步）。与 context-usage 同理：按需临时拉起子进程。 */
    ipcMain.handle('evawork:ts-agent-models', (_e, a) => this.models(a || {}));
    /* 调试模式（trace）：重拉子进程以套用最新的 EVA_TS_TRACE 环境变量。 */
    ipcMain.handle('evawork:ts-agent-restart', () => this.restart());
    /* 打开 trace 目录（系统文件管理器）。落点须与 agent-ts llm.ts 的 traceRequest 逐字一致。 */
    ipcMain.handle('evawork:open-trace-dir', async () => {
      const dir = traceDirForShell();
      try {
        fs.mkdirSync(dir, { recursive: true });
        const err = await shell.openPath(dir);
        return err ? { ok: false, reason: err } : { ok: true, path: dir };
      } catch (e) {
        return { ok: false, reason: String((e && e.message) || e) };
      }
    });
  }
}

module.exports = { TsAgentHost, agentDir };
