/**
 * 插件/技能目录 API（T-011）。
 *
 * 后端废弃后的取态，按"有没有真相源"分三类：
 *
 *   - **真的**：目录清单（随包静态 JSON，主进程读）、本机评分（store）、
 *     本地已装技能（扫磁盘，目录顺序与 agent-ts 的 skill.ts 一致）、
 *     模型清单（走 agent 的 models/list RPC）、安装（落到 agent 自己的 mcp.json）。
 *   - **做不到的**：技能 zip 导入（要解压+安全扫描+评测）、上架/下架/安装已上架
 *     （要远端市场）、脚手架生成、能力推荐（要模型参与）——如实抛错，界面禁用按钮。
 *   - 刻意不拿"看起来差不多"的本地启发式去顶替推荐/评测：那类结果看着有、
 *     实际不对，比直接说做不到更容易误导人。
 */
import { planBrowserForSpec } from './system-browser';

export interface CatalogItem {
  name: string;
  desc: string;
  icon: string;
  color: string;
  cats: string[];
  /** 内置技能包的分类（界面据此分组：50+ 个技能平铺没法用） */
  category?: string;
  /** 出处（EvaWork 自撰 / 上游项目名） */
  origin?: string;
  /** T-030：安装/启用状态由后端合并进目录项，便于市场直接反映。 */
  installed?: boolean;
  enabled?: boolean;
  /** T-076：本地真有 SKILL.md（可用 `/name` 唤起）；`local`=市场里没有、纯本地技能。 */
  loaded?: boolean;
  local?: boolean;
  /** 技能来源（扫描根的 rank 决定）：项目级 / 自定义 / 用户级 / 随包内置。界面据此挂徽章。 */
  scope?: 'project' | 'custom' | 'user' | 'builtin';
  /** T-141b / T3：能力声明（network/fs_write/command/context）；安装弹层据此人话展示，未声明则按 network 处理 */
  capabilities?: string[];
  /** T-142 / T2：版本号，用于更新检测 */
  version?: string;
  /** T-142 / T5：发布者 + 是否已验证（三级信任：官方 / 已验证 / 社区） */
  publisher?: string;
  verified?: boolean;
  /** T-142 / T19：网络出口 allowlist（声明插件允许访问的域名；未声明=不限） */
  egress_policy?: string[];
  /** T-142 / T9：本机真实安装次数（市场安装量） */
  downloads?: number;
  /** T-142 / T9：评分（本地用户评分优先，否则目录基线） */
  rating?: number | null;
  rating_comment?: string;
  my_rating?: number | null;
  /** T-142 / T12：本机上架技能标记（published = 来自本机发布市场） */
  source?: string;
  /** 真实可安装来源（npm 包名 / 本地命令）——有它才是真能装的条目 */
  spec?: string;
  install_kind?: string;
  tools_hint?: string;
  /** 需要用户补的启动参数（如 Sentry 的 --access-token=...） */
  needs_args?: boolean;
  /** 需要用户提供的环境变量名（如 SENTRY_ACCESS_TOKEN） */
  needs_env?: string[];
  /** 人话说明：这个包装完要做什么才算可用 */
  setup_hint?: string;
  /** T-142 / T21：声明的多模态能力（image_gen / video_in / audio_in …） */
  abilities?: string[];
  /** T-142 / T21：多模态就绪度（缺通道/缺模型如实报） */
  multimodal?: {
    name: string;
    abilities: string[];
    unmet: string[];
    ready: boolean | null;
    details: { ability: string; label: string; usable: boolean; reason: string; has_channel: boolean }[];
  };
}

export interface CatalogMeta {
  pluginCats: string[];
  skillCats: string[];
  counts: { plugins: number; skills: number };
}

/** T-142 / T6：安全扫描结果（统一结构，后端 security.py 产出）。 */
export interface SecurityScan {
  risk: 'safe' | 'warn' | 'danger' | 'unknown' | 'n/a';
  findings?: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
  note?: string;
}

/** T-142 / T18：行为评测报告（引爆室）。 */
export interface SkillEvalReport {
  kind: string;
  static_risk?: string;
  static_summary?: Record<string, unknown>;
  egress?: Record<string, unknown>;
  verdict: string; // passed | warn | rejected
}

