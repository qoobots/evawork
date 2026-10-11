/**
 * EVA IAM 登录（OAuth2 授权码 + PKCE）——**主进程自治版**。
 *
 * 为什么搬到这里：登录链路原本整个在后端（PKCE verifier、令牌换取、令牌存储、
 * refresh 轮换），而后端正在废弃。主进程接管之后，"能不能调模型"这件事的真相源
 * 回到了本机，不再依赖一个即将消失的进程。
 *
 * 流程（对应 eva-iam 的 /iam/oauth2/*）：
 *   1. 本机生成 PKCE code_verifier（永不外泄）→ S256 得 code_challenge；
 *   2. 系统浏览器打开 authorize（未登录会先被 IAM 重定向到控制台登录页）；
 *   3. IAM 302 回 http://127.0.0.1:<随机端口>/callback?code&state；
 *   4. 主进程用 verifier 证明持有，自己换回令牌；
 *   5. 调 /iam/auth/me 取用户画像，落盘本机文件，**进程重启仍登录**；
 *   6. access token 快过期时用 refresh_token 静默续期。
 *
 * 密码不经过本进程：浏览器是唯一接触用户密码的地方。
 * 诚实原则：连不上 IAM 就是连不上，不伪造登录态。
 *
 * 迁移期后果：老会话存在后端 SQLite（~/.evawork/evawork.db 的 iam:session），
 * 主进程读不了 SQLite（Electron 内置 Node 没有 node:sqlite），所以迁移后需要
 * **重新登录一次**。这是有意的取舍——为一个即将废弃的进程写 SQLite 读取不值得。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { shell } = require('electron');

const DEFAULT_CONFIG = {
  // 网关 API 根，与前端 eva-web 一致走 governance 前缀（网关 rewrite 到 /api/iam/**）
  server: 'http://localhost:8080/api/governance',
  client_id: 'eva-desktop',
  scope: 'openid profile',
};

const HTTP_TIMEOUT_MS = 20000;
/** 提前这么多秒把令牌当作过期，避免请求在飞行途中刚好越界。 */
const EXPIRE_SKEW_SEC = 60;
/** 一次登录允许花的时间：用户可能要输密码、过 MFA。 */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** 授权中的临时状态（state → verifier）只放内存，重启即作废。 */
const PENDING_TTL_MS = 10 * 60 * 1000;

let dir = null;
const pending = new Map();

// ---------------------------------------------------------------- 存储

/** 主进程自己存，不再借后端 SQLite：config 与 session 分开，后者是凭据。 */
function init(userDataDir) {
  dir = userDataDir;
}

function file_(name) {
  return path.join(dir || '.', name);
}

function readJson(name, fallback) {
  try {
    const raw = fs.readFileSync(file_(name), 'utf8');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file_(name), JSON.stringify(value, null, 2), 'utf8');
}

function config() {
  const stored = readJson('iam-config.json', {});
  const cfg = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    const v = stored[k];
    if (typeof v === 'string' && v.trim()) cfg[k] = v.trim();
  }
  cfg.server = cfg.server.replace(/\/+$/, '');
  return cfg;
}

function saveConfig(patch) {
  const cur = config();
  for (const k of ['server', 'client_id', 'scope']) {
    const v = patch && patch[k];
    if (typeof v === 'string' && v.trim()) cur[k] = v.trim().replace(/\/+$/, '');
  }
  writeJson('iam-config.json', { server: cur.server, client_id: cur.client_id, scope: cur.scope });
  return config();
}

function session() {
  const row = readJson('iam-session.json', null);
  return row && row.access_token ? row : null;
}

function writeSession(tokens, user) {
  const now = Date.now();
  const row = {
    access_token: tokens.access_token || '',
    refresh_token: tokens.refresh_token || '',
    // IAM 给的是秒；没有就按一小时保守估计，宁可早刷新也不要拿着过期令牌去请求
    expires_at: now + Number(tokens.expires_in || 3600) * 1000,
    refresh_expires_at: now + Number(tokens.refresh_expires_in || 0) * 1000,
    user: user || null,
    updated_at: now,
  };
  writeJson('iam-session.json', row);
  return row;
}

function clearSession() {
  try {
    fs.unlinkSync(file_('iam-session.json'));
  } catch {
    /* 本来就不存在 */
  }
  pending.clear();
}

// ---------------------------------------------------------------- HTTP

class IamError extends Error {}

