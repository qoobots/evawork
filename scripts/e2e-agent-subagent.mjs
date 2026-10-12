// 子代理与装配清单端到端测试。
//
// 覆盖：subagent.ts（白名单、handback 交付、delegate 工具、explore 角色、轨迹）、
//       boot.ts（清单加载/合并/版本守卫、模块开关、handback 永不暴露）、
//       agent.ts（状态生命周期、运行、插话、事件、取消）。
//
// 退出码：0 全过；1 有失败。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { atob } from 'node:buffer';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO, 'apps/agent-ts/src');

// ---- 环境 ----
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-e2e-subagent-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-e2e-subagent-ws-'));

// 先设环境变量（模块 import 期可能读）
process.env.EVA_TS_HOME = home;
process.env.EVA_TS_TELEMETRY = '0';

// ---- Mock HTTP server（delegate 走 streamChat HTTP 路径）----
let mockRequests = [];
let mockNextResponse = null;

const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (req.url === '/chat/completions' && req.method === 'POST') {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      mockRequests.push(parsed);
      const resp = mockNextResponse || { type: 'handback', text: 'MOCK_RESULT' };
      if (parsed.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        if (resp.type === 'handback') {
          const argStr = JSON.stringify({ message: resp.text });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_mock1', type: 'function', function: { name: 'handback', arguments: argStr } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
        } else if (resp.type === 'text') {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: resp.text }, finish_reason: 'stop' }] })}\n\n`);
        } else if (resp.type === 'two-step') {
          // Step 1: tool call (read_file)
          const argStr1 = JSON.stringify({ path: 'nonexistent.txt' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_step1', type: 'function', function: { name: 'read_file', arguments: argStr1 } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
          // 同一请求不会走 step 2；step 2 发生在 loop 把 tool_result 加进 messages 之后再次请求
          // 但 SSE 只回一次。这里靠"首次请求回 tool_calls"即可。
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (resp.type === 'handback') {
          const argStr = JSON.stringify({ message: resp.text });
          res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'call_mock1', type: 'function', function: { name: 'handback', arguments: argStr } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
        } else {
          res.end(JSON.stringify({ choices: [{ message: { content: resp.text || '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
        }
      }
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
});

await new Promise(r => { mockServer.listen(0, '127.0.0.1', r); });
const mockPort = mockServer.address().port;
const mockBaseUrl = `http://127.0.0.1:${mockPort}`;
process.env.EVA_AI_BASE_URL = mockBaseUrl;
process.env.EVA_AI_TOKEN = 'test-token';
process.env.EVA_AI_MODEL = 'mock-model';

function cleanup() {
  mockServer.close();
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
}

// ---- 动态导入被测模块（env 已就绪）----
const toolsMod = await import(pathToFileURL(path.join(SRC, 'tools.ts')).href);
const subagentMod = await import(pathToFileURL(path.join(SRC, 'subagent.ts')).href);
const bootMod = await import(pathToFileURL(path.join(SRC, 'boot.ts')).href);
const agentMod = await import(pathToFileURL(path.join(SRC, 'agent.ts')).href);
const sessionMod = await import(pathToFileURL(path.join(SRC, 'session.ts')).href);

// 显式注册子代理工具（subagent.ts 不自动注册，由 boot.applyManifest 调用）
subagentMod.registerHandbackTool();
subagentMod.registerDelegateTool();

// ---- 辅助 ----
let failed = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

/** 构造一个自定义 stream（绕过 HTTP，直接给 runSubagent 用） */
function makeMockStream(steps) {
  return async function* mockStream(cfg, messages, opt) {
    const stepIdx = 0;
    const step = steps[stepIdx] || { type: 'text', text: 'done' };
    if (step.type === 'tool') {
      yield { type: 'tool_calls', calls: [{ id: step.callId || 'call_1', name: step.tool, arguments: JSON.stringify(step.args) }] };
      yield { type: 'done', finish: 'tool_calls' };
    } else {
      if (step.text) yield { type: 'text', text: step.text };
      yield { type: 'done', finish: 'stop' };
    }
  };
}

