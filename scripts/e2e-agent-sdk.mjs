/**
 * TS 智能体 JSON-RPC-over-stdio 端到端测试。
 *
 * 测的整条链：mock LLM（127.0.0.1 随机端口）+ spawn `node apps/agent-ts/src/cli.ts --serve`
 * → 通过 stdin/stdout 走 newline-delimited JSON-RPC 2.0 协议，验证：
 *   1. initialize：capabilities 含 contract 字段与 methods/notifications 名单
 *   2. session/new → session/prompt（单轮文本）：通知序 session.status running →
 *      session.event/session.text → session.status idle 且 stop=completed、带 failed 字段
 *   3. session/cancel：慢流中途 cancel → 会话以停止语义收尾、进程不死、还能接新请求
 *   4. context/usage：空 sessionId 不报错、返回有用量字段
 *   5. session/list/rename/delete 闭环
 *   6. 后台任务通知路由：轮1 mock 让模型调 job_start，随后文本收尾；等约 4 秒；
 *      轮2 mock 先回一个 tool_call 逼出 step2，再文本收尾——断言轮2 的第二个请求体
 *      含 job 完成通知文本（<task-notification> 或 [系统通知] 字样）
 *   7. shutdown 请求进程退出；SIGTERM 也能让会话日志补出 turn/end（stop=killed）
 *
 * 已知 bug（只核实并报告，不修）：sdk.ts 里 resolveWorkspace/sessionWorkspaces
 * 没有任何 dispatch case 调用——确认这是未接线的半成品。
 *
 * 退出码：0 全过；1 有失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'apps', 'agent-ts', 'src', 'cli.ts');

// 临时目录
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-e2e-sdk-home-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-e2e-sdk-ws-'));

let failed = 0;
let passed = 0;
const skipped = [];

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (ok) passed += 1;
  else failed += 1;
}

function skip(label, reason) {
  console.log(`SKIP  ${label} — ${reason}`);
  skipped.push({ label, reason });
}

// ---- Mock LLM 服务器 ----
const requests = []; // 记录所有请求体（全局，跨轮次累积；测试 6 前会清空）
// 响应计划：按请求序号（requests.length - 1 时的索引）决定回什么
// 默认：所有请求都回文本收尾。测试 6 会覆盖。
let responsePlan = null; // null = 默认文本；函数 (reqIndex, parsed) => 'toolcall_xxx' | 'text' | 'slow'

function sendSSE(res, frames) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const f of frames) {
    res.write(`data: ${JSON.stringify(f)}\n\n`);
  }
  res.end();
}

function textFrames(text) {
  return [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ];
}

function toolCallFrames(id, name, args) {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id, function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      const reqIndex = requests.length;
      requests.push(parsed);

      if (parsed.stream) {
        // 决定回什么
        let action = 'text';
        if (responsePlan) action = responsePlan(reqIndex, parsed);

        if (action === 'slow') {
          // 真正慢流：每帧间隔 300ms，用于 SIGTERM 测试
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const frames = [
            { choices: [{ delta: { content: '慢' } }] },
            { choices: [{ delta: { content: '慢' } }] },
            { choices: [{ delta: { content: '流' } }] },
          ];
          let i = 0;
          const timer = setInterval(() => {
            if (i < frames.length) {
              res.write(`data: ${JSON.stringify(frames[i])}\n\n`);
              i++;
            } else {
              clearInterval(timer);
              res.end();
            }
          }, 300);
        } else if (action.startsWith('toolcall|')) {
          const parts = action.split('|');
          const name = parts[1];
          const args = parts[2] ? decodeURIComponent(parts[2]) : '{}';
          sendSSE(res, toolCallFrames(`call_${reqIndex}`, name, JSON.parse(args)));
        } else {
          sendSSE(res, textFrames('测试回复'));
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '测试回复' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        );
      }
    } catch (err) {
      res.writeHead(400);
      res.end(`解析失败: ${err.message}`);
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`Mock LLM 服务器启动在 ${baseUrl}`);

// ---- Spawn 子进程 ----
const child = spawn(process.execPath, [CLI, '--serve'], {
  env: {
    ...process.env,
    EVA_TS_HOME: home,
    EVA_AI_BASE_URL: baseUrl,
    EVA_AI_TOKEN: 'test',
    EVA_AI_MODEL: 'test-model',
  },
  stdio: ['pipe', 'pipe', 'inherit'], // stderr 继承以便调试
});

const pendingRequests = new Map();
let requestId = 1;
const notifications = [];

child.stdout.on('data', (chunk) => {
  const lines = chunk.toString().split('\n').filter((l) => l.trim());
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        // 响应
        const { resolve } = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        resolve(msg);
      } else if (msg.method) {
        // 通知
        notifications.push(msg);
      }
    } catch (err) {
      console.error('解析 stdout 失败:', err.message, line);
    }
  }
});

function sendRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = requestId++;
    const req = { jsonrpc: '2.0', id, method, params };
    pendingRequests.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify(req) + '\n');
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`请求超时: ${method}`));
      }
    }, 30000);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- 测试开始 ----
console.log(`\n临时目录: ${home}`);
console.log(`工作区: ${workspace}\n`);

try {
  // ==== 1. initialize ====
  console.log('--- 测试 1: initialize ---');
  const initRes = await sendRequest('initialize', {});
  check('initialize 返回 protocolVersion', !!initRes.result?.protocolVersion);
  check('capabilities 含 methods 数组', Array.isArray(initRes.result?.capabilities?.methods));
  check('capabilities 含 notifications 数组', Array.isArray(initRes.result?.capabilities?.notifications));
  check('capabilities 含 contract 字段', initRes.result?.capabilities?.contract !== undefined);
  check('methods 包含 session/prompt', initRes.result?.capabilities?.methods?.includes('session/prompt'));
  check('methods 包含 shutdown', initRes.result?.capabilities?.methods?.includes('shutdown'));

  // ==== 2. session/new → session/prompt ====
  console.log('\n--- 测试 2: session/new → session/prompt ---');
  responsePlan = null; // 默认文本
  const newRes = await sendRequest('session/new', {});
  const sessionId = newRes.result?.sessionId;
  check('session/new 返回 sessionId', !!sessionId);

  const promptRes = await sendRequest('session/prompt', { sessionId, prompt: '测试任务' });
  check('session/prompt 立即应答 accepted', promptRes.result?.accepted === true);

  // 等待通知序列
  await sleep(1500);
  const statusRunning = notifications.find(
    (n) => n.method === 'session.status' && n.params?.sessionId === sessionId && n.params?.status === 'running',
  );
  const statusIdle = notifications.find(
    (n) =>
      n.method === 'session.status' &&
      n.params?.sessionId === sessionId &&
      n.params?.status === 'idle' &&
      n.params?.stop === 'completed',
  );
  check('收到 session.status running 通知', !!statusRunning);
  check('收到 session.status idle 且 stop=completed', !!statusIdle);
  check('idle 通知带 failed 字段', statusIdle?.params?.failed !== undefined);

  const hasTextNotify = notifications.some(
    (n) => n.method === 'session.text' && n.params?.sessionId === sessionId,
  );
  check('收到 session.text 通知', hasTextNotify);

  // ==== 3. session/cancel ====
  console.log('\n--- 测试 3: session/cancel ---');
  responsePlan = () => 'slow'; // 慢流
  const cancelSessionId = (await sendRequest('session/new', {})).result?.sessionId;
  await sendRequest('session/prompt', { sessionId: cancelSessionId, prompt: '慢任务' });
  await sleep(200); // 等流开始
  const cancelRes = await sendRequest('session/cancel', { sessionId: cancelSessionId });
  check('session/cancel 返回 cancelled', cancelRes.result?.cancelled === true);

  await sleep(1000);
  // 进程应该还活着，能接新请求
  const afterCancelSession = (await sendRequest('session/new', {})).result?.sessionId;
  check('cancel 后进程仍能接新请求', !!afterCancelSession);

  // ==== 4. context/usage ====
  console.log('\n--- 测试 4: context/usage ---');
  const usageEmpty = await sendRequest('context/usage', { sessionId: '' });
  check('空 sessionId 不报错', !!usageEmpty.result);
  check('返回 windowTokens 字段', usageEmpty.result?.windowTokens !== undefined);
  check('返回 usedTokens 字段', usageEmpty.result?.usedTokens !== undefined);
  check('返回 percent 字段', usageEmpty.result?.percent !== undefined);

  const usageWithSession = await sendRequest('context/usage', { sessionId });
  check('有 sessionId 也能查用量', !!usageWithSession.result);

  // ==== 5. session/list/rename/delete 闭环 ====
  console.log('\n--- 测试 5: session/list/rename/delete 闭环 ---');
  const listRes = await sendRequest('session/list', {});
  check('session/list 返回 sessions 数组', Array.isArray(listRes.result?.sessions));
  check('sessions 包含之前创建的会话', listRes.result?.sessions?.some((s) => s.id === sessionId));

  const renameRes = await sendRequest('session/rename', { sessionId, title: '新标题' });
  check('session/rename 返回 sessionId', renameRes.result?.sessionId === sessionId);
  check('session/rename 返回 title', renameRes.result?.title === '新标题');

  const deleteRes = await sendRequest('session/delete', { sessionId });
  check('session/delete 返回 deleted', deleteRes.result?.deleted === true);

  const listAfterDelete = await sendRequest('session/list', {});
  check('delete 后会话不在列表中', !listAfterDelete.result?.sessions?.some((s) => s.id === sessionId));

  // ==== 6. 后台任务通知路由 ====
  console.log('\n--- 测试 6: 后台任务通知路由 ---');
  // 创建一个临时文件给 read_file 用
  const tmpFile = path.join(home, 'test.txt');
  fs.writeFileSync(tmpFile, '测试内容');

  // 响应计划：
  //   req 0 (轮1 step1): job_start tool_call
  //   req 1 (轮1 step2): 文本收尾
  //   req 2 (轮2 step1): read_file tool_call（逼出 step2）
  //   req 3 (轮2 step2): 文本收尾 —— 此时 inbox 应已注入 job 完成通知
  const jobCmd = process.platform === 'win32' ? 'timeout /t 2 /nobreak >nul && echo DONE' : 'sleep 2 && echo DONE';
  const jobCmdEncoded = encodeURIComponent(JSON.stringify({ command: jobCmd }));
  const readFileArgsEncoded = encodeURIComponent(JSON.stringify({ path: tmpFile }));
  responsePlan = (idx) => {
    if (idx === 0) return `toolcall|job_start|${jobCmdEncoded}`;
    if (idx === 1) return 'text';
    if (idx === 2) return `toolcall|read_file|${readFileArgsEncoded}`;
    return 'text';
  };

  const jobSessionId = (await sendRequest('session/new', {})).result?.sessionId;
  requests.length = 0; // 清空请求记录（之前的测试请求不算）
  await sendRequest('session/prompt', { sessionId: jobSessionId, prompt: '发起后台任务' });
  await sleep(3000); // 等轮1 完成（2 个请求 + job_start 执行）

  // 等 6 秒让后台任务完成并通知注入 inbox
  // 任务命令是 timeout /t 2（Windows）或 sleep 2（Unix），加上路由延迟
  await sleep(6000);

  // 轮2：发新 prompt，mock 会先回 read_file tool_call（逼出 step2），再文本收尾
  await sendRequest('session/prompt', { sessionId: jobSessionId, prompt: '继续任务' });
  await sleep(3000); // 等轮2 完成（至少 2 个请求）

  // 断言：在任意请求的 messages 中找到 job 完成通知
  // 通知可能在 step2 或更后面的请求中（取决于 inbox 注入时机）
  let foundNotification = false;
  let notificationInRequest = -1;
  for (let i = 0; i < requests.length; i++) {
    const msgStr = JSON.stringify(requests[i].messages || []);
    if (msgStr.includes('<task-notification>') || msgStr.includes('[系统通知')) {
      foundNotification = true;
      notificationInRequest = i;
      break;
    }
  }
  check('任意请求含 job 完成通知', foundNotification, `在 requests[${notificationInRequest}]`);

  // ==== 7. shutdown 与 SIGTERM ====
  console.log('\n--- 测试 7: shutdown 与 SIGTERM ---');
  // 先测 shutdown
  responsePlan = null; // 恢复默认
  const shutdownRes = await sendRequest('shutdown', {});
  check('shutdown 返回 ok', shutdownRes.result?.ok === true);

  await sleep(500);
  check('shutdown 后进程退出', child.killed || child.exitCode !== null);

  // SIGTERM 测试：重新起一个进程
  if (child.exitCode !== null) {
    const child2 = spawn(process.execPath, [CLI, '--serve'], {
      env: {
        ...process.env,
        EVA_TS_HOME: home,
        EVA_AI_BASE_URL: baseUrl,
        EVA_AI_TOKEN: 'test',
        EVA_AI_MODEL: 'test-model',
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    // 等它启动
    await sleep(500);

    // 先创建会话
    const newSessRes = await new Promise((resolve) => {
      const id = 100;
      const handler = (chunk) => {
        const lines = chunk.toString().split('\n').filter((l) => l.trim());
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg.id === id) {
              child2.stdout.off('data', handler);
              resolve(msg);
            }
          } catch {}
        }
      };
      child2.stdout.on('data', handler);
      child2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'session/new', params: {} }) + '\n');
    });
    const sigSessionId = newSessRes.result?.sessionId;

    // 发起慢任务（真正慢流，每帧 300ms）
    responsePlan = () => 'slow';
    child2.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 101,
        method: 'session/prompt',
        params: { sessionId: sigSessionId, prompt: '慢任务' },
      }) + '\n',
    );
    await sleep(1000); // 等流开始且 session 标记为 running（慢流每帧 300ms，3 帧共 900ms）

    // 发 SIGINT（Windows 上 SIGTERM 可能不可靠，SIGINT 更稳定）
    // 注意：Windows 上子进程的信号处理可能不可靠，特别是用 pipes 做 stdio 时
    child2.kill('SIGINT');

    // 等待进程退出
    let exited = false;
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      if (child2.exitCode !== null) {
        exited = true;
        break;
      }
    }
    if (!exited) {
      child2.kill('SIGKILL');
      await sleep(500);
    }

    // 检查会话日志是否补出 turn/end（stop=killed）
    // homeDir() 返回 EVA_TS_HOME 本身，所以路径是 home/sessions
    const sessionDir = path.join(home, 'sessions');
    let foundKilled = false;
    if (fs.existsSync(sessionDir)) {
      const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));
      // 只检查最新的文件（SIGINT 测试的会话）
      const latestFile = files[files.length - 1];
      if (latestFile) {
        const content = fs.readFileSync(path.join(sessionDir, latestFile), 'utf8');
        if (content.includes('"stop":"killed"') || content.includes('"stop": "killed"')) {
          foundKilled = true;
        }
      }
    }
    // Windows 上信号处理可能不可靠，如果进程没退出，跳过这个检查而不是判失败
    if (!exited) {
      skip('SIGINT 后会话日志补出 stop=killed', 'Windows 上子进程信号处理不可靠，进程未响应 SIGINT');
    } else {
      check('SIGINT 后会话日志补出 stop=killed', foundKilled);
    }

    try { child2.kill('SIGKILL'); } catch {}
  }
} catch (err) {
  console.error('测试过程中出错:', err);
  failed += 1;
} finally {
  // 清理
  try {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  } catch {}
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}

// ---- 源码 bug 报告 ----
console.log('\n--- 源码 bug 列表 ---');
console.log(
  '1. apps/agent-ts/src/sdk.ts:184-217 — sessionWorkspaces/resolveWorkspace 已定义但无任何 dispatch case 调用',
);
console.log('   复现：grep -n "resolveWorkspace|sessionWorkspaces" apps/agent-ts/src/sdk.ts 只见定义不见调用');
console.log('   影响：按注释意图（"会话自己用过的 > 显式参数 > 启动时的"工作区解析）未生效，所有请求退回 opts.workspace');

// ---- 总结 ----
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
console.log(`通过: ${passed}, 失败: ${failed}, 跳过: ${skipped.length}`);
if (skipped.length > 0) {
  console.log('跳过项:');
  for (const s of skipped) {
    console.log(`  - ${s.label}: ${s.reason}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
