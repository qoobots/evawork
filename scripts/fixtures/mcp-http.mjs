/**
 * 最小 MCP server over HTTP（只用 Node 标准库），用于 T-093 的**端到端**冒烟。
 *
 * 和 mcp-echo.mjs 一样刻意"不坐在 Python 这边自己 mock 自己"：
 * 客户端必须要被一个真的外部进程验证过才算数。一份代码两种传输：
 *   streamable：`POST /mcp`（一个端点承担上下行，直接回 JSON）
 *   sse       ：`GET /sse` 开下行流 → `event: endpoint` 给上行地址 → `POST /messages?sessionId=`
 *                 POST 只回 202，响应从下行流推回来（这才是 2024-11-05 的真实形态）
 *
 * 用法：node scripts/fixtures/mcp-http.mjs <port> <streamable|sse>
 */
import http from 'node:http';

const port = Number(process.argv[2] || 0);
const mode = process.argv[3] || 'streamable';

const TOOLS = [
  {
    name: 'echo',
    description: '回显输入文本（只读工具，不应触发审批）',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: '要回显的文本' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add',
    description: '两数相加',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
  {
    name: 'write_note',
    description: '写一条笔记（有副作用，应触发审批）',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

function reply(msg, data) {
  return { jsonrpc: '2.0', id: msg.id, result: data };
}

function fail(msg, code, message) {
  return { jsonrpc: '2.0', id: msg.id, error: { code, message } };
}

function handleRequest(msg) {
  if (msg.method === 'initialize') {
    const want = msg.params?.protocolVersion;
    if (!want || !['2025-06-18', '2024-11-05'].includes(want)) {
      return fail(msg, -32600, `不支持的协议版本：${want}`);
    }
    return reply(msg, { protocolVersion: want, capabilities: { tools: {} }, serverInfo: { name: 'mcp-http-fixture', version: '1.0.0' } });
  }
  if (msg.method === 'tools/list') return reply(msg, { tools: TOOLS });
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {};
    if (name === 'echo') return reply(msg, { content: [{ type: 'text', text: String(args?.text ?? '') }], isError: false });
    if (name === 'add') return reply(msg, { content: [{ type: 'text', text: String(Number(args?.a ?? 0) + Number(args?.b ?? 0)) }], isError: false });
    if (name === 'write_note') return reply(msg, { content: [{ type: 'text', text: `已记下：${args?.text ?? ''}` }], isError: false });
    return fail(msg, -32601, `未知工具：${name}`);
  }
  if (msg.method?.startsWith('notifications/')) return null; // 通知不需要响应
  return fail(msg, -32601, `未知方法：${msg.method}`);
}

const sessions = new Map(); // sid -> { res, endpoint }
let seq = 0;

function newSession(res) {
  const sid = `sess-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const endpoint = `/messages?sessionId=${sid}`;
  sessions.set(sid, { res, endpoint });
  return { sid, endpoint };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1 << 20) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = obj === null ? '' : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  // ---- 2024-11-05 HTTP+SSE：下行流 ----
  if (mode === 'sse' && req.method === 'GET' && url.pathname === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const { sid, endpoint } = newSession(res);
    res.write(`event: endpoint\ndata: ${endpoint}\n\n`);
    res.write(': ready\n\n');
    req.on('close', () => sessions.delete(sid));
    return;
  }

  // ---- 2024-11-05 HTTP+SSE：上行（POST 只回 202，响应走上面的下行流） ----
  if (mode === 'sse' && req.method === 'POST' && url.pathname === '/messages') {
    const sid = url.searchParams.get('sessionId') || '';
    const sess = sessions.get(sid);
    if (!sess) return sendJson(res, 404, null);
    const raw = await readBody(req);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, null);
    }
    const out = handleRequest(msg);
    res.writeHead(202, { 'Content-Length': 0 });
    res.end();
    if (out) sess.res.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
    return;
  }

  // ---- 2025-06-18 Streamable HTTP ----
  if (mode === 'streamable' && req.method === 'POST' && url.pathname === '/mcp') {
    const raw = await readBody(req);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: '非法 JSON' } });
    }
    const out = handleRequest(msg);
    if (out === null) return sendJson(res, 202, null);
    const sid = req.headers['mcp-session-id'] || `sess-${++seq}`;
    // 客户端要求 SSE 时按帧回（`initialize` 必须带上会话号，否则客户端下一句就带上不认识的 id）。
    // FIXTURE_SSE=0 强制走"直接一条 JSON"的形态——两条合法路径都要被测到。
    const wants = String(req.headers.accept || '');
    if (process.env.FIXTURE_SSE !== '0' && wants.includes('text/event-stream') && !wants.startsWith('application/json')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Mcp-Session-Id': sid,
        Connection: 'keep-alive',
      });
      res.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
      res.end();
      return;
    }
    return sendJson(res, 200, out, { 'Mcp-Session-Id': sid });
  }

  if (req.method === 'DELETE' && url.pathname === '/mcp') {
    res.writeHead(204);
    res.end();
    return;
  }

  return sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32000, message: `not found: ${req.method} ${url.pathname}` } });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mcp-http-fixture ${mode} on ${JSON.stringify(server.address())}`);
});