/** 多步 mock stream：每次 runTurn 请求，按顺序消耗 steps 数组 */
function makeMultiStepStream(stepsList) {
  let requestCount = 0;
  return async function* mockStream(cfg, messages, opt) {
    const idx = requestCount++;
    const step = stepsList[idx] || { type: 'text', text: '' };
    if (step.type === 'tool') {
      yield { type: 'tool_calls', calls: [{ id: step.callId || `call_${idx}`, name: step.tool, arguments: JSON.stringify(step.args) }] };
      yield { type: 'done', finish: 'tool_calls' };
    } else {
      if (step.text) yield { type: 'text', text: step.text };
      yield { type: 'done', finish: 'stop' };
    }
  };
}

function firstToolCallName(reqBody) {
  const msg = reqBody?.messages?.filter(m => m.role === 'assistant');
  if (!msg?.length) return null;
  const last = msg[msg.length - 1];
  return last?.tool_calls?.[0]?.function?.name || null;
}

// ======================================================================
console.log(`临时 home: ${home}`);
console.log(`临时 workspace: ${workspace}`);
console.log(`Mock server: ${mockBaseUrl}\n`);

// ======================================================================
// 1. subagentTools 白名单
// ======================================================================
{
  // explore 角色：EXPLORE_TOOLS + handback（去重）
  const explore = subagentMod.subagentTools(undefined, 'explore');
  check('subagentTools(explore) 含 read_file', explore.includes('read_file'));
  check('subagentTools(explore) 含 handback', explore.includes('handback'));
  check('subagentTools(explore) 含 web_fetch', explore.includes('web_fetch'));
  check('subagentTools(explore) 含 load_skill', explore.includes('load_skill'));
  check('subagentTools(explore) 不含 run_command', !explore.includes('run_command'));
  check('subagentTools(explore) 不含 write_file', !explore.includes('write_file'));
  check('subagentTools(explore) 不含 terminal', !explore.includes('terminal'));

  // explore + 显式 tools → 尊重调用方
  const exploreCustom = subagentMod.subagentTools(['read_file', 'glob_files'], 'explore');
  check('subagentTools(explore, 自定义) 含 read_file', exploreCustom.includes('read_file'));
  check('subagentTools(explore, 自定义) 含 glob_files', exploreCustom.includes('glob_files'));
  check('subagentTools(explore, 自定义) 含 handback', exploreCustom.includes('handback'));
  check('subagentTools(explore, 自定义) 不含 write_file', !exploreCustom.includes('write_file'));

  // general + 白名单 → 白名单 + handback
  const generalCustom = subagentMod.subagentTools(['read_file', 'run_command'], 'general');
  check('subagentTools(general, 白名单) 含 run_command', generalCustom.includes('run_command'));
  check('subagentTools(general, 白名单) 含 handback', generalCustom.includes('handback'));

  // general + 无白名单 → undefined（全量）
  const generalAll = subagentMod.subagentTools(undefined, 'general');
  check('subagentTools(general, 无白名单) = undefined', generalAll === undefined);

  // 去重：白名单已含 handback 不重复
  const dedup = subagentMod.subagentTools(['handback', 'read_file'], 'general');
  const hbCount = dedup.filter(n => n === 'handback').length;
  check('subagentTools 去重 handback', hbCount === 1, `出现 ${hbCount} 次`);
}

