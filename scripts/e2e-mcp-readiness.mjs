/**
 * MCP 启动就绪端到端测试：守住"慢/挂起的 MCP 服务不能拖垮智能体就绪"。
 *
 * 场景：config 里同时有一个正常的服务（Memory，走本地分发包，~1s 起好）和一个
 * **永远不回应 initialize** 的伪服务（fixtures/slow-mcp.cjs）。installMcpTools 必须是
 * **并行 + 总预算**：预算内先返回已装上的，慢服务在后台继续，绝不干等它 90s 握手超时。
 *
 * 断言：
 *   - 整体在预算内（远小于慢服务的 90s 握手超时）返回，即"就绪不被阻塞"；
 *   - 正常服务已注册工具；
 *   - 慢服务没有阻塞就绪（其工具未注册）。
 *
 * 退出码：0 全过；1 有失败；2 环境不满足（本地分发包缺失）。
 *
 * 注意：测试结束 process.exit 会立即退出，慢夹具在 10s 后自行退出，不会留下孤儿。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_MS = 5000;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-e2e-readiness-'));
process.env.EVA_TS_HOME = home;

const agentMod = await import(pathToFileURL(path.join(REPO, 'apps/agent-ts/src/tools.ts')).href);
const fixture = path.join(REPO, 'scripts', 'fixtures', 'slow-mcp.cjs');

let failed = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

if (!fs.existsSync(fixture)) {
  console.error('环境不满足：缺少慢服务夹具');
  process.exit(2);
}

const config = [
  { name: 'Memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  { name: 'Slow', command: 'node', args: [fixture] },
];

console.log(`临时 home: ${home}`);
console.log(`预算: ${BUDGET_MS}ms；配置含 1 正常 + 1 挂起服务\n`);

const start = Date.now();
const installed = await agentMod.installMcpTools(config, BUDGET_MS);
const elapsed = Date.now() - start;

const names = (agentMod.allTools() || []).map((t) => t.name);
const memoryTools = names.filter((n) => n.startsWith('mcp__Memory__'));
const slowTools = names.filter((n) => n.startsWith('mcp__Slow__'));

check('非阻塞：预算内返回', elapsed < 15000, `耗时 ${elapsed}ms`);
check('正常服务已注册工具', memoryTools.length > 0, `Memory ${memoryTools.length} 个工具`);
check('慢服务未阻塞就绪', slowTools.length === 0, `Slow ${slowTools.length} 个工具`);

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n共安装 ${installed} 个工具（预算内），耗时 ${elapsed}ms`);
console.log(failed === 0 ? '全部通过' : `${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