/** T-142 / T8：从 .skill.zip 导入技能到用户级技能目录。 */
/** 导入 .skill.zip：要解压 + 安全扫描 + 行为评测，本地没有这条流水线。 */
export async function importSkill(_file: File): Promise<{ imported: string; description: string; path: string; scan?: SecurityScan; eval_report?: SkillEvalReport }> {
  return unavailable('技能导入', '需要解压与安全评测流水线，本地没有');
}

/** T-142 / T16：能力智能推荐。返回带可解释理由的候选能力清单。 */
export interface Recommendation {
  name: string;
  kind: 'plugin' | 'skill';
  desc: string;
  cats: string[];
  capabilities: string[];
  provides_context: string[];
  publisher?: string;
  score: number;
  reasons: string[];
  installed: boolean;
}

/** 能力推荐要模型参与打分，本地没有推理链路——不拿关键词匹配冒充"智能推荐"。 */
export async function fetchRecommendations(_task: string, _limit = 6): Promise<{ task: string; recommendations: Recommendation[] }> {
  return unavailable('能力推荐', '需要模型参与打分，本地没有推理链路');
}

/** T-142 / T15：上下文提供者（插件/技能声明的 provides_context）。 */
export interface ContextProvider {
  name: string;
  kind: 'plugin' | 'skill';
  desc: string;
  publisher?: string;
  provides_context: string[];
  context_labels: string[];
  installed: boolean;
  relevance?: number;
  reasons?: string[];
}

/** 上下文提供者同样依赖模型判定相关性，本地没有推理链路。 */
export async function fetchContextProviders(_task: string, _limit = 8): Promise<{ task: string; providers: ContextProvider[] }> {
  return unavailable('上下文提供者', '需要模型判定相关性，本地没有推理链路');
}

/** T-142 / T20：技能回滚到导入前的上一个版本。 */
/** 技能回滚：本地技能是磁盘上的文件，没有版本历史可回。 */
export async function rollbackSkill(_name: string): Promise<Record<string, unknown>> {
  return unavailable('技能回滚', '本地技能是磁盘上的文件，没有版本历史');
}

interface CatalogBridge {
  catalogMeta?: () => Promise<CatalogMeta & { ok?: boolean; reason?: string }>;
  catalogItems?: (a: { kind?: string; cat?: string; q?: string }) => Promise<{ ok: boolean; reason?: string; items?: CatalogItem[]; total?: number }>;
  catalogReload?: () => Promise<{ ok?: boolean; reason?: string }>;
  mcpCreate?: (a: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string; item?: { id: string } }>;
  storePut?: (name: string, item: unknown) => Promise<{ ok: boolean; reason?: string }>;
  skillsInstalled?: () => Promise<{ ok: boolean; reason?: string; items?: LoadedSkill[]; root?: string; total?: number }>;
  skillDetail?: (name: string) => Promise<{ ok: boolean; reason?: string; item?: LoadedSkill }>;
  tsAgent?: { models?: (args?: Record<string, unknown>) => Promise<ModelList & { ok?: boolean; reason?: string }> };
}

function bridge<K extends keyof CatalogBridge>(key: K): CatalogBridge[K] {
  const b = (window as unknown as { evawork?: CatalogBridge }).evawork;
  const fn = b && b[key];
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），目录不可用');
  return fn;
}

function must<T extends { ok?: boolean; reason?: string }>(r: T, what: string): T {
  if (!r || r.ok === false) throw new Error((r && r.reason) || `${what}失败`);
  return r;
}

/** 本地没有这条链路时抛的错：成句说明缺什么，界面照原样显示即可。 */
function unavailable(what: string, why: string): never {
  throw new Error(`${what}暂不可用：${why}`);
}

export async function fetchPlugins(p: { cat?: string; q?: string; sort?: string; refresh?: boolean } = {}): Promise<{ items: CatalogItem[]; total: number }> {
  const r = must(await bridge('catalogItems')!({ kind: 'plugins', cat: p.cat || '', q: p.q || '' }), '读取插件目录');
  return { items: r.items || [], total: r.total ?? (r.items || []).length };
}