// ======================================================================
// 2. handback 工具行为
// ======================================================================
{
  // handback 已随 subagent.ts import 注册
  const hbTool = toolsMod.findTool('handback');
  check('handback 工具已注册', !!hbTool);

  // 子任务上下文：成功交付
  const subCtx = { workspace, subtask: true, handback: undefined };
  const r1 = hbTool.execute({ message: '测试交付内容' }, subCtx);
  check('handback(subtask) ok=true', r1.ok === true);
  check('handback(subtask) 设置 ctx.handback', subCtx.handback === '测试交付内容');

  // 主任务上下文：拒绝
  const mainCtx = { workspace, subtask: undefined, handback: undefined };
  const r2 = hbTool.execute({ message: '不应交付' }, mainCtx);
  check('handback(主任务) ok=false', r2.ok === false);
  check('handback(主任务) 不设 ctx.handback', mainCtx.handback === undefined);
  check('handback(主任务) 有错误信息', !!r2.error);

  // 空 message
  const emptyCtx = { workspace, subtask: true, handback: undefined };
  const r3 = hbTool.execute({ message: '' }, emptyCtx);
  check('handback(空 message) ok=false', r3.ok === false);
}

// ======================================================================
// 3. runSubagent 行为
// ======================================================================
{
  const parentLog = new sessionMod.SessionLog('test-parent-1', { kind: 'root', goal: 'test' });
  const cfg = { baseUrl: mockBaseUrl, token: 'test', model: 'mock' };

  // 3a. handback 交付
  {
    const stream = makeMockStream([{ type: 'tool', tool: 'handback', args: { message: '结论：任务完成' }, callId: 'call_hb1' }]);
    const result = await subagentMod.runSubagent({
      goal: '测试任务',
      cfg,
      workspace,
      parentLog,
      stream,
    });
    check('runSubagent handback → stopReason=handback', result.stopReason === 'handback');
    check('runSubagent handback → text=交付内容', result.text === '结论：任务完成');
    check('runSubagent handback → handback=true', result.handback === true);
    check('runSubagent → sessionId 存在', !!result.sessionId);
    check('runSubagent → goal 传递', result.goal === '测试任务');
    check('runSubagent → trace 有 rounds', typeof result.trace.rounds === 'number');
    check('runSubagent → trace 有 calls', Array.isArray(result.trace.calls));
    check('runSubagent → trace.calls 含 handback', result.trace.calls.some(c => c.tool === 'handback'));
    check('runSubagent → denied 为空', result.denied.length === 0);
  }

  // 3b. explore 角色拒绝非白名单工具
  {
    const stream = makeMultiStepStream([
      { type: 'tool', tool: 'write_file', args: { path: 'test.txt', content: 'hi' }, callId: 'call_wf1' },
      { type: 'tool', tool: 'handback', args: { message: 'explore 结论' }, callId: 'call_hb2' },
    ]);
    const result = await subagentMod.runSubagent({
      goal: '检索任务',
      cfg,
      workspace,
      parentLog,
      role: 'explore',
      stream,
    });
    check('explore 角色 → write_file 被拒', result.denied.length === 1, `denied=${result.denied.length}`);
    check('explore 角色 → denied 含 write_file', result.denied[0]?.includes('write_file'));
    check('explore 角色 → handback 成功', result.handback === true);
    check('explore 角色 → text 正确', result.text === 'explore 结论');
    check('explore 角色 → trace.calls 含 write_file(被拒)', result.trace.calls.some(c => c.tool === 'write_file' && !c.ok));
    check('explore 角色 → trace.calls 含 handback(成功)', result.trace.calls.some(c => c.tool === 'handback' && c.ok));
  }

  // 3c. 非 handback 完成（模型不调 handback，直接输出文本）
  {
    const stream = makeMockStream([{ type: 'text', text: '直接文本输出' }]);
    const result = await subagentMod.runSubagent({
      goal: '简单任务',
      cfg,
      workspace,
      parentLog,
      stream,
    });
    check('runSubagent 无 handback → stopReason=completed', result.stopReason === 'completed');
    check('runSubagent 无 handback → handback=false', result.handback === false);
    check('runSubagent 无 handback → text 正确', result.text === '直接文本输出');
  }
}

