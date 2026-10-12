/**
 * 插件安装 / MCP 服务 API（T-030 + T-031）。
 *
 * 后端废弃后的取态：**MCP 服务是真的**，其它要远端市场或模型的能力如实说做不到。
 *
 *   - MCP 服务增删改 + 工具发现：主进程直接读写 **agent-ts 自己的
 *     `~/.evawork/ts-agent/mcp.json`**（不是另起一份配置）。另起一份会让
 *     "界面里加好了、智能体根本看不见"变成一个静默的坑——比报错糟得多。
 *     工具发现是真 spawn 一次 JSON-RPC 握手，不猜工具清单（猜的点下去必失败）。
 *   - 从目录"安装"：npm 类用 `npx -y <spec>` 起（不需要落盘安装，也是各家
 *     客户端的通行做法）；远程类登记 http/sse 地址。两者都落到上面那份配置里。
 *   - 遥测开关：本机 KV，真的生效（计数恒为 0——本地没有任何上报点，不编数字）。
 *   - Tracing / 安全评测 / 灰度 / 回滚：本地没有对应的采集与执行链路，
 *     **如实抛错或返回空**，不用假数据充数。界面据此禁用按钮，而不是点了没反应。
 */

export interface InstalledPlugin {
  name: string;
  spec: string;
  source: string;
  server_id: string;
  command: string;
  enabled: boolean;
  installed_at: number;
  /** T-141b / T3：安装时从目录项声明的能力，管理面板据此回显 */
  capabilities?: string[];
  /** T-141 / T2：安装时记录的版本（更新检查/兼容矩阵用） */
  version?: string;
  /** T-142 / T13：传输（stdio / http / sse）；来源见上面的 source */
  transport?: string;
  url?: string;
  /** T-142 / T5：发布者，管理面板据此回显来源 */
  publisher?: string;
  /** T-142 / T6：安装时安全扫描结果（npm 依赖审计；本地命令为 n/a） */
  scan?: SecurityScan;
  /** T-142 / T19：能力票据（最小权限集合：capabilities + egress + quotas） */
  capability_ticket?: {
    capabilities?: string[];
    egress?: string[];
    quotas?: Record<string, unknown>;
  };
  /** T-142 / T20：是否存在可回滚的上一个版本 */
  can_rollback?: boolean;
  /** T-142 / T23：版本兼容状态（ok/update/update_staged/needs_agent） */
  compat?: {
    status: 'ok' | 'update' | 'update_staged' | 'needs_agent';
    detail: string;
    latest_version: string;
    installed_version: string;
    rollout_pct: number;
    in_cohort: boolean;
    bucket: number;
  };
  note?: string;
  /** 命令行参数（判定"这是哪个包"要用，例如 -y @playwright/mcp） */
  args?: string[];
  /** 服务进程的环境变量：浏览器类服务靠它选"驱动哪个浏览器 / 要不要无头"。
      主进程会把它一起投影进 agent 的 mcp.json（desktop-node/src/mcp.js 的 syncToAgent）。 */
  env?: Record<string, string>;
}

/** T-142 / T23：灰度分桶属于远端发布侧的机制，本地没有服务端配合，设了也不生效。 */
export function setRollout(name: string, cohortPct: number): Promise<{ name: string; cohort_pct: number; in_cohort: boolean; bucket: number }> {
  return Promise.reject(new Error(`灰度暂不可用：需要远端发布服务配合（${name} / ${cohortPct}%）`));
}

import type { SecurityScan } from './catalog';
import { planBrowserForSpec } from './system-browser';

export interface InstallResult extends InstalledPlugin {
  installed: boolean;
  already: boolean;
  server?: MCPServer;
  tools?: MCPTool[];
}

