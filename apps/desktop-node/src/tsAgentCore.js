/**
 * TS 智能体的进程管理 + JSON-RPC 客户端（**不依赖 Electron**，可单独测试）。
 *
 * 为什么拆成"纯模块 + main.js 里的 IPC 桥"两段：
 * 主进程里塞了 electron 的 require 就没法在纯 Node 下跑测试，而"拉起子进程 / 收发协议 /
 * 转发事件"这条链路恰恰是最该被测的部分。所以这里只用 child_process 与 EventEmitter。
 *
 * 与 Python 后端的关系：**不经过它**。TS agent 直连 eva-ai（共用同一条通道与同一份
 * 模型白名单），Python 后端只负责把登录令牌递给主进程（见 tsAgent.js 的取令牌逻辑）。
 * 这样 Python 后端挂了，TS agent 仍然能干活——两套智能体互不依赖。
 */
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');

/* 一个 turn 的轮次上限。**必须与 agent-ts 的 `boot.ts#DEFAULT_MAX_STEPS` 同值**——
   这份是主进程侧（CommonJS，没法 import .ts），子进程侧还另有一份；
   两边不一致时，子进程会按 `--max-steps` 显式值走，主进程这份形同虚设。
   12 太紧：真实任务常在第 12 步被截断，用户只能点「继续」再发一轮。 */
const DEFAULT_MAX_STEPS = 100;

/* TS-054：TS 智能体要**真 Node** 才能跑（原生剥离 TS 类型需要 22.18+）。
   Electron 自带的那份不够：Electron 31 里是 Node 20，而且 `process.execPath`
   直接拿来 spawn 会拉起一个 GUI 窗口——这是"能启动但完全不对"的那类错。
   所以默认是找 PATH 上的 node，并**先验版本**：缺 Node / 版本不够都要说得清清楚楚，
   而不是起一个必然失败的进程让人去猜。 */
const NODE_MIN = { major: 22, minor: 18 };