// ======================================================================
// 4. delegate 工具
// ======================================================================
{
  const delegateTool = toolsMod.findTool('delegate');
  check('delegate 工具已注册', !!delegateTool);

  // 4a. delegate 正常执行（通过 mock HTTP）
  {
    mockRequests = [];
    mockNextResponse = { type: 'handback', text: 'SUBAGENT_CONCLUSION' };
    const parentLog = new sessionMod.SessionLog('test-delegate-1', { kind: 'root', goal: 'delegate test' });
    const cfg = { baseUrl: mockBaseUrl, token: 'test', model: 'mock' };
    const ctx = { workspace, cfg, log: parentLog, subtask: false };
    const result = await delegateTool.execute({ goal: '做一件事' }, ctx);
    check('delegate → ok=true', result.ok === true);
    check('delegate → output 含结论', result.output.includes('SUBAGENT_CONCLUSION'));
    check('delegate → 有 subagent trace', !!result.subagent);
    check('delegate → HTTP 请求已发出', mockRequests.length >= 1, `发出 ${mockRequests.length} 个请求`);
    check('delegate → 请求含 stream=true', mockRequests[0]?.stream === true);
  }

  // 4b. 空 goal
  {
    const parentLog = new sessionMod.SessionLog('test-delegate-2', { kind: 'root', goal: 'test' });
    const cfg = { baseUrl: mockBaseUrl, token: 'test', model: 'mock' };
    const ctx = { workspace, cfg, log: parentLog, subtask: false };
    const result = await delegateTool.execute({ goal: '' }, ctx);
    check('delegate(空 goal) → ok=false', result.ok === false);
    check('delegate(空 goal) → 有 error', !!result.error);
  }

  // 4c. 递归子代理禁止
  {
    const parentLog = new sessionMod.SessionLog('test-delegate-3', { kind: 'root', goal: 'test' });
    const cfg = { baseUrl: mockBaseUrl, token: 'test', model: 'mock' };
    const ctx = { workspace, cfg, log: parentLog, subtask: true }; // 已在子任务中
    const result = await delegateTool.execute({ goal: '嵌套任务' }, ctx);
    check('delegate(递归) → ok=false', result.ok === false);
    check('delegate(递归) → error 提及不能派', result.error?.includes('不能再派'));
  }

  // 4d. 缺 cfg/log
  {
    const ctx1 = { workspace, subtask: false }; // 缺 cfg 和 log
    const result1 = await delegateTool.execute({ goal: '测试' }, ctx1);
    check('delegate(缺 cfg/log) → ok=false', result1.ok === false);
    check('delegate(缺 cfg/log) → error 提及通道', result1.error?.includes('模型通道') || result1.error?.includes('事件日志'));
  }
}

