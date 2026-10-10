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
const { ipcMain } = require('electron');
const { TsAgent, findNode, DEFAULT_MAX_STEPS } = require('./tsAgentCore');
const iam = require('./iam');

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
      // 用 core 导出的常量，不要在这里再写一份数字（此前是硬编码 12，改的时候漏过）
      maxSteps: Number(opts.maxSteps || DEFAULT_MAX_STEPS),
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
      this.log.info('[ts-agent] 就绪 | 工作区:', workspace, '| 档位:', policy);
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
    const r = await this.agent.prompt(sid, prompt, { model });
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
    if (!sid) return { ok: false, reason: '缺少 sessionId' };
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
    const up = await this.ensureSubprocess();
    if (!up.ok) return { ok: false, reason: up.reason, models: [] };
    try {
      const r = await this.agent.request('models/list', { force: !!force });
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e), models: [] };
    }
  }

  async stop() {
    if (!this.agent) return { ok: true };
    await this.agent.stop();
    this.agent = null;
    this.reason = '已停止';
    return { ok: true };
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
    const out = [];
    for (const n of names) {
      const id = n.replace(/\.jsonl$/, '');
      const events = await readSessionEvents(path.join(dir, n));
      if (!events) continue;
      const tsList = events.map((e) => Number(e && e.ts) || 0).filter((x) => x > 0);
      const first = events.find((e) => e && e.type === 'turn/start');
      const lastEnd = [...events].reverse().find((e) => e && e.type === 'turn/end');
      const goal = first ? String(first.prompt || '') : '';
      const renamed = [...events].reverse().find((e) => e && e.type === 'session/renamed');
      out.push({
        id,
        title: renamed ? String(renamed.title || '') : goal.split('\n')[0],
        goal,
        events: events.length,
        firstTs: tsList.length ? Math.min(...tsList) : 0,
        lastTs: tsList.length ? Math.max(...tsList) : 0,
        stop: lastEnd ? String(lastEnd.stop || '') : '',
        steps: lastEnd ? Number(lastEnd.steps || 0) : 0,
      });
    }
    out.sort((a, b) => b.lastTs - a.lastTs); // 最近用的在最前
    return { ok: true, sessions: out };
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
  }
}

module.exports = { TsAgentHost, agentDir };
