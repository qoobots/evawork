// 性能基线（T-061）：用 Playwright 实测冷加载与各 hash 路由挂载耗时，落盘基线 JSON 供回归对比。
// 用法：node scripts/perf-baseline.mjs   （需先 pnpm add -D playwright && npx playwright install chromium）
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
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
// 冷加载前注入 LCP 观察
await page.addInitScript(() => {
  window.__lcp = 0;
  try {
    const po = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      window.__lcp = (last.renderTime || last.loadTime || 0);
    });
    po.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) { /* 不支持则忽略 */ }
});

// 冷加载：从空白直接进首页
await page.goto(`${base}/#/`, { waitUntil: 'load', timeout: 20000 });
await page.waitForSelector('#app > *', { timeout: 10000 });
const cold = await page.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0] || {};
  const paint = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
  return {
    ttfb: Math.round(n.responseStart || 0),
    domContentLoaded: Math.round(n.domContentLoadedEventEnd || 0),
    load: Math.round(n.loadEventEnd || 0),
    fcp: Math.round(paint ? paint.startTime : 0),
  };
});
cold.lcp = Math.round(await page.evaluate(() => window.__lcp || 0));

// 各路由挂载耗时（取 3 次中位数）
const RUNS = 3;
const mount = {};
for (const r of routes) {
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    await page.evaluate((route) => { window.__t0 = performance.now(); window.location.hash = '#' + route; }, r);
    await page.waitForFunction(() => (document.querySelector('#app')?.childElementCount || 0) > 0, { timeout: 10000 });
    const dt = await page.evaluate(() => performance.now() - (window.__t0 || 0));
    samples.push(Math.round(dt));
  }
  samples.sort((a, b) => a - b);
  mount[r] = { median: samples[Math.floor(samples.length / 2)], samples };
}

await browser.close();
server.close();

const out = {
  measuredAt: new Date().toISOString(),
  environment: { headless: true, viewport: '1280x820', runs: RUNS },
  coldLoad: cold,
  routeMountMs: Object.fromEntries(Object.entries(mount).map(([k, v]) => [k, v.median])),
};
const outPath = path.join(root, 'scripts', 'perf-baseline.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log('=== 冷加载（ms）===');
console.log(`TTFB ${cold.ttfb} | DCL ${cold.domContentLoaded} | Load ${cold.load} | FCP ${cold.fcp} | LCP ${cold.lcp}`);
console.log('\n=== 各路由挂载中位（ms）===');
for (const [k, v] of Object.entries(mount)) console.log(`${k.padEnd(22)} ${v.median}  (${v.samples.join(',')})`);
console.log(`\n基线已落盘：${outPath}`);
process.exit(0);