/** server 可能是 http 也可能是 https，按 URL 选模块。 */
function request(method, url, { form, json, headers, token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    let body = '';
    const hdrs = { ...(headers || {}) };
    if (form) {
      body = new URLSearchParams(form).toString();
      hdrs['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (json !== undefined) {
      body = JSON.stringify(json);
      hdrs['Content-Type'] = 'application/json';
    }
    if (token) hdrs.Authorization = `Bearer ${token}`;
    if (body) hdrs['Content-Length'] = Buffer.byteLength(body);

    const req = mod.request(u, { method, headers: hdrs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* 网关可能返回纯文本 */
        }
        if (res.statusCode >= 400 || (parsed && parsed.error)) {
          const d =
            (parsed && (parsed.error_description || parsed.error || parsed.message)) ||
            `HTTP ${res.statusCode}`;
          reject(new IamError(d));
          return;
        }
        resolve(parsed !== null ? parsed : {});
      });
    });
    req.on('error', (e) => reject(new IamError(`连不上 EVA 服务（${u.origin}）：${e.message}`)));
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy();
      reject(new IamError(`连接 EVA 服务超时（${HTTP_TIMEOUT_MS}ms）`));
    });
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------- PKCE

/** 返回 (verifier, challenge)。verifier 留在本机，只把 challenge 送出。 */
function pkcePair() {
  const verifier = crypto.randomBytes(64).toString('base64url').slice(0, 96);
  const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return [verifier, challenge];
}

function cleanPending() {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  }
}

// ---------------------------------------------------------------- 登录流程

/** 生成授权 URL。redirect_uri 由调用方给出（回调监听端口是它开的）。 */
function authorizeUrl(redirectUri) {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(redirectUri || '')) {
    throw new IamError('回调地址必须是本机回环地址（127.0.0.1/localhost）');
  }
  cleanPending();
  const [verifier, challenge] = pkcePair();
  const state = crypto.randomBytes(24).toString('base64url');
  pending.set(state, { verifier, redirectUri, createdAt: Date.now() });
  const cfg = config();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.client_id,
    redirect_uri: redirectUri,
    scope: cfg.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { authorize_url: `${cfg.server}/iam/oauth2/authorize?${q}`, state };
}

function fetchUser(accessToken) {
  return request('GET', `${config().server}/iam/auth/me`, { token: accessToken }).then((body) => {
    const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : body;
    return typeof data === 'object' ? data : {};
  });
}

function exchangeCode(code, p) {
  return request('POST', `${config().server}/iam/oauth2/token`, {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: p.redirectUri,
      client_id: config().client_id,
      code_verifier: p.verifier,
    },
  }).then((body) => {
    if (!body || !body.access_token) throw new IamError('IAM 未返回 access_token');
    return body;
  });
}

async function completeLogin(code, state) {
  const p = pending.get(String(state || '').trim());
  if (!p) throw new IamError('登录会话已失效，请重新发起登录');
  pending.delete(String(state).trim());
  if (!String(code || '').trim()) throw new IamError('授权回调缺少 code');
  const tokens = await exchangeCode(String(code).trim(), p);
  let user = {};
  try {
    user = await fetchUser(tokens.access_token);
  } catch {
    /* 画像取不到不影响登录态：令牌本身是有效的，画像下次再补 */
  }
  writeSession(tokens, user);
  return accountState();
}

async function refreshSession() {
  const sess = session();
  if (!sess) throw new IamError('尚未登录');
  const rt = sess.refresh_token;
  if (!rt) {
    clearSession();
    throw new IamError('登录已过期，请重新登录');
  }
  let body;
  try {
    body = await request('POST', `${config().server}/iam/oauth2/token`, {
      form: { grant_type: 'refresh_token', refresh_token: rt },
    });
  } catch (e) {
    // 刷新令牌本身过期/被吊销 = 会话终态。清掉让用户重新登录，不留假登录态。
    clearSession();
    throw new IamError('登录已过期，请重新登录');
  }
  let user = sess.user || {};
  try {
    user = (await fetchUser(body.access_token)) || user;
  } catch {
    /* 沿用旧画像 */
  }
  writeSession(body, user);
  return accountState();
}

