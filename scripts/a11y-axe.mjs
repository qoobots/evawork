// 无障碍走查（T-053）：用 @axe-core/playwright 逐路由扫描 WCAG 违规，重点看对比度（color-contrast）。
// 用法：node scripts/a11y-axe.mjs
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routes = [
  '/', '/office', '/market', '/templates', '/design',
  '/design/system-tiktok', '/automation', '/files',
  '/admin/usage', '/admin/account', '/admin/subscription', '/admin/dashboard',
  '/admin/favorites', '/admin/rules', '/admin/commands', '/admin/integrations',
  '/admin/cloud-env', '/admin/mcp',
];

const uiDir = path.join(root, 'apps/desktop-ui', 'dist');
if (!fs.existsSync(uiDir)) {
  console.error('找不到 UI 产物：请先 pnpm build 生成 dist/');
  process.exit(2);
}
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(uiDir, p);
  if (!file.startsWith(uiDir)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const page = await context.newPage();

const allViolations = {};
const ruleCount = {};
for (const r of routes) {
  await page.goto(`${base}/#${r}`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForSelector('#app > *', { timeout: 10000 });
  let violations = [];
  try {
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
    violations = res.violations;
  } catch (e) {
    console.log(`AXE_FAIL ${r.padEnd(22)} ${String(e.message).split('\n')[0]}`);
  }
  allViolations[r] = violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
  for (const v of violations) ruleCount[v.id] = (ruleCount[v.id] || 0) + 1;
  console.log(`${r.padEnd(22)} 违规 ${violations.length}`);
}
await context.close();
await browser.close();
server.close();

const total = Object.values(allViolations).reduce((s, arr) => s + arr.length, 0);
const json = {
  measuredAt: new Date().toISOString(),
  routes: Object.keys(allViolations).length,
  totalViolations: total,
  byRule: ruleCount,
  perRoute: allViolations,
};
const outPath = path.join(root, 'scripts', 'a11y-axe.json');
fs.writeFileSync(outPath, JSON.stringify(json, null, 2));

console.log(`\n总计：18 路由，违规 ${total} 条`);
if (total > 0) {
  console.log('按规则分布（影响面）：');
  Object.entries(ruleCount)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`  ${k}: ${n}`));
}
console.log(`\n报告已落盘：${outPath}`);
process.exit(0);
