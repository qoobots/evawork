// 浏览器层 e2e 冒烟（T-060）：用 Playwright 遍历所有 hash 路由，收集 console.error / pageerror。
// UI 用本地 HTTP 托管（file:// 会因 CORS 拦截 ES module，导致前端打不开）。
// 用法：node scripts/e2e-ui.mjs   （需先 pnpm add -D playwright && npx playwright install chromium）
import { chromium } from 'playwright';
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

// 优先用最新构建的 dist（每次都重建），其次打包后的 resources/ui
const candidates = [
  path.join(root, 'apps/desktop-ui/dist'),
  path.join(root, 'apps/desktop-node/release/win-unpacked/resources/ui'),
];
const uiDir = candidates.find((p) => fs.existsSync(p));
if (!uiDir) {
  console.error('找不到 UI 产物：请先 pnpm build（或 pnpm dist）生成 dist/');
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
const page = await browser.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.stack || e.message));

let rendered = 0;
for (const r of routes) {
  try {
    await page.goto(`${base}/#${r}`, { waitUntil: 'load', timeout: 15000 });
    await page.waitForSelector('#app > *', { timeout: 10000 });
    const n = await page.evaluate(() => document.querySelector('#app')?.childElementCount ?? 0);
    console.log(`OK   ${r.padEnd(22)} #app children=${n}`);
    rendered++;
  } catch (e) {
    console.log(`FAIL ${r.padEnd(22)} ${String(e.message).split('\n')[0]}`);
  }
}
await browser.close();
server.close();

console.log(`\n路由渲染：${rendered}/${routes.length} 成功`);
console.log(`pageerror（未捕获异常）：${pageErrors.length}`);
console.log(`console.error：${consoleErrors.length}`);
if (pageErrors.length) {
  console.log('\n[pageerror]');
  pageErrors.forEach((e) => console.log('  ' + e));
}
if (consoleErrors.length) {
  console.log('\n[console.error]（前 30 条，多为无后端时的预期 mock 回退）');
  consoleErrors.slice(0, 30).forEach((e) => console.log('  ' + e));
}

process.exit(pageErrors.length || rendered < routes.length ? 1 : 0);