/** 给业务请求用的令牌；快过期就先续。拿不到返回 null（调用方自行降级）。 */
async function accessToken(autoRefresh = true) {
  const sess = session();
  if (!sess) return null;
  if (!autoRefresh || Date.now() < Number(sess.expires_at || 0) - EXPIRE_SKEW_SEC * 1000) {
    return sess.access_token;
  }
  try {
    await refreshSession();
  } catch {
    return null;
  }
  const s2 = session();
  return s2 ? s2.access_token : null;
}

/** 把 IAM 的 /auth/me 结果收敛成前端好展示的形状（与后端旧结构一致，界面不用改）。 */
function publicUser(user) {
  if (!user) return null;
  const username = String(user.username || '');
  const name = String(user.realName || user.nickname || '') || username;
  return {
    id: String(user.userId || ''),
    username,
    name,
    email: String(user.email || ''),
    phone: String(user.phone || ''),
    roles: Array.isArray(user.roles) ? user.roles : [],
    activeTenantId: user.activeTenantId ?? null,
    provider: 'iam',
    cloud: true,
  };
}

/**
 * 统一登录态。
 *
 * 登录态与"能否调用模型"必须是同一份事实：这里有令牌，模型通道才放行。
 * 所以用户画像缺失时先用令牌补一次 /auth/me；令牌确实失效（401/403）就清会话，
 * 别留下"界面显示未登录、智能体却还在用你的账号调模型"的错位。
 * 网络抖动不算失效，保持现状，不误伤在线用户。
 */
async function accountState() {
  const cfg = config();
  let sess = session();
  if (sess && !sess.user) {
    try {
      sess.user = await fetchUser(sess.access_token);
      writeJson('iam-session.json', sess);
    } catch (e) {
      const m = String((e && e.message) || e);
      if (m.includes('401') || m.includes('403')) {
        clearSession();
        sess = null;
      }
    }
  }
  return {
    logged_in: sess !== null,
    user: publicUser(sess && sess.user),
    cloud: true,
    provider: 'iam',
    server: cfg.server,
    client_id: cfg.client_id,
  };
}

function logout() {
  clearSession();
}

// ---------------------------------------------------------------- 模型通道裁决

/**
 * 模型通道配置：决定智能体连哪个网关、用哪个默认模型。
 *
 * 这段原样镜像**原后端** providerConfig() 的逻辑（那个 HTTP 后端包已删除）——
 * TS 子进程靠 EVA_AI_BASE_URL / EVA_AI_TOKEN 连模型网关，这两个值以前由后端算，
 * 后端废弃后必须在这里算，否则"登录正常但智能体连不上模型"。
 */
/* eva-ai 已由**按量付费**改成**包月套餐**：通道 `/api/ai/v1/models` 给每条模型标了
   `channel`（`payg` 按量 / `tokenplan` 包月），按量通道没配 base-url 与 api-key，
   调它名下的模型一律 `503 模型通道未配置`。
   所以默认模型必须落在套餐内——继续用按量档（qwen-plus 那批）等于每次任务都失败。
   退化链同理：备选也只能是同套餐的模型，跨通道退没有意义。 */
const DEFAULT_EVA_MODEL = 'qwen3.7-plus';
const DEFAULT_EVA_ROUTES = ['qwen3.8-flash', 'qwen3.8-max'];

function providerConfig() {
  const disabled = ['0', 'false', 'no', 'off'].includes(
    String(process.env.EVAWORK_LLM_ENABLED || '').trim().toLowerCase(),
  );
  const provider = String(process.env.EVAWORK_LLM_PROVIDER || '').trim().toLowerCase() || 'eva';

  if (provider === 'openai') {
    const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
    const baseUrl =
      String(process.env.OPENAI_BASE_URL || '').trim().replace(/\/+$/, '') || 'https://api.openai.com/v1';
    const model =
      String(process.env.EVAWORK_MODEL || '').trim() ||
      String(process.env.OPENAI_MODEL || '').trim() ||
      'gpt-4o-mini';
    return { enabled: Boolean(apiKey) && !disabled, base_url: baseUrl, token: apiKey, default_model: model, needToken: false };
  }

  const cfg = config();
  const server = String(cfg.server || '').replace(/\/+$/, '');
  // governance 是网关前缀，模型 API 在网关根的 /api/ai 下，要剥掉
  const root = server.endsWith('/api/governance')
    ? server.slice(0, -'/api/governance'.length)
    : server;
  const baseUrl =
    String(process.env.EVA_AI_BASE_URL || '').trim().replace(/\/+$/, '') || `${root}/api/ai/v1`;
  const model = String(process.env.EVAWORK_MODEL || '').trim() || DEFAULT_EVA_MODEL;
  return { enabled: false, base_url: baseUrl, token: '', default_model: model, needToken: true };
}

