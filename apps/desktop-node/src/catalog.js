/**
 * 插件 / 技能 / 模板目录：数据来自**静态 JSON**（见 data/catalog.json）。
 *
 * 划到主进程的原因：后端废弃后这份清单无处可取，而它本来就不是一个"服务"——
 * 它是随版本发布的静态数据，读文件即可，不需要常驻进程。
 *
 * 数据文件就一份：`apps/desktop-node/data/catalog.json`（随本包分发）。
 * 以前 dev 下还会回退读 desktop-api 那份，那个包已删除——留着候选只会让人以为
 * 数据源还是两处，实际打包态从来只读得到这一份。
 *
 * 收藏是**用户数据**，不进静态文件——走 store（userData/store/favorites.json）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ALL = '全部';

let store = null;
let cache = null;
let getWorkspace = () => '';

function init({ dir, store: storeMod, getWorkspace: gw }) {
  store = storeMod;
  getWorkspace = gw || (() => '');
  // 随本包分发，打进产物后也只有这一份可读
  module.exports._candidates = [path.join(dir, 'catalog.json')];
  cache = null;
}

function load() {
  if (cache) return cache;
  let data = null;
  for (const p of module.exports._candidates || []) {
    if (fs.existsSync(p)) {
      try {
        data = JSON.parse(fs.readFileSync(p, 'utf8'));
        break;
      } catch {
        data = null;
      }
    }
  }
  if (!data) data = { pluginCats: [ALL], plugins: [], skillCats: [ALL], skills: [], templateCats: [ALL], templates: [] };
  cache = data;
  return data;
}

/** 丢弃内存缓存：下次读取重新解析 catalog.json（界面「刷新目录」用）。 */
function reload() {
  cache = null;
  return { ok: true };
}

function templates({ cat = '', q = '', fav = false } = {}) {
  const items = load().templates || [];
  const faves = new Set(favorites());
  const c = String(cat || '').trim();
  const kw = String(q || '').trim().toLowerCase();
  const out = items.filter((it) => {
    if (c && c !== ALL && it.cat !== c) return false;
    if (kw && !String(it.title || '').toLowerCase().includes(kw)) return false;
    if (fav && !faves.has(it.title)) return false;
    return true;
  });
  return { ok: true, items: out, total: out.length };
}

function templateMeta() {
  const d = load();
  return { ok: true, cats: d.templateCats || [ALL], counts: { templates: (d.templates || []).length } };
}

/** 详情的 prompt 是拼出来的（模板只存元数据，正文由这句引导模型生成）。 */
function template(title) {
  for (const it of load().templates || []) {
    if (it.title === title) {
      const prompt = `请使用「${it.title}」模板，${it.desc || ''}。请输出可直接使用的内容，并尽量结构化。`;
      return { ok: true, item: { ...it, prompt } };
    }
  }
  return { ok: false, reason: '模板不存在' };
}

/** 收藏：store 里每条是一个 { id: <标题> }，保持有序（写入时排序）。 */
function favorites() {
  const r = store.list('favorites');
  return (r.items || []).map((x) => x.id).sort();
}

function setFavorite(title, faved) {
  const t = String(title || '').trim();
  if (!t) return { ok: false, reason: '缺少 title' };
  const s = new Set(favorites());
  if (faved) s.add(t);
  else s.delete(t);
  const out = [...s].sort();
  store.replaceAll('favorites', out.map((x) => ({ id: x })));
  return { ok: true, items: out };
}

/** 本地分类名：本机技能在市场里没有对应条目，用这个分类把它们归到一起。 */
const LOCAL_CAT = '本地';

/** 技能来源 → 界面文案。scope 由扫描根决定（见 skillRoots）。 */
const SCOPE_LABEL = { project: '项目', custom: '自定义', user: '本机', builtin: '内置' };