// ======================================================================
// 5. boot 装配清单
// ======================================================================
{
  // 5a. DEFAULT_MANIFEST
  check('DEFAULT_MANIFEST.version=1', bootMod.DEFAULT_MANIFEST.version === 1);
  check('DEFAULT_MANIFEST.modules.mcp=true', bootMod.DEFAULT_MANIFEST.modules.mcp === true);
  check('DEFAULT_MANIFEST.modules.subagent=true', bootMod.DEFAULT_MANIFEST.modules.subagent === true);
  check('DEFAULT_MANIFEST.modules.jobs=true', bootMod.DEFAULT_MANIFEST.modules.jobs === true);
  check('DEFAULT_MANIFEST.modules.telemetry=true', bootMod.DEFAULT_MANIFEST.modules.telemetry === true);
  check('DEFAULT_MANIFEST.modules.office=false', bootMod.DEFAULT_MANIFEST.modules.office === false);
  check('DEFAULT_MANIFEST.exclude=[]', Array.isArray(bootMod.DEFAULT_MANIFEST.exclude) && bootMod.DEFAULT_MANIFEST.exclude.length === 0);

  // 5b. MANIFEST_VERSION
  check('MANIFEST_VERSION=1', bootMod.MANIFEST_VERSION === 1);

  // 5c. loadManifest 无文件 → 默认
  {
    const m = bootMod.loadManifest(path.join(home, 'nonexistent.json'));
    check('loadManifest(无文件) → version=1', m.version === 1);
    check('loadManifest(无文件) → modules.subagent=true', m.modules.subagent === true);
  }

  // 5d. loadManifest 版本不匹配 → 默认
  {
    const badFile = path.join(home, 'bad-version.json');
    fs.writeFileSync(badFile, JSON.stringify({ version: 999, modules: { subagent: false } }));
    const m = bootMod.loadManifest(badFile);
    check('loadManifest(版本不匹配) → 返回默认', m.modules.subagent === true);
  }

  // 5e. loadManifest 合并差异
  {
    const customFile = path.join(home, 'custom-boot.json');
    fs.writeFileSync(customFile, JSON.stringify({
      version: 1,
      exclude: ['web_fetch'],
      modules: { subagent: false, office: true },
      prompt: { remove: ['trash'], set: { identity: '自定义身份' } },
    }));
    const m = bootMod.loadManifest(customFile);
    check('loadManifest(自定义) → version=1', m.version === 1);
    check('loadManifest(自定义) → subagent=false', m.modules.subagent === false);
    check('loadManifest(自定义) → office=true', m.modules.office === true);
    check('loadManifest(自定义) → mcp=true(默认)', m.modules.mcp === true); // 未覆盖的保持默认
    check('loadManifest(自定义) → exclude 含 web_fetch', m.exclude.includes('web_fetch'));
    check('loadManifest(自定义) → prompt.remove 含 trash', m.prompt.remove.includes('trash'));
    check('loadManifest(自定义) → prompt.set.identity', m.prompt.set.identity === '自定义身份');
  }

  // 5f. applyManifest → handback 永不暴露
  {
    const runtime = await bootMod.applyManifest({ ...bootMod.DEFAULT_MANIFEST, modules: { ...bootMod.DEFAULT_MANIFEST.modules, mcp: false } });
    const exposed = runtime.exposedTools();
    check('applyManifest → handback 不在暴露名单', !exposed.includes('handback'));
    check('applyManifest → delegate 在暴露名单(subagent=true)', exposed.includes('delegate'));
    check('applyManifest → manifest 正确', runtime.manifest.modules.subagent === true);
    check('applyManifest → prompt 存在', !!runtime.prompt);
    check('applyManifest → tools 快照是数组', Array.isArray(runtime.tools));
    runtime.stop();
  }

  // 5g. applyManifest → 关闭 subagent 移除 delegate
  {
    const m = { ...bootMod.DEFAULT_MANIFEST, modules: { ...bootMod.DEFAULT_MANIFEST.modules, mcp: false, subagent: false } };
    const runtime = await bootMod.applyManifest(m);
    const exposed = runtime.exposedTools();
    check('关闭 subagent → delegate 不在暴露名单', !exposed.includes('delegate'));
    check('关闭 subagent → handback 不在暴露名单', !exposed.includes('handback'));
    runtime.stop();
  }

  // 5h. applyManifest → 自定义 prompt
  {
    const m = {
      ...bootMod.DEFAULT_MANIFEST,
      modules: { ...bootMod.DEFAULT_MANIFEST.modules, mcp: false },
      prompt: { remove: ['trash'], set: { identity: '测试身份' } },
    };
    const runtime = await bootMod.applyManifest(m);
    const ctx = { workspace, tools: ['read_file'], platform: 'test', date: '2026-01-01' };
    const built = runtime.prompt.build(ctx);
    check('自定义 prompt → 含测试身份', built.includes('测试身份'));
    check('自定义 prompt → 不含 trash 节', !built.includes('回收站'));
    runtime.stop();
  }

  // 5i. boot() 函数
  {
    const bootFile = path.join(home, 'boot.json');
    fs.writeFileSync(bootFile, JSON.stringify({ version: 1, modules: { mcp: false, subagent: true } }));
    const runtime = await bootMod.boot(bootFile);
    check('boot() → manifest 正确', runtime.manifest.modules.subagent === true);
    check('boot() → delegate 在暴露名单', runtime.exposedTools().includes('delegate'));
    check('boot() → handback 不在暴露名单', !runtime.exposedTools().includes('handback'));
    runtime.stop();
  }
}