export interface MCPServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  transport: string; // stdio / http / sse（T-093）
  url?: string; // http、sse 的服务地址
  headers?: Record<string, string>;
  source: string;
  enabled: boolean;
  created_at?: number;
  tools_count?: number;
  tools?: MCPTool[];
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface PluginsBridge {
  mcpList?: () => Promise<{ ok: boolean; reason?: string; items?: McpRow[] }>;
  mcpCreate?: (a: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string; item?: McpRow }>;
  mcpPatch?: (id: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string; item?: McpRow }>;
  mcpDelete?: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  mcpTools?: (id: string, refresh: boolean) => Promise<{ ok: boolean; tools?: MCPTool[]; error?: string }>;
  settingsGet?: () => Promise<{ ok: boolean; items?: Record<string, unknown> }>;
  settingsPut?: (patch: Record<string, unknown>) => Promise<{ ok: boolean; items?: Record<string, unknown> }>;
}

/** 主进程里的 MCP 条目：字段比界面类型多，这里只声明用到的部分。 */
interface McpRow {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  transport?: string;
  url?: string;
  source?: string;
  enabled?: boolean;
  created_at?: number;
  tools?: MCPTool[];
  note?: string;
  env?: Record<string, string>;
}

function bridge<K extends keyof PluginsBridge>(key: K): PluginsBridge[K] {
  const b = (window as unknown as { evawork?: PluginsBridge }).evawork;
  const fn = b && b[key];
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），插件功能不可用');
  return fn;
}

function must<T extends { ok?: boolean; reason?: string }>(r: T, what: string): T {
  if (!r || r.ok === false) throw new Error((r && r.reason) || `${what}失败`);
  return r;
}

async function listRows(): Promise<McpRow[]> {
  const r = must(await bridge('mcpList')!(), '读取 MCP 服务');
  return r.items || [];
}

/** MCP 条目 → 界面要的"已安装插件"形状。 */
function toInstalled(s: McpRow): InstalledPlugin {
  return {
    name: s.name,
    spec: String(s.command || s.url || ''),
    source: String(s.source || 'user'),
    server_id: s.id,
    command: String(s.command || ''),
    enabled: s.enabled !== false,
    installed_at: Number(s.created_at) || 0,
    transport: String(s.transport || 'stdio'),
    url: s.url,
    note: s.note || '',
    args: Array.isArray(s.args) ? s.args : [],
    env: s.env && typeof s.env === 'object' ? { ...s.env } : {},
  };
}

/**
 * 改一条 MCP 服务的环境变量（整体替换 env 字段）。
 * 主进程 mcpPatch 认 env（见 desktop-node/src/mcp.js），改完会重新投影进 mcp.json。
 */
export async function patchMcpEnv(id: string, env: Record<string, string>): Promise<void> {
  must(await bridge('mcpPatch')!(id, { env }), '保存浏览器设置');
}

/** 已安装插件状态表：{ 名称: 状态 }。真相源就是 MCP 服务清单。 */
export async function fetchInstalledPlugins(): Promise<Record<string, InstalledPlugin>> {
  const rows = await listRows();
  const out: Record<string, InstalledPlugin> = {};
  for (const s of rows) out[s.name] = toInstalled(s);
  return out;
}

/** T-142 / T20：回滚——用 npx 起的服务没有本地版本历史，无可回滚。 */
export function rollbackPlugin(name: string): Promise<InstalledPlugin> {
  return Promise.reject(new Error(`没有可回滚的版本：${name} 由 npx 按需拉取，未在本地留版本`));
}

/** T-142 / T22：端到端 Tracing（按插件聚合）。 */
export interface TraceRow {
  plugin: string;
  calls: number;
  ok: number;
  fail: number;
  success_rate: number;
  avg_ms: number;
  cost: number;
  last_error: string;
  tools: Record<string, number>;
}
/* Tracing：调用发生在 agent-ts 子进程里，主进程没有采集点。
   返回空而不是造一条"看起来有数据"的记录——Tracing 页是用来排查的，假数据比空白有害。 */
export function fetchTracing(): Promise<{ total_spans: number; per_plugin: TraceRow[] }> {
  return Promise.resolve({ total_spans: 0, per_plugin: [] });
}
export function clearTracing(): Promise<{ total_spans: number; per_plugin: TraceRow[] }> {
  return Promise.resolve({ total_spans: 0, per_plugin: [] });
}

