/**
 * S-25：自定义模型通道（自带 Key / BYOK）。
 *
 * 通道与 Key 只存在**本机**（userData/providers.json）——它们本来就不该离开这台电脑，
 * 以前那份存在后端 kv 表里，后端一废弃，用户录的 Key 就跟着没了。
 *
 * 两条刻意的取舍：
 *  1. **列表里绝不回传完整 Key**，只给后 4 位（`key_hint`）。界面要显示"已录入"，
 *     不需要拿到原文；少一处传输就少一处泄露面。
 *  2. **测试用 GET /models 而不是发一条 chat**：验证 Key 有效性不该消耗用户的 token，
 *     而且 /models 是各家兼容得最好的一个端点。它返回 404 时才退回 chat/completions。
 */
const fs = require('fs');
const path = require('path');

let file = '';

function init(dir) {
  file = path.join(dir, 'providers.json');
}

function readAll() {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeAll(list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list));
}

/** 列表只暴露后 4 位：界面要的是"录了没"，不是原文。 */
function toItem(p) {
  const key = String(p.api_key || '');
  return {
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    model: p.model,
    enabled: p.enabled !== false,
    has_key: key.length > 0,
    key_hint: key ? `…${key.slice(-4)}` : '',
    created: p.created || 0,
  };
}

function list() {
  return { ok: true, items: readAll().map(toItem) };
}

/** 内部用：取一条通道的**完整**记录（含 api_key），供主进程做请求路由。
 *  **绝不**经 IPC 回传渲染层——给界面的一律走 `toItem`（只留后 4 位）。 */
function get(id) {
  return readAll().find((p) => p.id === id) || null;
}

function add(draft) {
  const d = draft || {};
  const base = String(d.base_url || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('缺少接口地址');
  if (!/^https?:\/\//i.test(base)) throw new Error('接口地址必须是 http(s)');
  const all = readAll();
  const item = {
    id: `prov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: String(d.name || '').trim() || '自定义通道',
    base_url: base,
    model: String(d.model || '').trim(),
    api_key: String(d.api_key || ''),
    enabled: d.enabled !== false,
    created: Date.now(),
  };
  all.push(item);
  writeAll(all);
  return { ok: true, item: toItem(item) };
}

function update(id, patch) {
  const all = readAll();
  const i = all.findIndex((p) => p.id === id);
  if (i < 0) throw new Error('通道不存在');
  const p = patch || {};
  if (p.name !== undefined) all[i].name = String(p.name || '').trim();
  if (p.base_url !== undefined) all[i].base_url = String(p.base_url || '').trim().replace(/\/+$/, '');
  if (p.model !== undefined) all[i].model = String(p.model || '').trim();
  if (p.enabled !== undefined) all[i].enabled = Boolean(p.enabled);
  // api_key 只在**真的传了非空值**时覆盖：传空串表示"不改动"，否则清空 Key 会静默发生
  if (p.api_key !== undefined && String(p.api_key || '') !== '') all[i].api_key = String(p.api_key);
  writeAll(all);
  return { ok: true, item: toItem(all[i]) };
}

function remove(id) {
  const all = readAll();
  const next = all.filter((p) => p.id !== id);
  if (next.length === all.length) throw new Error('通道不存在');
  writeAll(next);
  return { ok: true };
}

/** 真发一次请求验证这条通道。用 /models 不烧 token；它不支持才用 chat/completions。 */
async function test(draftOrId) {
  let base = '';
  let model = '';
  let key = '';
  const d = draftOrId || {};
  if (typeof d === 'string') {
    const p = readAll().find((x) => x.id === d);
    if (!p) return { ok: false, error: '通道不存在' };
    base = p.base_url;
    model = p.model;
    key = p.api_key;
  } else {
    base = String(d.base_url || '').trim().replace(/\/+$/, '');
    model = String(d.model || '').trim();
    key = String(d.api_key || '');
  }
  if (!base) return { ok: false, error: '缺少接口地址' };
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: '接口地址必须是 http(s)' };
  const headers = { Accept: 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;

  try {
    let res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15000) });
    if (res.status === 404) {
      // 没有 /models：用一条最小 chat 请求（max_tokens=1，几乎不烧 token）
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(20000),
      });
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = (j && (j.error?.message || j.message || j.detail)) || '';
      } catch {
        /* 非 JSON 就只报状态码 */
      }
      return { ok: false, status: res.status, error: detail || `通道返回 ${res.status}` };
    }
    const j = await res.json().catch(() => null);
    const n = Array.isArray(j && j.data) ? j.data.length : 0;
    return { ok: true, status: res.status, output: n ? `连通，可用模型 ${n} 个` : '连通' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { init, list, add, update, remove, test, get };