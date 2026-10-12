/**
 * 技能页端到端测试：验证**本机技能**会并入目录清单。
 *
 * 测的整条链：临时 workspace 里放一个 SKILL.md → catalog.init 注入 getWorkspace
 * → items('skills') / meta() 必须把这个本机技能列出来（local:true, 分类「本地」），
 * 且搜索 / 分类筛选都能命中。
 *
 * 这是为了守住一个真实修过的 bug：技能页之前是空的——catalog.json 里 skills 为 0，
 * 而本机能 `/name` 唤起的技能全在磁盘上、根本没被列出来。没有这条测试时，
 * 这类"界面空着、内核其实能用"的对不上最容易静默回归。
 *
 * 退出码：0 全过；1 有失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 临时 store（catalog 的收藏/评分要走 store）
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-e2e-skills-'));

const require = createRequire(import.meta.url);
const catalog = require(path.join(REPO, 'apps/desktop-node/src/catalog.js'));
const storeMod = (await import(pathToFileURL(path.join(REPO, 'apps/desktop-node/src/store.js')).href)).default;
storeMod.init(path.join(home, 'store'));

// 临时 workspace + 一个本机技能
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-e2e-skills-ws-'));
const skillDir = path.join(workspace, '.evawork', 'skills', 'pdf-summarizer');
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(
  path.join(skillDir, 'SKILL.md'),
  '---\ndescription: 把长 PDF 提炼成三段式摘要\n---\n# PDF 摘要\n读取 PDF 并输出摘要。\n',
);

// 临时 data 目录：只给最小 catalog.json（skills 为空，本机技能应并入）
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-e2e-skills-data-'));
fs.writeFileSync(
  path.join(dataDir, 'catalog.json'),
  JSON.stringify({
    pluginCats: ['全部'],
    plugins: [],
    skillCats: ['全部'],
    skills: [],
    templateCats: ['全部'],
    templates: [],
  }),
);

let failed = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

console.log(`临时 workspace: ${workspace}`);
catalog.init({ dir: dataDir, store: storeMod, getWorkspace: () => workspace });

// ---- 1. items('skills') 必须含本机技能 ----
const items = catalog.items({ kind: 'skills' });
const localItems = items.items.filter((s) => s.local === true);
check('本机技能并入清单', localItems.length > 0, `${items.total} 项，其中本机 ${localItems.length} 项`);
const pdf = localItems.find((s) => s.name === 'pdf-summarizer');
check('能发现 pdf-summarizer', !!pdf, pdf ? pdf.desc : '未找到');
check('标记为 local/loaded', !!pdf && pdf.local === true && pdf.loaded === true);

// ---- 2. meta 必须出现「本地」分类，且计数含本机 ----
const m = catalog.meta();
check('meta 含「本地」分类', (m.skillCats || []).includes('本地'), (m.skillCats || []).join('/'));
check('counts.skills 含本机数', (m.counts?.skills || 0) >= 1, `skills=${m.counts?.skills}`);

// ---- 3. 搜索 / 分类筛选 ----
const byCat = catalog.items({ kind: 'skills', cat: '本地' });
check('按「本地」分类筛选命中', byCat.items.some((s) => s.name === 'pdf-summarizer'));
const byQ = catalog.items({ kind: 'skills', q: 'pdf' });
check('搜索 pdf 命中', byQ.items.some((s) => s.name === 'pdf-summarizer'));
const miss = catalog.items({ kind: 'skills', q: 'zzz-not-exist' });
check('搜索无命中返回空', miss.items.length === 0);

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