/** T-142 / T14：安全边界评测流水线（回归）。 */
export interface EvalCase { name: string; tags: string[]; ok: boolean; detail: string; ms: number }
export interface EvalReport {
  ran_at: number; total: number; passed: number; failed: number;
  pass_rate: number; elapsed_ms: number; cases: EvalCase[];
  catalog_audit: { total: number; compliant: number; non_compliant: number; rows: { name: string; kind: string; missing: string[] }[] } | null;
}
/* 安全边界评测要真跑一批用例（含模型参与），本地没有这条执行链路。
   如实抛错，界面会禁用按钮——比返回一份"全通过"的假报告安全得多。 */
export function runSecurityEvals(): Promise<EvalReport> {
  return Promise.reject(new Error('安全评测暂不可用：本地没有评测执行链路'));
}
export function fetchEvalHistory(): Promise<{ items: { ran_at: number; passed: number; total: number; failed_cases: string[] }[] }> {
  return Promise.resolve({ items: [] });
}

/** T-142 / T10：遥测最小集（默认关、匿名、不含内容/凭据）。 */export interface TelemetrySummary {
  enabled: boolean;
  anon_id: string;
  total: number;
  per_plugin: Record<string, { install: number; uninstall: number; toggle: number; crash: number }>;
}
/* 遥测：开关是真的（本机 KV，界面改了就生效）；计数恒为 0——
   本地没有任何上报点，不编数字。anon_id 本机随机生成一次，不含任何身份信息。 */
export async function fetchTelemetry(): Promise<TelemetrySummary> {
  const r = await bridge('settingsGet')!();
  const on = Boolean(r.items && r.items.telemetry);
  return { enabled: on, anon_id: '', total: 0, per_plugin: {} };
}
export async function setTelemetry(enabled: boolean): Promise<TelemetrySummary> {
  await bridge('settingsPut')!({ telemetry: Boolean(enabled) });
  return { enabled: Boolean(enabled), anon_id: '', total: 0, per_plugin: {} };
}

/** T-142 / T18：插件行为评测（引爆室）——要真跑用例并让模型判定，本地没有这条链路。 */
export function evaluatePlugin(name: string): Promise<Record<string, unknown>> {
  return Promise.reject(new Error(`插件评测暂不可用：本地没有评测执行链路（${name}）`));
}

/**
 * 从目录安装（npm 类）：用 `npx -y <spec>` 起服务——不必落盘安装，
 * 也是各家 MCP 客户端的通行做法。登记的正是 agent 会读的那份配置。
 */
export async function installPlugin(name: string, spec: string, approved: boolean): Promise<InstallResult> {
  if (!approved) throw new Error('未批准安装');
  if (!String(spec || '').trim()) throw new Error('缺少 spec');
  /* 浏览器类插件（Playwright）：把"驱动系统 Edge/Chrome"以 env 写进服务配置，
     免得它去下载/依赖自带的 Chromium（见 ./system-browser 的说明）。 */
  const plan = await planBrowserForSpec(spec);
  const r = must(
    await bridge('mcpCreate')!({
      name,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', String(spec).trim()],
      env: plan.env,
      source: 'catalog',
      enabled: true,
    }),
    '安装插件',
  );
  const item = r.item as McpRow;
  return { ...toInstalled(item), installed: true, already: false };
}

/** T-142 / T13：接入远程托管 MCP（Streamable HTTP / SSE）。 */
export async function installRemotePlugin(
  name: string,
  url: string,
  transport: '' | 'http' | 'sse',
  approved: boolean,
): Promise<InstallResult> {
  if (!approved) throw new Error('未批准安装');
  const r = must(
    await bridge('mcpCreate')!({ name, transport: transport || 'http', url, source: 'catalog', enabled: true }),
    '接入远程 MCP',
  );
  const item = r.item as McpRow;
  return { ...toInstalled(item), installed: true, already: false };
}

