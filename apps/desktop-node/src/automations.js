/**
 * 自动化（T-013/T-093）：条目与执行历史存本机（store），cron 预览**真解析**。
 *
 * 为什么 cron 要自己算而不是随便返回个 ok：这个预览存在的唯一目的就是
 * "保存前先看清会什么时候跑"。返回假的触发时刻，用户会以为设对了，
 * 等真到点没跑才发现——那比没有预览更糟。所以这里做真的下一次触发时刻计算。
 *
 * **不实现调度执行**：本地没有一个"应用没打开也要跑"的调度器（那需要系统级
 * 定时器/常驻服务），硬做只会得到一个"开着应用才偶尔生效"的假调度。
 * 条目能存、能预览，执行历史如实为空，界面照实说明。
 */
const store = require('./store');

const ALL = '全部';

/** 字段范围：[最小, 最大]。cron 五位：分 时 日 月 周。 */
const FIELDS = [
  { key: 'minute', min: 0, max: 59 },
  { key: 'hour', min: 0, max: 23 },
  { key: 'dom', min: 1, max: 31 },
  { key: 'month', min: 1, max: 12 },
  { key: 'dow', min: 0, max: 7 },
];

/** 解析一个字段：星号 / 星号加步长 / 范围 / 范围加步长 / 逗号枚举。非法抛错。
 *  注意别在注释里写 "星号紧跟斜杠" 的字样——那会提前闭合这段块注释。 */
function parseField(raw, { min, max }, name) {
  const s = String(raw || '').trim();
  if (!s) throw new Error(`${name}不能为空`);
  const values = new Set();
  for (const part of s.split(',')) {
    const p = part.trim();
    if (!p) throw new Error(`${name}里有空项`);
    const [range, stepRaw] = p.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1 || step > max) throw new Error(`${name}的步长不合法：${stepRaw}`);
    let lo;
    let hi;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = Number(a);
      hi = Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`${name}的范围不合法：${range}`);
    } else {
      lo = Number(range);
      hi = stepRaw === undefined ? lo : max;
    }
    /* 必须先判数字：Number('abc') 是 NaN，而 NaN 参与的大小比较全是 false，
       不单独拦就会静默得到一个"永不触发"的表达式，用户还以为自己设对了。 */
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`${name}不是合法数字：${range}`);
    if (lo < min || hi > max || lo > hi) throw new Error(`${name}超出范围（${min}-${max}）：${p}`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  // 周日既可以是 0 也可以是 7
  if (name === '周' && values.has(7)) values.add(0);
  return values;
}

function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 必须是 5 段（分 时 日 月 周）');
  const out = {};
  FIELDS.forEach((f, i) => {
    out[f.key] = parseField(parts[i], f, ['分', '时', '日', '月', '周'][i]);
  });
  return out;
}

function matches(fields, d) {
  if (!fields.minute.has(d.getMinutes())) return false;
  if (!fields.hour.has(d.getHours())) return false;
  if (!fields.month.has(d.getMonth() + 1)) return false;
  const domOk = fields.dom.has(d.getDate());
  const dowOk = fields.dow.has(d.getDay());
  /* cron 的标准语义：日与周**只要一个被限定**就取并集；都被限定取交集。
     这里按最常见的 Vixie cron 做法：只要有一个是 `*`，就算另一个说了算。 */
  const domWild = fields.dom.size === 31;
  const dowWild = fields.dow.size >= 7;
  if (domWild && dowWild) return true;
  if (domWild) return dowOk;
  if (dowWild) return domOk;
  return domOk || dowOk;
}