// ======================================================================
// 6. agent 生命周期
// ======================================================================
{
  const cfg = { baseUrl: mockBaseUrl, token: 'test', model: 'mock' };

  // 6a. 基本运行
  {
    const stream = makeMockStream([{ type: 'text', text: 'AGENT_RESULT' }]);
    const agent = agentMod.createAgent({
      turn: { cfg, workspace, log: new sessionMod.SessionLog('agent-test-1', { kind: 'root' }), stream },
    });
    check('agent 初始状态=idle', agent.status === 'idle');
    const result = await agent.run('测试目标');
    check('agent 运行后状态=done', agent.status === 'done');
    check('agent result.text 正确', result.text === 'AGENT_RESULT');
    check('agent result.stopReason=completed', result.stopReason === 'completed');
  }

  // 6b. inbox 插话
  {
    const stream = makeMockStream([{ type: 'text', text: 'done' }]);
    const agent = agentMod.createAgent({
      turn: { cfg, workspace, log: new sessionMod.SessionLog('agent-test-2', { kind: 'root' }), stream },
    });
    agent.inbox('中途插话');
    agent.inbox('系统通知', 'system');
    // inbox 只是排队，不报错
    check('agent.inbox 不抛错', true);
    const result = await agent.run('目标');
    check('agent(inbox) → 正常完成', result.stopReason === 'completed');
  }

  // 6c. 事件订阅
  {
    const stream = makeMockStream([{ type: 'text', text: 'events_test' }]);
    const events = [];
    const agent = agentMod.createAgent({
      turn: { cfg, workspace, log: new sessionMod.SessionLog('agent-test-3', { kind: 'root' }), stream },
    });
    const unsub = agent.on(e => { events.push(e); });
    await agent.run('目标');
    unsub();
    check('agent 事件 → 有事件发出', events.length > 0, `共 ${events.length} 个事件`);
    check('agent 事件 → 含 agent/status', events.some(e => e.type === 'agent/status'));
    check('agent 事件 → 含 agent/turn-stopping', events.some(e => e.type === 'agent/turn-stopping'));
  }

  // 6d. stop 取消
  {
    let streamStarted = false;
    const stream = async function*(cfg, messages, opt) {
      streamStarted = true;
      yield { type: 'text', text: '部分输出' };
      // 等待 abort
      await new Promise(resolve => {
        if (opt.signal?.aborted) return resolve();
        opt.signal?.addEventListener('abort', resolve, { once: true });
        setTimeout(resolve, 2000); // 安全超时
      });
      yield { type: 'done', finish: 'stop' };
    };
    const agent = agentMod.createAgent({
      turn: { cfg, workspace, log: new sessionMod.SessionLog('agent-test-4', { kind: 'root' }), stream },
    });
    const runPromise = agent.run('长任务');
    // 等 agent 进入 running
    await new Promise(r => setTimeout(r, 50));
    check('agent 运行中状态=running', agent.status === 'running');
    agent.stop('测试取消');
    const result = await runPromise;
    check('agent stop → 状态=stopped', agent.status === 'stopped');
    check('agent stop → note 含停下', result.note.includes('已停下') || result.note.includes('取消'));
  }

  // 6e. agent id
  {
    const stream = makeMockStream([{ type: 'text', text: 'x' }]);
    const agent1 = agentMod.createAgent({
      turn: { cfg, workspace, log: new sessionMod.SessionLog('agent-test-5', { kind: 'root' }), stream },
    });
    const agent2 = agentMod.createAgent({
      id: 'custom-id',
      turn: { cfg, workspace, log: new sessionMod.SessionLog('agent-test-6', { kind: 'root' }), stream },
    });
    check('agent 自动生成 id', !!agent1.id && agent1.id.length > 0);
    check('agent 自定义 id', agent2.id === 'custom-id');
  }
}

// ---- 清理 ----
cleanup();

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