export async function fetchSkills(p: { cat?: string; q?: string; sort?: string; refresh?: boolean } = {}): Promise<{ items: CatalogItem[]; total: number }> {
  const r = must(await bridge('catalogItems')!({ kind: 'skills', cat: p.cat || '', q: p.q || '' }), '读取技能目录');
  return { items: r.items || [], total: r.total ?? (r.items || []).length };
}

/** T-142 / T11：生成插件开发脚手架（离线，零依赖）。 */
/** 脚手架生成：后端那套是离线零依赖的，本地尚未移植，不做半成品。 */
export async function createScaffold(
  _name: string,
  _opts: { capabilities?: string[]; egress?: string[]; withSubagent?: boolean; force?: boolean } = {},
): Promise<{ name: string; path: string; install_spec: string; files: string[]; note: string }> {
  return unavailable('脚手架生成', '尚未移植到本地');
}

/** T-142 / T12：技能市场上架（作者侧）。 */
export interface PublishedSkill extends CatalogItem {
  source?: string;
  audit?: { scan_risk?: string; eval_verdict?: string; at?: number };
  versions?: string[];
  published_at?: number;
}

/* 上架/下架/安装已上架：这是**远端市场**的功能（要有个地方存别人能拉的产物）。
   本地没有市场服务端，硬做个"本机上架列表"别人也看不到，不如如实说做不到。 */
export async function publishSkill(
  _file: File,
  _version = '1.0.0',
  _publisher = '本机作者',
  _force = false,
): Promise<PublishedSkill> {
  return unavailable('技能上架', '需要远端市场服务，本地没有');
}

export async function installPublishedSkill(_name: string): Promise<{ name: string; version: string; path: string }> {
  return unavailable('安装已上架技能', '需要远端市场服务，本地没有');
}

export async function unpublishSkill(_name: string): Promise<{ name: string }> {
  return unavailable('技能下架', '需要远端市场服务，本地没有');
}

export function fetchPublishedSkills(): Promise<{ items: PublishedSkill[] }> {
  return Promise.resolve({ items: [] });
}

/** T-142 / T9：给扩展打分（1-5）+ 可选评论。 */
/** T-142：安装一个插件（可装目录外的包 / 可声明信任来源）。 */
/**
 * 安装一个插件：落到 agent 自己的 mcp.json（npm 类用 `npx -y <spec>`，
 * 远程类登记 http/sse 地址）。装完智能体真的会加载它——不是只记一笔状态。
 */
export async function installPluginItem(
  name: string,
  body: { spec?: string; url?: string; transport?: string; mode?: string; approved?: boolean; custom?: boolean; trust?: boolean; args?: string[]; env?: Record<string, string> },
): Promise<Record<string, unknown>> {
  const b = body || {};
  if (b.approved === false) throw new Error('未批准安装');
  const payload: Record<string, unknown> = { name, source: 'catalog', enabled: true };
  if (String(b.url || '').trim()) {
    Object.assign(payload, { transport: b.transport || 'http', url: String(b.url).trim() });
  } else if (String(b.spec || '').trim()) {
    const spec = String(b.spec).trim();
    // 目录里的本地命令类（如 uvx/python）直接跑；npm 包走 npx 按需拉取
    const knownCmd = /^(uvx|python3?|node|docker)\b/.test(spec);
    Object.assign(payload, {
      transport: 'stdio',
      command: knownCmd ? spec.split(/\s+/)[0] : 'npx',
      args: knownCmd ? spec.split(/\s+/).slice(1) : ['-y', spec],
    });
  } else {
    throw new Error('缺少 spec 或 url');
  }
  if (Array.isArray(b.args) && b.args.length) {
    const cur = Array.isArray(payload.args) ? payload.args : [];
    payload.args = cur.concat(b.args);
  }
  if (b.env && Object.keys(b.env).length) payload.env = b.env;
  /* 浏览器类插件（Playwright）：把"驱动系统 Edge/Chrome"以 env 写进服务配置，
     它就不用再去下载/依赖自带的 Chromium。用户自己填的 env 优先，所以放在下层。 */
  const plan = await planBrowserForSpec(String(b.spec || '').trim());
  if (Object.keys(plan.env).length) {
    payload.env = { ...plan.env, ...((payload.env as Record<string, string>) || {}) };
  }
  const r = must(await bridge('mcpCreate')!(payload), '安装插件');
  return { installed: true, name, server_id: r.item?.id, browser: plan.browser, browser_notice: plan.notice };
}