function parseVersion(text) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(text || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function versionOk(v) {
  if (!v) return false;
  if (v.major !== NODE_MIN.major) return v.major > NODE_MIN.major;
  return v.minor >= NODE_MIN.minor;
}

/**
 * 找可用的 Node。返回 `{ bin, version }` 或 `{ reason }`。
 * `EVA_TS_NODE` 可指定绝对路径（打包分发时指向随包的运行时）。
 */
function findNode() {
  const override = (process.env.EVA_TS_NODE || '').trim();
  const candidates = override
    ? [override]
    : process.platform === 'win32'
      ? ['node.exe', 'node']
      : ['node', '/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node'];

  let found = null;
  for (const bin of candidates) {
    let r;
    try {
      r = spawnSync(bin, ['--version'], { windowsHide: true, timeout: 8000 });
    } catch (e) {
      continue;
    }
    if (!r || r.error || r.status !== 0) continue;
    const v = parseVersion(String(r.stdout || ''));
    if (!v) continue;
    if (versionOk(v)) return { bin, version: `v${v.major}.${v.minor}.${v.patch}` };
    // 记住"找到了但太旧"，好把版本号报出来（比只说"没找到 Node"有用得多）
    if (!found) found = { bin, version: `v${v.major}.${v.minor}.${v.patch}` };
  }
  const need = `Node ${NODE_MIN.major}.${NODE_MIN.minor}+`;
  return {
    reason: found
      ? `本机 Node 版本过低：${found.version}，TS 智能体需要 ${need}（可由 EVA_TS_NODE 指定其它运行时）`
      : `未找到可用的 ${need}（可由 EVA_TS_NODE 指定 node 路径）`,
  };
}

class TsAgent extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.entry      cli.ts 绝对路径
   * @param {string} opts.workspace  工作区根
   * @param {number} [opts.maxSteps]
   * @param {string} [opts.nodeBin]  默认 process.execPath
   * @param {object} [opts.env]      额外环境变量（EVA_AI_BASE_URL / EVA_AI_TOKEN 由此注入）
   */
  constructor(opts) {
    super();
    this.opts = opts || {};
    this.proc = null;
    this.buf = '';
    this.seq = 0;
    this.pending = new Map();
    this.ready = false;
  }

  get running() {
    return !!this.proc && this.proc.exitCode === null;
  }

  start() {
    if (this.running) return;
    const o = this.opts;
    const args = [
      o.entry,
      '--serve',
      '--workspace',
      o.workspace,
      '--max-steps',
      String(o.maxSteps || DEFAULT_MAX_STEPS),
    ];
    const childEnv = { ...process.env, ...(o.env || {}) };
    /* TS-055：把 resources 根目录递给子进程。
       agent 是被外部 Node 拉起的**普通进程**，它拿不到 Electron 的 `process.resourcesPath`
       ——那个字段只存在于主进程。打包后原生模块躺在 `resources/agent-ts/native/` 下，
       不递这个路径，TS-022b 那层沙箱在成品里就**凭空消失**且一声不吭。
       开发态没有 resourcesPath，子进程会退回仓库布局去找（那种布局本来就在）。 */
    if (process.resourcesPath) childEnv.EVA_TS_RESOURCES = process.resourcesPath;

    this.proc = spawn(o.nodeBin || process.execPath, args, {
      env: childEnv,
      // stdin 要写命令；stdout 是协议帧；stderr 走诊断（子进程自己不该往 stdout 打东西）
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.proc.stdout.on('data', (d) => this._onData(String(d)));
    this.proc.stderr.on('data', (d) => this.emit('stderr', String(d)));
    this.proc.on('error', (e) => this.emit('error', e));
    this.proc.on('exit', (code, sig) => {
      this.ready = false;
      // 子进程没了，所有在等的请求必须立刻失败——否则调用方会一直挂到超时
      for (const [, p] of this.pending) p.reject(new Error(`TS agent 已退出（code=${code} sig=${sig}）`));
      this.pending.clear();
      this.emit('exit', code, sig);
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let msg;
      try {
        msg = JSON.parse(t);
      } catch {
        // 协议帧坏了不能装没看见：它意味着 stdout 被别的输出污染了
        this.emit('protocol-error', t.slice(0, 200));
        continue;
      }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    // 通知：转成具名事件，调用方按需监听
    switch (msg.method) {
      case 'session.event':
        this.emit('event', msg.params);
        break;
      case 'session.status':
        this.emit('status', msg.params);
        break;
      // 流式正文：不落会话日志，只推给界面（"正在打字"）
      case 'session.text':
        this.emit('text', msg.params);
        break;
      /* 上下文用量（TS-065）：同样是**派生值、不落盘**的通知，转成具名事件给上层转发 */
      case 'context/usage':
        this.emit('usage', msg.params);
        break;
      default:
        this.emit('notification', msg);
    }
  }

  request(method, params, timeoutMs = 15000) {
    if (!this.running) return Promise.reject(new Error('TS agent 未运行'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** 握手即健康检查：能 initialize 就是活的（没有额外的 /health 口子）。 */
  async waitReady(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!this.running) throw new Error('TS agent 进程已退出');
      try {
        const info = await this.request('initialize', {}, 3000);
        this.ready = true;
        return info;
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`TS agent 就绪超时：${e.message}`);
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  newSession() {
    return this.request('session/new', {});
  }

  prompt(sessionId, text, opts = {}) {
    /* model / isolate 一起透传：子进程按**这一轮**的参数跑。
       此前只传 prompt，界面选的模型被主进程丢掉，模型下拉在 TS 模式下形同虚设。 */
    return this.request(
      'session/prompt',
      {
        sessionId,
        prompt: text,
        ...(opts.model ? { model: String(opts.model) } : {}),
      },
      15000,
    );
  }

  cancel(sessionId) {
    return this.request('session/cancel', { sessionId });
  }

  /** 停：先礼貌 shutdown，超时再 kill（协作式取消之后进程可能还在收尾）。 */
  async stop(graceMs = 3000) {
    if (!this.running) return;
    try {
      await this.request('shutdown', {}, 2000);
    } catch {
      /* 协议层已不可用，直接杀 */
    }
    await new Promise((resolve) => {
      if (!this.running) return resolve();
      const timer = setTimeout(() => {
        try { this.proc.kill(); } catch { /* 已退出 */ }
        resolve();
      }, graceMs);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

module.exports = { TsAgent, DEFAULT_MAX_STEPS, findNode, parseVersion, versionOk, NODE_MIN };