/** 从 after 之后算出接下来 n 个触发时刻（本地时区）。扫分钟最多扫一年，扫不到就放弃。 */
function nextRuns(fields, after, n = 5) {
  const out = [];
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after + 366 * 86400000;
  let guard = 0;
  while (out.length < n && d.getTime() < limit && guard < 600000) {
    guard += 1;
    if (matches(fields, d)) {
      out.push(d.getTime());
      if (out.length >= n) break;
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}

/** 人话描述。说不清就只给时刻列表，不编造。 */
function describe(expr, fields) {
  const p = String(expr || '').trim().split(/\s+/);
  const [mi, ho, dm, mo, dw] = p;
  const pad = (x) => String(x).padStart(2, '0');
  if (mi.startsWith('*/') && ho === '*') return `每 ${mi.slice(2)} 分钟`;
  if (ho.startsWith('*/') && mi !== '*' && !mi.includes('/')) return `每小时的第 ${Number(mi)} 分`;
  const time = mi !== '*' && ho !== '*' && !mi.includes(',') && !mi.includes('-') ? `${pad(ho)}:${pad(mi)}` : '';
  if (time && dm === '*' && mo === '*' && dw === '*') return `每天 ${time}`;
  if (time && dm === '*' && mo === '*' && dw !== '*') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const days = [...fields.dow].filter((x) => x < 7).sort().map((x) => names[x]).join('、');
    return `每周${days} ${time}`;
  }
  if (time && dm !== '*' && mo === '*' && dw === '*') return `每月 ${dm} 日 ${time}`;
  if (time && dm === '*' && mo !== '*' && dw === '*') return `每年 ${mo} 月 ${time}`;
  if (time && dm !== '*' && mo !== '*' && dw === '*') return `每年 ${mo} 月 ${dm} 日 ${time}`;
  return '';
}

function preview(expr) {
  const e = String(expr || '').trim();
  if (!e) return { ok: false, expr: e, detail: '表达式为空' };
  let fields;
  try {
    fields = parseCron(e);
  } catch (err) {
    return { ok: false, expr: e, detail: String((err && err.message) || err) };
  }
  const next = nextRuns(fields, Date.now(), 5);
  if (!next.length) return { ok: false, expr: e, detail: '这个表达式在一年内不会触发' };
  return { ok: true, expr: e, describe: describe(e, fields), next, detail: '' };
}

/* ---------- 条目 CRUD ---------- */

/** 列表顺带算 next_run：界面要显示"下次什么时候跑"，而它是派生的，不该存。 */
function list() {
  const r = store.list('automations');
  const now = Date.now();
  const items = (r.items || []).map((it) => {
    let nextRun = Number(it.next_run) || 0;
    let err = '';
    if (it.enabled !== false && String(it.cron || '').trim()) {
      try {
        const n = nextRuns(parseCron(it.cron), now, 1);
        nextRun = n[0] || 0;
        if (!nextRun) err = '这个表达式在一年内不会触发';
      } catch (e) {
        err = String((e && e.message) || e);
      }
    }
    return { ...it, next_run: nextRun, error: err };
  });
  return { ok: true, items };
}

function create(p) {
  const body = p || {};
  const title = String(body.title || '').trim();
  if (!title) throw new Error('标题必填');
  const cron = String(body.cron || '').trim();
  if (cron) {
    try {
      parseCron(cron);
    } catch (e) {
      throw new Error(`cron 不合法：${String((e && e.message) || e)}`);
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const r = store.put('automations', {
    title,
    product: String(body.product || ALL).trim() || ALL,
    schedule: String(body.schedule || '').trim(),
    interval_min: Number(body.interval_min) || 0,
    cron,
    enabled: body.enabled !== false,
    last_run: 0,
    next_run: 0,
    created_at: now,
  });
  return { ok: true, item: r.item };
}

function patch(id, p) {
  const cur = store.get('automations', String(id || ''));
  if (!cur.item) throw new Error('自动化不存在');
  const body = p || {};
  const next = { ...cur.item };
  if (body.title !== undefined) next.title = String(body.title || '').trim();
  if (body.schedule !== undefined) next.schedule = String(body.schedule || '');
  if (body.interval_min !== undefined) next.interval_min = Number(body.interval_min) || 0;
  if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
  if (body.cron !== undefined) {
    const cron = String(body.cron || '').trim();
    if (cron) {
      try {
        parseCron(cron);
      } catch (e) {
        throw new Error(`cron 不合法：${String((e && e.message) || e)}`);
      }
    }
    next.cron = cron;
  }
  const r = store.put('automations', next);
  return { ok: true, item: r.item };
}

function remove(id) {
  const r = store.remove('automations', String(id || ''));
  if (!r.ok) return r;
  return { ok: true, deleted: String(id || '') };
}

/** 执行历史：本地没有调度器，如实返回空——不拿假记录充数。 */
function runs(limit = 50) {
  const r = store.list('automation-runs');
  const items = (r.items || []).slice(-Math.max(Number(limit) || 50, 1)).reverse();
  return { ok: true, items, note: '本地暂无调度器，历史为空' };
}

module.exports = { preview, list, create, patch, remove, runs, parseCron };