/** 评分存本机（store 的 ratings 集合），主进程读目录时会合并进条目。 */
export async function rateItem(name: string, score: number, comment = ''): Promise<{ name: string; score: number; comment: string }> {
  must(await bridge('storePut')!('ratings', { id: name, score, comment }), '保存评分');
  return { name, score, comment };
}

/** 丢弃主进程的静态目录缓存，强制重读 catalog.json（界面「刷新目录」用）。 */
export async function reloadCatalog(): Promise<void> {
  must(await bridge('catalogReload')!(), '刷新插件目录');
}

export async function fetchCatalogMeta(): Promise<CatalogMeta> {
  const r = must(await bridge('catalogMeta')!(), '读取目录分类');
  return {
    pluginCats: r.pluginCats || ['全部'],
    skillCats: r.skillCats || ['全部'],
    counts: r.counts || { plugins: 0, skills: 0 },
  };
}

/** T-076：本地已加载的技能（SKILL.md）——可 `/name` 直接唤起。 */
export interface LoadedSkill {
  name: string;
  description: string;
  body: string;
  allowed_tools: string[];
  scripts: string[];
  path: string;
  source: string;
  tools: string[];
}

export async function fetchInstalledSkills(): Promise<{
  items: LoadedSkill[];
  root: string;
  total: number;
}> {
  const r = must(await bridge('skillsInstalled')!(), '读取本地技能');
  return { items: r.items || [], root: r.root || '', total: r.total ?? 0 };
}

export async function fetchSkillDetail(name: string): Promise<LoadedSkill> {
  const r = await bridge('skillDetail')!(name);
  if (!r.ok || !r.item) throw new Error(r.reason || '没有这个技能');
  return r.item;
}

/** 模型清单：来自模型通道（eva 通道即 eva-ai 的 /api/ai/v1/models），不是本地写死的名单。 */
export interface ModelItem {
  id: string;
  name: string;
  /** T-141：模型目录带出的元数据 —— 定位描述与自动选择档位（heavy/balanced/fast/long/code） */
  desc?: string;
  tier?: string;
  /** T-141：可用能力标签（text/reasoning/code/image_in/…，中文名见界面的 ABILITY_NAMES） */
  abilities?: string[];
  /** T-141：思考强度（low/high/max） */
  thinking?: string;
  /** 上下文窗口大小（token），与模型广场 contextWindow 同源 */
  contextWindow?: number;
  /** S-25：true＝用户自己添加的通道（`custom:<id>`），用它时不走 EVA 登录态 */
  custom?: boolean;
}

export interface ModelList {
  ok: boolean;
  models: ModelItem[];
  /** 通道侧默认模型（未指定时用它） */
  default: string;
  provider: string;
  /** ok=false 时的原因，供界面提示 */
  error: string;
  /** S-25：EVA 通道那份没拿到（如未登录）但自定义通道可用时的说明 */
  channel_error?: string;
}

/** 模型清单走 agent 的 models/list RPC（按需临时拉起子进程，要凭据但不需要会话在跑）。 */
export async function fetchModels(force = false): Promise<ModelList> {
  const b = (window as unknown as { evawork?: CatalogBridge }).evawork;
  const fn = b?.tsAgent?.models;
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），模型清单不可用');
  const r = await fn({ force });
  if (r && r.ok === false) {
    return { ok: false, models: [], default: '', provider: '', error: r.reason || '模型清单不可用' };
  }
  return {
    ok: true,
    models: (r && r.models) || [],
    default: (r && r.default) || '',
    provider: (r && r.provider) || '',
    error: '',
    channel_error: r && r.channel_error,
  };
}
