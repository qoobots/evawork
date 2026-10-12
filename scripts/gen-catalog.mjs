/**
 * 目录**单一数据源**收口（T-142 / D1）。
 *
 * 背景（为什么以前会出事）：原来是 `mock.ts → catalog.json` 单向生成，且生成器只搬
 * name/desc/icon/color/cats 五个字段。后来 T-3/T-5/T-19/T-20/T-21 给 `catalog.json`
 * 补了 capabilities / egress_policy / agent_protocol / version / publisher / verified /
 * abilities / provides_context —— 这些字段**不在 mock.ts 里**，于是：
 *   - 两份数据各改各的，迟早漂移；
 *   - 谁再跑一次旧生成器，就会**静默抹掉全部安全元数据**（capabilities/egress 正是
 *     能力票据与出口策略的依据），这是一次实打实的安全回归。
 *
 * 现在的约定（单一源 = `catalog.json`）：
 *   `catalog.json`（主进程运行时真正读的那份，字段最全，是唯一可编辑处）
 *        └── gen-catalog.mjs ──→ `src/data/catalog.generated.ts`（前端离线 mock，只读产物）
 *
 * `mock.ts` 不再自己抄一份 plugins/skills/templates，而是从生成文件 re-export。
 * 于是"改目录"只有一个地方可改；前端离线 mock 与后端**不可能**不一致。
 *
 * 用法：
 *   node scripts/gen-catalog.mjs          # 重新生成前端 mock
 *   node scripts/gen-catalog.mjs --check  # 只校验是否最新（CI 用；漂移则非零退出）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 单一源现在在 **desktop-node/data/catalog.json**：主进程运行时读的就是这份
   （原来源在 apps/desktop-py，Python 后端删除后随之迁到这里）。 */
const SRC = path.join(root, 'apps', 'desktop-node', 'data', 'catalog.json');
const OUT = path.join(root, 'apps', 'desktop-ui', 'src', 'data', 'catalog.generated.ts');

if (!fs.existsSync(SRC)) {
  console.error(`找不到目录数据源：${SRC}`);
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(SRC, 'utf8'));

for (const key of ['pluginCats', 'plugins', 'skillCats', 'skills', 'templateCats', 'templates']) {
  if (!Array.isArray(catalog[key])) {
    console.error(`目录数据源缺少数组字段：${key}`);
    process.exit(1);
  }
}

const q = (s) => JSON.stringify(String(s ?? ''));
const arr = (xs) => `[${(xs ?? []).map(q).join(', ')}]`;

/**
 * 数组 → 缩进后的行（**逗号在行内**，空数组返回空串）。
 *
 * 为什么不用 `${xs.map(...).join(",\n")},` 那种写法：数组为空时它会留下一个孤零零的
 * 逗号，产物变成 `[,]` —— 那是 TS 里的 hole 数组，类型是 undefined[]，编译直接报错。
 * 目录清空是**会发生的**（比如下架了全部无安装源的条目），所以这条边界必须成立。
 */
function rows(xs) {
  return (xs || []).map((x) => "  " + oneLine(x)).join(",\n") + ((xs || []).length ? "\n" : "");
}

/** 单行序列化一个对象（保持产物可读、可 diff）。 */
function oneLine(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) parts.push(`${k}: ${JSON.stringify(v)}`);
    else if (typeof v === 'string') parts.push(`${k}: ${q(v)}`);
    else parts.push(`${k}: ${JSON.stringify(v)}`);
  }
  return `{ ${parts.join(', ')} }`;
}

const body = `/* eslint-disable */
// ⚠️ 本文件由 scripts/gen-catalog.mjs 自动生成，**请勿手改**。
// 单一数据源：apps/desktop-node/data/catalog.json（主进程运行时读的那份）
// 重新生成：node scripts/gen-catalog.mjs    校验：node scripts/gen-catalog.mjs --check
import type { PluginItem, TemplateItem, CatalogItem } from './mock';

export const pluginCats: string[] = ${arr(catalog.pluginCats)};
export const skillCats: string[] = ${arr(catalog.skillCats)};
export const templateCats: string[] = ${arr(catalog.templateCats)};

/** 与后端目录项同构（含 capabilities / egress_policy / agent_protocol 等安全元数据）。 */
export const catalogPlugins: CatalogItem[] = [
${rows(catalog.plugins)}
];

export const catalogSkills: CatalogItem[] = [
${rows(catalog.skills)}
];

/** 离线 mock 用的窄类型（保持既有调用方签名不变）。 */
export const plugins: PluginItem[] = catalogPlugins as unknown as PluginItem[];
export const skills: PluginItem[] = catalogSkills as unknown as PluginItem[];

export const templates: TemplateItem[] = [
${rows(catalog.templates)}
];
`;

const check = process.argv.includes('--check');
if (check) {
  if (!fs.existsSync(OUT)) {
    console.error('前端目录 mock 不存在，请运行：node scripts/gen-catalog.mjs');
    process.exit(1);
  }
  const cur = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
  if (cur !== body) {
    console.error('目录数据漂移：catalog.json 与前端 mock 不一致，请运行 node scripts/gen-catalog.mjs');
    process.exit(1);
  }
  console.log(`目录一致：plugins=${catalog.plugins.length} skills=${catalog.skills.length} templates=${catalog.templates.length}`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body, 'utf8');
  console.log(
    `已从前端单一源生成 catalog.generated.ts：plugins=${catalog.plugins.length} ` +
      `skills=${catalog.skills.length} templates=${catalog.templates.length}`,
  );
}