export async function togglePlugin(name: string, enabled: boolean): Promise<InstalledPlugin> {
  const rows = await listRows();
  const hit = rows.find((s) => s.name === name);
  if (!hit) throw new Error('插件未安装');
  const r = must(await bridge('mcpPatch')!(hit.id, { enabled }), '切换启用');
  return toInstalled(r.item as McpRow);
}

export async function uninstallPlugin(name: string): Promise<{ uninstalled: string }> {
  const rows = await listRows();
  const hit = rows.find((s) => s.name === name);
  if (!hit) throw new Error('插件未安装');
  must(await bridge('mcpDelete')!(hit.id), '卸载插件');
  return { uninstalled: name };
}

/**
 * 一键更新：npx 每次都拉最新，所以"更新"等价于**重新握手拉一次工具清单**。
 * 不是假返回 updated:true——工具确实会按最新版本重新发现。
 */
export async function updatePlugin(name: string): Promise<InstalledPlugin & { updated: boolean }> {
  const rows = await listRows();
  const hit = rows.find((s) => s.name === name);
  if (!hit) throw new Error('插件未安装');
  await bridge('mcpTools')!(hit.id, true);
  const fresh = await listRows();
  const now = fresh.find((s) => s.id === hit.id) || hit;
  return { ...toInstalled(now), updated: true };
}

/** 插件带来的工具清单（真握手结果；失败时 error 是成句原因）。 */
export async function fetchPluginTools(name: string): Promise<{ tools: MCPTool[]; error?: string }> {
  const rows = await listRows();
  const hit = rows.find((s) => s.name === name);
  if (!hit) return { tools: [], error: '插件未安装' };
  const r = await bridge('mcpTools')!(hit.id, false);
  return { tools: r.tools || [], error: r.error };
}

/* ---------------- MCP 服务管理 ---------------- */

export async function fetchMCPServers(): Promise<MCPServer[]> {
  const rows = await listRows();
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    command: String(s.command || ''),
    args: s.args || [],
    transport: String(s.transport || 'stdio'),
    url: s.url,
    source: String(s.source || 'user'),
    enabled: s.enabled !== false,
    created_at: Number(s.created_at) || 0,
    tools: s.tools || [],
    tools_count: (s.tools || []).length,
  }));
}

/** T-093：stdio 用 command+args，http/sse 用 url（可选带 headers）。 */
export interface MCPServerCreatePayload {
  name: string;
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  source?: string;
}

export async function createMCPServer(p: MCPServerCreatePayload): Promise<MCPServer> {
  const r = must(await bridge('mcpCreate')!({ ...p }), '新建 MCP 服务');
  const it = r.item as McpRow;
  return {
    id: it.id,
    name: it.name,
    command: String(it.command || ''),
    args: it.args || [],
    transport: String(it.transport || 'stdio'),
    url: it.url,
    source: String(it.source || 'user'),
    enabled: it.enabled !== false,
    created_at: Number(it.created_at) || 0,
  };
}

export async function patchMCPServer(id: string, patch: Partial<MCPServer>): Promise<MCPServer> {
  const r = must(await bridge('mcpPatch')!(id, { ...patch }), '修改 MCP 服务');
  const it = r.item as McpRow;
  return {
    id: it.id,
    name: it.name,
    command: String(it.command || ''),
    args: it.args || [],
    transport: String(it.transport || 'stdio'),
    url: it.url,
    source: String(it.source || 'user'),
    enabled: it.enabled !== false,
    created_at: Number(it.created_at) || 0,
  };
}

export async function deleteMCPServer(id: string): Promise<{ deleted: string }> {
  must(await bridge('mcpDelete')!(id), '删除 MCP 服务');
  return { deleted: id };
}

/** 工具发现：真 spawn 握手一次（不是猜清单）。失败时 error 是成句原因。 */
export async function discoverMCPTools(id: string, refresh = false): Promise<{ tools: MCPTool[]; error?: string }> {
  const r = await bridge('mcpTools')!(id, refresh);
  return { tools: r.tools || [], error: r.error };
}