/** 给 TS 智能体的直连凭据：{ ok, token, base_url, model, routes, source, reason }。 */
async function resolveForAgent(preferred = 'auto') {
  const pc = providerConfig();
  let token = pc.token;
  let enabled = pc.enabled;
  if (pc.needToken) {
    token = (await accessToken()) || '';
    enabled = Boolean(token);
  }
  const wanted = String(preferred || '').trim() || 'auto';
  let source = 'auto:channel-default';
  if (wanted.startsWith('custom:')) source = 'custom';
  else if (wanted !== 'auto') source = 'explicit';
  /* 回落路由：首选挂了（典型是它已随套餐下架 → 503 通道未配置）才轮到这些，
     且只在**一个字都还没吐出去**时换（见 agent-ts llm.ts）。全部同属包月套餐。 */
  const routes = [...DEFAULT_EVA_ROUTES];
  if (!enabled || !token) {
    return { ok: false, model: '', base_url: '', token: '', routes, source, reason: '模型通道未就绪（未登录或无可用模型）' };
  }
  return { ok: true, model: pc.default_model, base_url: pc.base_url, token, routes, source, reason: '' };
}

// ---------------------------------------------------------------- 浏览器登录

function respondHtml(res, statusCode, html) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function pageResult(ok, message) {
  const color = ok ? '#0f9d58' : '#d93025';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>EVA 登录</title>
<body style="font-family:-apple-system,'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6f7">
<div style="text-align:center;padding:32px 40px;background:#fff;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.08);max-width:420px">
<div style="font-size:36px;line-height:1;color:${color}">${ok ? '&#10003;' : '&#10007;'}</div>
<h2 style="margin:16px 0 8px;font-size:18px;color:#1f2328">${ok ? '登录成功' : '登录失败'}</h2>
<p style="margin:0;color:#5b6470;font-size:14px;line-height:1.6">${message}</p>
</div></body></html>`;
}

/**
 * 发起一次浏览器登录：开回环端口 → 开浏览器 → 等 /callback?code&state → 换令牌。
 * @param {(payload: object) => void} emit 登录结果回传渲染层（跨窗口同步用）
 * @param {{info: (...a: any[]) => void} | null} log 主进程日志器
 */
async function startLogin(emit = () => {}, log = null) {
  const logf = (...a) => { if (log && log.info) log.info('[iam]', ...a); };
  const server = http.createServer();
  let settled = false;
  const close = () => {
    try {
      server.close();
    } catch {
      /* 已关闭 */
    }
  };

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // 端口 0 = 交给操作系统分配空闲端口，避免多人同时登录抢同一个回调端口
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  logf('loopback listening on port', port);

  let started;
  try {
    started = authorizeUrl(redirectUri);
  } catch (e) {
    close();
    throw new Error(`无法启动登录：${e.message}`);
  }
  logf('authorize_url:', started.authorize_url);
  await shell.openExternal(started.authorize_url);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      close();
      reject(new Error('登录超时：未在浏览器中完成登录'));
    }, LOGIN_TIMEOUT_MS);

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      fn(arg);
    };

    server.on('request', async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      logf('callback hit:', req.url);
      if (url.pathname !== '/callback') {
        respondHtml(res, 404, pageResult(false, '未知回调路径'));
        return;
      }
      const err = url.searchParams.get('error');
      if (err) {
        respondHtml(res, 200, pageResult(false, `授权端点返回错误：${err}`));
        finish(reject, new Error(err));
        return;
      }
      try {
        const state = await completeLogin(url.searchParams.get('code') || '', url.searchParams.get('state') || '');
        respondHtml(res, 200, pageResult(true, '可以关闭这个标签页，回到 EvaWork 继续。'));
        logf('token exchange ok, logged_in:', state.logged_in);
        finish(resolve, state);
        emit(state);
      } catch (e) {
        const msg = (e && e.message) || '未知错误';
        respondHtml(res, 200, pageResult(false, msg));
        finish(reject, new Error(msg));
      }
    });
  });
}

module.exports = {
  init,
  IamError,
  startLogin,
  accountState,
  accessToken,
  logout,
  config,
  saveConfig,
  refreshSession,
  providerConfig,
  resolveForAgent,
};
