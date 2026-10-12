/**
 * 最小 MCP server（只用 Node 标准库），用于 T-030/T-031 的**端到端**冒烟。
 *
 * 为什么需要它：本机无外网，装不到 @modelcontextprotocol/server-* 之类的现成 server，
 * 但 MCP 客户端必须被真进程验证过才算数——不能只测自己发自己收。
 * 这里用最朴素的方式实现 JSON-RPC over stdio：行分隔 JSON，支持
 * initialize / notifications/initialized / tools/list / tools/call。
 *
 * 用法：node scripts/fixtures/mcp-echo.mjs
 */
process.stdin.setEncoding('utf8');

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(line);
  }
});

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

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // 非法 JSON 直接忽略
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // 通知：不需要响应

  const ok = (result) => send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize': {
      const want = params?.protocolVersion;
      // 只认两个已知版本；其他版本按协议要求返回 -32600，客户端据此回退重试
      if (!want || !['2025-06-18', '2024-11-05'].includes(want)) {
        fail(-32600, `不支持的协议版本：${want}`);
        return;
      }
      ok({ protocolVersion: want, capabilities: { tools: {} }, serverInfo: { name: 'evawork-fixture', version: '1.0.0' } });
      return;
    }
    case 'tools/list':
      ok({ tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === 'echo') ok({ content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }], isError: false });
      else if (name === 'add') ok({ content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }], isError: false });
      else if (name === 'write_note') ok({ content: [{ type: 'text', text: `已记录：${args.text ?? ''}` }], isError: false });
      else fail(-32601, `未知工具：${name}`);
      return;
    }
    default:
      fail(-32601, `不支持的方法：${method}`);
  }
}