/** 本机技能 → 目录条目形状。标记 local/loaded：市场里没有，但**真能 /name 唤起**。 */
function localSkillItems() {
  return discoverSkills(getWorkspace()).map((s) => ({
    name: s.name,
    desc: s.description || '',
    icon: 'sparkles',
    color: '#e8f3ec',
    cats: [LOCAL_CAT],
    category: LOCAL_CAT,
    origin: SCOPE_LABEL[s.scope] || '本机',
    loaded: true, // 磁盘上真有 SKILL.md
    local: true, // 市场里没有，纯本地技能
    scope: s.scope || 'user', // 项目 / 自定义 / 用户 / 随包内置——界面据此挂不同徽章
    install_kind: 'local',
    spec: '',
  }));
}

/** 插件/技能只读清单（安装等写操作要远端市场，不做）。
 *  评分从本机 store 合并；**技能额外并入本机技能**——否则技能页永远空着，
 *  而本机那些技能恰恰是唯一真能 `/name` 唤起的。 */
function items({ kind = 'plugins', cat = '', q = '' } = {}) {
  const d = load();
  const base = kind === 'skills' ? d.skills || [] : d.plugins || [];
  // 本地技能排在后面：市场条目才是"可以去装的"，本地的是"已经能用的"
  const list0 = kind === 'skills' ? base.concat(localSkillItems()) : base;
  const c = String(cat || '').trim();
  const kw = String(q || '').trim().toLowerCase();
  const ratings = readRatings();
  const out = list0.filter((it) => {
    if (c && c !== ALL && !(it.cats || []).includes(c)) return false;
    if (kw && !`${it.name || ''}${it.desc || ''}`.toLowerCase().includes(kw)) return false;
    return true;
  });
  return { ok: true, items: out.map((it) => mergeRating(it, ratings)), total: out.length };
}

/** 本机评分：{ id: 条目名, score, comment }。没有评分时 rating 沿用目录基线。 */
function readRatings() {
  const r = store.list('ratings');
  const out = {};
  for (const x of r.items || []) out[String(x.id)] = x;
  return out;
}

function mergeRating(it, ratings) {
  const mine = ratings[it.name];
  if (!mine) return it;
  return { ...it, my_rating: mine.score, rating: mine.score, rating_comment: mine.comment || '' };
}

function meta() {
  const d = load();
  const locals = localSkillItems();
  const skillCats = (d.skillCats || [ALL]).slice();
  // 有本地技能才把「本地」加进筛选栏：没有时出现一个点了永远空的分类没意义
  if (locals.length && !skillCats.includes(LOCAL_CAT)) skillCats.push(LOCAL_CAT);
  return {
    ok: true,
    pluginCats: d.pluginCats || [ALL],
    skillCats,
    counts: { plugins: (d.plugins || []).length, skills: (d.skills || []).length + locals.length },
  };
}

/* ---------- 本地已装技能（T-076） ----------
   只列"真在磁盘上"的技能，不按市场清单编。

   优先级沿用 dsh 的 rank 表：**数字小的赢**（项目级 → 自定义 → 用户级 → 随包内置）。
   内置排最后是有意的：项目/用户在同名技能上的覆盖必须赢，内置只当兜底；
   反过来就是"用户改了不生效"这种最难查的坑。 */

const RANK = { project: 100, projectLegacy: 200, custom: 300, user: 400, bundled: 600 };

/**
 * 随应用分发的内置技能目录（装机就有，不再依赖用户机器上恰好有一份）。
 *
 * 技能源码在项目下维护：`apps/skills`（开发态）/ `resources/skills`（打包态）。
 * 可用 EVA_SKILL_BUNDLE 显式指定（调试用）。
 */
function bundledSkillDir() {
  const explicit = String(process.env.EVA_SKILL_BUNDLE || '').trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'skills');
    if (fs.existsSync(p)) return p;
  }
  return path.resolve(__dirname, '..', '..', 'skills');
}

/** 技能扫描根：返回 `{ path, scope, rank }`，已按 rank 升序（= 优先级降序）。 */
function skillRoots(workspace) {
  const ws = path.resolve(String(workspace || ''));
  const env = String(process.env.EVAWORK_SKILL_DIR || '').trim();
  const roots = [
    { path: path.join(ws, '.evawork', 'skills'), scope: 'project', rank: RANK.project },
    { path: path.join(ws, '.eva-skills'), scope: 'project', rank: RANK.projectLegacy },
    { path: path.join(ws, 'skills'), scope: 'project', rank: RANK.projectLegacy },
    // 显式指定了自定义目录就顶掉用户级，而不是两个都扫（两个都扫时同名技能谁赢说不清）
    env
      ? { path: env, scope: 'custom', rank: RANK.custom }
      : { path: path.join(os.homedir(), '.evawork', 'skills'), scope: 'user', rank: RANK.user },
    { path: bundledSkillDir(), scope: 'builtin', rank: RANK.bundled },
  ];
  return roots
    .filter((r) => {
      try {
        return fs.statSync(r.path).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.rank - b.rank);
}

/**
 * 技能名**取条目名**（目录名 / 文件名去掉 .md），与 agent-ts `discoverSkills` 一字不差。
 * 刻意**不读 front-matter 的 name**：内核不认它，界面认了就会出现
 * "列表里叫 A、/A 唤起不了"这种最难查的对不上。
 */
function summarize(raw) {
  const fm = raw.match(/^---[^\n]*\n([\s\S]*?)\n---[^\n]*\n?/);
  const meta = fm ? fm[1] : '';
  const rest = fm ? raw.slice(fm[0].length) : raw;
  const desc = /^[ \t]*description[ \t]*:[ \t]*(.+)$/m.exec(meta);
  if (desc) {
    const d = desc[1].trim().replace(/\s+/g, ' ').replace(/^["']|["']$/g, '');
    if (d) return d.slice(0, 120);
  }
  const text = rest.replace(/^#[ \t]+.*$/m, '').trim();
  const first = text.split(/\r?\n\s*\r?\n/).find((p) => p.trim()) || '';
  return first.replace(/\s+/g, ' ').trim().slice(0, 120) || '（无摘要）';
}

function parseSkillFile(file, entryName) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return {
    name: String(entryName || '').replace(/\.md$/i, ''),
    description: summarize(raw),
    body: raw, // 与 agent-ts 的 loadSkill 一致：给全文（含 front-matter）
    path: file,
  };
}

function discoverSkills(workspace) {
  const out = [];
  const seen = new Set();
  for (const root of skillRoots(workspace)) {
    let entries = [];
    try {
      entries = fs.readdirSync(root.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // 两种形态都认：skills/foo.md 与 skills/foo/SKILL.md（与 agent-ts 一致）
      const candidates = e.isDirectory()
        ? [path.join(root.path, e.name, 'SKILL.md')]
        : e.name.toLowerCase().endsWith('.md')
          ? [path.join(root.path, e.name)]
          : [];
      for (const f of candidates) {
        if (!fs.existsSync(f)) continue;
        const s = parseSkillFile(f, e.name);
        if (!s || !s.name) continue;
        const key = s.name.toLowerCase();
        if (seen.has(key)) continue; // rank 小的根先扫到，它的同名技能赢
        seen.add(key);
        out.push({ ...s, scope: root.scope, rank: root.rank });
      }
    }
  }
  return out;
}

function installedSkills(workspace) {
  const items = discoverSkills(workspace);
  return {
    ok: true,
    items: items.map((s) => ({
      name: s.name,
      description: s.description,
      body: '',
      allowed_tools: [],
      scripts: [],
      path: s.path,
      source: 'local',
      scope: s.scope || 'user',
      tools: [],
    })),
    root: skillRoots(workspace)[0]?.path || '',
    total: items.length,
  };
}

function skillDetail(workspace, name) {
  const want = String(name || '').trim().toLowerCase();
  const hit = discoverSkills(workspace).find((s) => s.name.toLowerCase() === want);
  if (!hit) return { ok: false, reason: '没有这个技能' };
  return {
    ok: true,
    item: {
      name: hit.name,
      description: hit.description,
      body: hit.body,
      allowed_tools: [],
      scripts: [],
      path: hit.path,
      source: 'local',
      tools: [],
    },
  };
}

module.exports = {
  init, load, reload, templates, templateMeta, template, favorites, setFavorite,
  items, meta, installedSkills, skillDetail,
};
