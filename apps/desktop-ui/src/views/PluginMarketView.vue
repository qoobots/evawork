<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import UIcon from '@/components/UIcon.vue';
import UAsync from '@/components/UAsync.vue';
import { pluginCats, pluginFeatureCards, plugins, skillCats, skills } from '@/data/mock';
import { bridgeAvailable } from '@/api/backend';
import {
  fetchCatalogMeta,
  reloadCatalog,
  fetchPlugins,
  fetchSkills,
  importSkill,
  fetchRecommendations,
  fetchContextProviders,
  rateItem,
  createScaffold,
  publishSkill,
  installPluginItem,
  installPublishedSkill,
  unpublishSkill,
  fetchPublishedSkills,
  type PublishedSkill,
  type CatalogItem,
  type CatalogMeta,
  type SecurityScan,
  type Recommendation,
  type ContextProvider,
  rollbackSkill,
} from '@/api/catalog';
import {
  fetchInstalledPlugins,
  fetchPluginTools,
  installRemotePlugin,
  togglePlugin,
  uninstallPlugin,
  updatePlugin,
  rollbackPlugin,
  evaluatePlugin,
  fetchTelemetry,
  setTelemetry,
  fetchTracing,
  clearTracing,
  setRollout,
  runSecurityEvals,
  type EvalReport,
  type InstalledPlugin,
  type MCPTool,
  type TelemetrySummary,
  type TraceRow,
} from '@/api/plugins';
import { useAsyncData } from '@/composables/useAsyncData';
import { useEscape } from '@/composables/useEscape';
import { useI18nStore } from '@/stores/i18n';
import { resolveItems } from '@/utils/market';
import { fetchSubAgents, delegateTask, type SubAgent, type DelegateResult } from '@/api/subagents';

const i18n = useI18nStore();

const tab = ref<'plugin' | 'skill' | 'recommend' | 'subagent'>('plugin');
const cat = ref('全部');
const skillCat = ref('全部');
const keyword = ref('');

/* ---------- T-011：接后端目录；无后端时本地兜底（界面永不空白） ---------- */
const online = computed(() => bridgeAvailable());

// 搜索防抖：避免每敲一个字都打后端
const kw = ref('');
let kwTimer: ReturnType<typeof setTimeout> | undefined;
watch(keyword, (v) => {
  if (kwTimer) clearTimeout(kwTimer);
  kwTimer = setTimeout(() => {
    kw.value = v;
  }, 300);
});

// T-142 / D2：过滤 / 排序 / 离线回退统一走 utils/market.ts 的单一实现
// （在线走后端已过滤排序的结果；离线用本地 mock 并套用同一套规则，保证顺序一致）
const mockPlugins = plugins as unknown as CatalogItem[];
const mockSkills = skills as unknown as CatalogItem[];

// 强制刷新目录：丢弃后端内存缓存（后端默认缓存 1h，不刷新就看不到刚改的 catalog.json）
const refreshingCatalog = ref(false);
async function doRefreshCatalog() {
  refreshingCatalog.value = true;
  try {
    // 先清主进程内存缓存，否则重读的还是旧 catalog.json
    if (online.value) await reloadCatalog().catch(() => {});
    await runMeta();
    await reloadPlugins();
    await reloadSkills();
  } finally {
    refreshingCatalog.value = false;
  }
}

// 分类元数据
const { data: meta, run: runMeta } = useAsyncData<CatalogMeta>(() =>
  online.value
    ? fetchCatalogMeta()
    : Promise.resolve({
        pluginCats,
        skillCats,
        counts: { plugins: plugins.length, skills: skills.length },
      }),
);

// T-142 / T9：排序（信任级>评分>安装量 / 纯评分 / 纯安装量），插件与技能共用
const sortMode = ref<'trust' | 'rating' | 'downloads'>('trust');
const sortOptions = [
  { id: 'trust', label: '信任优先' },
  { id: 'rating', label: '评分优先' },
  { id: 'downloads', label: '安装量优先' },
] as const;

// 插件列表（分类/关键词/排序变化时自动重新拉取）
const plugParams = computed(() => ({ cat: cat.value, q: kw.value, sort: sortMode.value }));
const {
  data: pluginData,
  loading: pluginLoading,
  error: pluginError,
  reload: reloadPlugins,
  run: runPlugins,
} = useAsyncData<CatalogItem[]>(
  () =>
    resolveItems<CatalogItem>({
      online: online.value,
      fetchRemote: () => fetchPlugins({ cat: cat.value, q: kw.value.trim(), sort: sortMode.value }).then((r) => r.items),
      mock: mockPlugins,
      cat: cat.value,
      q: kw.value.trim(),
      sort: sortMode.value,
      refresh: refreshingCatalog.value,
    }),
  [plugParams, refreshingCatalog],
);

// 技能列表
const skillParams = computed(() => ({ cat: skillCat.value, sort: sortMode.value }));
const {
  data: skillData,
  loading: skillLoading,
  error: skillError,
  reload: reloadSkills,
  run: runSkills,
} = useAsyncData<CatalogItem[]>(
  () =>
    resolveItems<CatalogItem>({
      online: online.value,
      fetchRemote: () => fetchSkills({ cat: skillCat.value, sort: sortMode.value }).then((r) => r.items),
      mock: mockSkills,
      cat: skillCat.value,
      sort: sortMode.value,
      refresh: refreshingCatalog.value,
    }),
  [skillParams, refreshingCatalog],
);

/* 技能按分类分组：内置技能包把技能数推到 50+，**平铺一屏等于没分类**。
   顺序按"最可能先被用到"排，而不是按字母或数量。 */
const SKILL_CAT_ORDER = ['流程与编排', '工程实践', '界面与设计', '文档与写作', '办公与协作', '数据与分析'];
const skillGroups = computed(() => {
  const items = (skillData.value ?? []) as CatalogItem[];
  const map = new Map<string, CatalogItem[]>();
  for (const s of items) {
    const k = s.category || '其他';
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(s);
  }
  return [...map.entries()]
    .map(([cat, list]) => ({ cat, list }))
    .sort((a, b) => {
      const ia = SKILL_CAT_ORDER.indexOf(a.cat);
      const ib = SKILL_CAT_ORDER.indexOf(b.cat);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || b.list.length - a.list.length;
    });
});

// 首次加载：三个数据源各跑一次（后续由各自 watch 的参数变化驱动）
onMounted(() => {
  void runMeta();
  void runPlugins();
  void runSkills();
  void refreshInstalled();
});

/* ---------- T-030：真实安装 / 启用 / 卸载 ----------
   后端是唯一事实来源：已装什么由 /api/plugins/installed 说了算，
   界面只读地把它显示出来；按钮点了必须有真实副作用，否则宁可禁用。 */
const installed = ref<Record<string, InstalledPlugin>>({});
const busyName = ref('');
const actErr = ref('');

async function refreshInstalled() {
  if (!online.value) return;
  try {
    installed.value = await fetchInstalledPlugins();
  } catch {
    installed.value = {}; // 列表拉不到不影响浏览市场，但下面所有"操作"仍会真实报错
  }
}

/** 已安装优先以注册表为准，其次用目录项里后端合并好的 installed/enabled。 */
function instState(item: CatalogItem) {
  const row = installed.value[item.name];
  if (row) return { installed: true, enabled: row.enabled !== false };
  return { installed: Boolean(item.installed), enabled: item.enabled !== false };
}

/** T-142 / T2：目录最新版本 ≠ 已装版本 → 可更新 */
function needsUpdate(item: CatalogItem): boolean {
  if (!instState(item).installed) return false;
  const cur = installed.value[item.name]?.version;
  return !!(cur && item.version && item.version !== cur);
}

/** T-142 / T5：三级信任（官方 / 已验证 / 社区） */
function trustLevel(item: CatalogItem): 'official' | 'verified' | 'community' {
  if (item.verified && item.publisher === 'EvaWorks') return 'official';
  if (item.verified) return 'verified';
  return 'community';
}
function trustCls(item: CatalogItem): string {
  return trustLevel(item);
}
function trustLbl(item: CatalogItem): string {
  return { official: '官方', verified: '已验证', community: '社区' }[trustLevel(item)];
}

// T-142 / T6：安全扫描结果展示
function scanRiskLbl(s: SecurityScan | null | undefined): string {
  if (!s || s.risk === 'safe') return '未见风险';
  if (s.risk === 'n/a') return '不适用';
  if (s.risk === 'unknown') return '未执行（离线/无 npm）';
  return s.risk === 'danger' ? '高危' : '告警';
}
function scanSummary(s: SecurityScan | null | undefined): string {
  if (!s || !s.summary) return '';
  const sm = s.summary as Record<string, number>;
  const parts = Object.entries(sm).filter(([, v]) => typeof v === 'number' && v > 0).map(([k, v]) => `${k}:${v}`);
  return parts.length ? `依赖漏洞 — ${parts.join('，')}` : '未发现已知漏洞';
}
function installedScan(item: CatalogItem): string {
  return (installed.value[item.name]?.scan as SecurityScan | undefined)?.risk || '';
}

async function reloadAll() {
  await refreshInstalled();
  await reloadPlugins();
  await reloadSkills();
}

async function doToggle(item: CatalogItem, enabled: boolean) {
  busyName.value = item.name;
  actErr.value = '';
  try {
    await togglePlugin(item.name, enabled);
    await reloadAll();
  } catch (e) {
    actErr.value = `${item.name}：${(e as Error).message}`;
  } finally {
    busyName.value = '';
  }
}

async function doUninstall(item: CatalogItem) {
  busyName.value = item.name;
  actErr.value = '';
  try {
    await uninstallPlugin(item.name);
    await reloadAll();
  } catch (e) {
    actErr.value = `${item.name}：${(e as Error).message}`;
  } finally {
    busyName.value = '';
  }
}

/** T-142 / T2：一键更新（重装即升级，保留启用状态）。 */
const updating = ref('');
async function doUpdate(item: CatalogItem) {
  updating.value = item.name;
  actErr.value = '';
  try {
    await updatePlugin(item.name);
    await reloadAll();
  } catch (e) {
    actErr.value = `${item.name}：${(e as Error).message}`;
  } finally {
    updating.value = '';
  }
}

/* ---------- 安装弹层 ---------- */
const installTarget = ref<CatalogItem | null>(null);
const spec = ref('');
// T-142 / T13：安装来源二选一（本地/包 vs 远程托管 MCP）
const installKind = ref<'local' | 'remote'>('local');
const remoteUrl = ref('');
const remoteTransport = ref<'' | 'http' | 'sse'>('');
// T-142：目录外安装 + 显式信任（信任才给 medium 完整性；默认仍是最严的 low）
const customInstall = ref(false);
const trustSource = ref(false);
const confirmed = ref(false);
const installing = ref(false);
const installErr = ref('');
const installScan = ref<SecurityScan | null>(null);
const installTools = ref<MCPTool[]>([]);
// 安装成功后按钮要变成「已安装」并禁用；工具清单默认折叠（避免几十条刷屏）
const installDone = ref(false);
const toolsExpanded = ref(false);
const installIntegrity = ref('');
// 部分真实 MCP server 必须带参数/令牌（如 Sentry）；令牌只用于本次安装请求，不写入目录
const extraArgs = ref('');
const extraEnv = ref('');
const canInstall = computed(() =>
  (installKind.value === 'remote' ? remoteUrl.value.trim().length > 0 : spec.value.trim().length > 0)
  && confirmed.value,
);

// T-141b / T3：能力声明人话解释 + 本地命令（完整权限）识别
const CAP_LABELS: Record<string, string> = {
  network: '可访问网络（对外发起请求）',
  fs_write: '可写入你的文件',
  command: '可执行命令 / 脚本',
  context: '可向智能体提供上下文',
};
function capLabel(c: string): string {
  return CAP_LABELS[c] || c;
}
// 与后端 plugins.looks_local() 同一套判定。关键：**scoped npm 包（@scope/name）含 "/"
// 但不是本地命令**——旧正则只判 "/" 会把 npm 包误标为"本地命令将以完整用户权限运行"。
const isLocalSpec = computed(() => {
  const s = spec.value.trim();
  if (!s) return false;
  if (/^@[^/@\s]+\/[^/@\s]+$/.test(s)) return false; // @scope/name → npm 包
  if (/^@[^/@\s]+\/[^/@\s]+$/.test(installTarget.value?.spec || '')) return false;
  return /\b(node|python|python3|py|npx|uv)\b|[\/\\]|(\.mjs|\.cjs|\.js|\.py|\.exe|\.cmd|\.bat|\.sh)\b/i.test(s);
});

function openInstall(item: CatalogItem) {
  actErr.value = '';
  installTarget.value = item;
  // 目录项自带 spec（真实可安装来源）时直接预填：用户点安装即可用，不必自己猜包名
  spec.value = item.spec || '';
  installKind.value = 'local';
  remoteUrl.value = '';
  remoteTransport.value = '';
  customInstall.value = false;
  trustSource.value = false;
  confirmed.value = false;
  installing.value = false;
  installErr.value = '';
  installTools.value = [];
  installScan.value = null;
  installDone.value = !!installed.value?.[item.name];
  toolsExpanded.value = false;
  installIntegrity.value = '';
  extraArgs.value = '';
  extraEnv.value = '';
}

function closeInstall() {
  installTarget.value = null;
}

// T-053：Esc 关闭安装弹层 / 管理面板
useEscape(() => {
  if (installTarget.value) closeInstall();
  else if (manageOpen.value) manageOpen.value = false;
});

async function doInstall() {
  if (!installTarget.value || !canInstall.value || installing.value) return;
  installing.value = true;
  installErr.value = '';
  try {
    // T-142：来源三选一——目录自带 spec / 目录外自填 / 远程托管 MCP
    const name = installTarget.value.name;
    // 解析补充参数：空格分隔的 CLI 参数；env 走 KEY=VALUE 逐行
    const argv = extraArgs.value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    const envObj: Record<string, string> = {};
    for (const line of extraEnv.value.split(/[\n;]/)) {
      const t = line.trim();
      if (!t) continue;
      const i = t.indexOf('=');
      if (i > 0) envObj[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    const res = installKind.value === 'remote'
      ? await installRemotePlugin(name, remoteUrl.value.trim(), remoteTransport.value, true)
      : await installPluginItem(name, {
          spec: spec.value.trim(),
          custom: customInstall.value,
          trust: trustSource.value,
          args: argv,
          env: envObj,
        });
    installTools.value = (res.tools as MCPTool[]) || [];
    installScan.value = (res as unknown as { scan?: SecurityScan }).scan || null;
    installIntegrity.value = String((res as unknown as { integrity?: string }).integrity || '');
    installDone.value = true;   // 按钮变「已安装」并禁用
    toolsExpanded.value = false; // 工具清单默认折叠
    await reloadAll();
  } catch (e) {
    // 后端会把 npm 的真实失败（如无外网）放在 detail 里，这里原样展示
    installErr.value = (e as Error).message || '安装失败';
  } finally {
    installing.value = false;
  }
}

/* ---------- 管理面板（T7）：已装列表 / 启停 / 卸载 / 查看工具 ---------- */
const manageOpen = ref(false);
const installedPlugins = ref<Record<string, InstalledPlugin>>({});
const manageBusy = ref(false);
const manageErr = ref('');
const installedList = computed(() => Object.values(installedPlugins.value));

const toolsOpen = ref('');
const toolsMap = ref<Record<string, MCPTool[]>>({});
const toolsBusy = ref(false);
const toolsErr = ref('');

// T-142 / T18：行为评测（引爆室）展开状态与结果
const evalOpen = ref('');
const evalMap = ref<Record<string, Record<string, unknown>>>({});
const evalBusy = ref(false);
const evalErr = ref('');

// T-142 / T14：安全边界评测流水线（回归）
const evalReport = ref<EvalReport | null>(null);
const evalRunBusy = ref(false);
const evalRunMsg = ref('');
async function doRunEvals() {
  evalRunBusy.value = true;
  evalRunMsg.value = '';
  try {
    const r = await runSecurityEvals();
    evalReport.value = r;
    evalRunMsg.value = r.failed === 0
      ? `安全评测：${r.passed}/${r.total} 全部通过（${r.elapsed_ms}ms）`
      : `安全评测：${r.failed} 项失败，需修复`;
  } catch (e) {
    evalRunMsg.value = `评测失败：${(e as Error).message}`;
  } finally {
    evalRunBusy.value = false;
  }
}

// T-142 / T22：端到端 Tracing（按插件聚合的调用量/成功率/延迟/崩溃）
const traceRows = ref<TraceRow[]>([]);
const traceBusy = ref(false);
async function loadTracing() {
  if (!online.value) return;
  try {
    const r = await fetchTracing();
    traceRows.value = r.per_plugin || [];
  } catch {
    /* 忽略 */
  }
}
async function doClearTracing() {
  traceBusy.value = true;
  try {
    await clearTracing();
    await loadTracing();
  } catch (e) {
    manageErr.value = (e as Error).message;
  } finally {
    traceBusy.value = false;
  }
}

// T-142 / T10：遥测最小集（默认关；仅本机聚合，无内容/凭据）
const telemetry = ref<TelemetrySummary | null>(null);
const telemetryBusy = ref(false);
async function loadTelemetry() {
  if (!online.value) return;
  try {
    telemetry.value = await fetchTelemetry();
  } catch {
    /* 离线忽略 */
  }
}
async function toggleTelemetry() {
  telemetryBusy.value = true;
  try {
    telemetry.value = await setTelemetry(!telemetry.value?.enabled);
  } catch (e) {
    manageErr.value = (e as Error).message;
  } finally {
    telemetryBusy.value = false;
  }
}

async function openManage() {
  manageErr.value = '';
  manageBusy.value = true;
  toolsOpen.value = '';
  try {
    installedPlugins.value = await fetchInstalledPlugins();
    await loadTelemetry();
    await loadTracing();
    manageOpen.value = true;
  } catch (e) {
    manageErr.value = (e as Error).message;
  } finally {
    manageBusy.value = false;
  }
}

// T-142 / T23：兼容状态标签 + 灰度分组设置
function compatLbl(p: InstalledPlugin): string {
  const c = p.compat;
  if (!c) return '';
  if (c.status === 'needs_agent') return '需升级 agent';
  if (c.status === 'update') return '可更新';
  if (c.status === 'update_staged') return '待灰度';
  return '';
}
async function doSetRollout(name: string, pct: number) {
  try {
    await setRollout(name, pct);
    await openManage(); // 刷新兼容状态
  } catch (e) {
    manageErr.value = (e as Error).message;
  }
}

async function manageToggle(name: string, enabled: boolean) {
  try {
    const r = await togglePlugin(name, enabled);
    installedPlugins.value = {
      ...installedPlugins.value,
      [name]: { ...installedPlugins.value[name], enabled: r.enabled },
    };
  } catch (e) {
    manageErr.value = `${name}：${(e as Error).message}`;
  }
}

/** T-7：管理面板里的卸载（就地更新已装表，不整页刷新）。 */
async function doManageUninstall(name: string) {
  try {
    await uninstallPlugin(name);
    const next = { ...installedPlugins.value };
    delete next[name];
    installedPlugins.value = next;
    if (toolsOpen.value === name) toolsOpen.value = '';
  } catch (e) {
    manageErr.value = `${name}：${(e as Error).message}`;
  }
}

async function manageRollback(name: string) {
  busyName.value = name;
  actErr.value = '';
  try {
    await rollbackPlugin(name);
    installedPlugins.value = await fetchInstalledPlugins();
    await refreshInstalled();
  } catch (e) {
    actErr.value = `${name}：${(e as Error).message}`;
  } finally {
    busyName.value = '';
  }
}

async function toggleTools(name: string) {
  if (toolsOpen.value === name) {
    toolsOpen.value = '';
    return;
  }
  toolsOpen.value = name;
  toolsErr.value = '';
  toolsBusy.value = true;
  try {
    const r = await fetchPluginTools(name);
    toolsMap.value = { ...toolsMap.value, [name]: r.tools || [] };
  } catch (e) {
    toolsErr.value = (e as Error).message;
  } finally {
    toolsBusy.value = false;
  }
}

async function toggleEval(name: string) {
  if (evalOpen.value === name) {
    evalOpen.value = '';
    return;
  }
  evalOpen.value = name;
  evalErr.value = '';
  evalBusy.value = true;
  try {
    const r = await evaluatePlugin(name);
    evalMap.value = { ...evalMap.value, [name]: r };
  } catch (e) {
    evalErr.value = (e as Error).message;
  } finally {
    evalBusy.value = false;
  }
}

// T-142 / T16：能力智能推荐
const recTask = ref('');
const recs = ref<Recommendation[]>([]);
const recLoading = ref(false);
const recErr = ref('');
const recSearched = ref(false);
async function runRecommend() {
  recLoading.value = true;
  recErr.value = '';
  recSearched.value = true;
  try {
    const r = await fetchRecommendations(recTask.value.trim(), 8);
    recs.value = r.recommendations;
  } catch (err) {
    recErr.value = `推荐失败：${(err as Error).message}`;
    recs.value = [];
  } finally {
    recLoading.value = false;
  }
  await loadContextProviders();
}
function openInstallByName(r: Recommendation) {
  openInstall({ name: r.name, desc: r.desc, publisher: r.publisher, capabilities: r.capabilities } as CatalogItem);
}

// T-142 / T15：上下文提供者（随推荐任务一起拉取，展示相关上下文注入点）
const ctxProviders = ref<ContextProvider[]>([]);
async function loadContextProviders() {
  try {
    const r = await fetchContextProviders(recTask.value.trim(), 8);
    ctxProviders.value = r.providers;
  } catch {
    ctxProviders.value = [];
  }
}

// T-142 / T11：插件开发脚手架（离线一键生成最小可跑插件工程）
// T-142 / T17：Sub-agent 编排（发现 + 委派）
const subAgents = ref<SubAgent[]>([]);
const subLoading = ref(false);
const subTarget = ref('');
const subTask = ref('');
const subInput = ref('');
const subBusy = ref(false);
const subMsg = ref('');
const subErr = ref('');
const subResult = ref<DelegateResult | null>(null);
async function loadSubAgents() {
  if (!online.value) return;
  subLoading.value = true;
  try {
    subAgents.value = (await fetchSubAgents()).items || [];
  } catch (e) {
    subErr.value = (e as Error).message;
  } finally {
    subLoading.value = false;
  }
}
async function doDelegate() {
  subErr.value = "";
  subMsg.value = "";
  subResult.value = null;
  if (!subTarget.value) { subErr.value = "请先选一个子智能体"; return; }
  const inputs: Record<string, unknown> = {};
  const k = subInput.value.trim();
  if (k) inputs.target = k;
  subBusy.value = true;
  try {
    subResult.value = await delegateTask(subTarget.value, subTask.value.trim() || "请完成这个子任务", inputs);
    subMsg.value = `已委派给「${subTarget.value}」（${subResult.value.mode} 模式）`;
  } catch (e) {
    subErr.value = (e as Error).message;
  } finally {
    subBusy.value = false;
  }
}

const scaffoldName = ref('');
const scaffoldCaps = ref('');
const scaffoldEgress = ref('');
const scaffoldBusy = ref(false);
const scaffoldOut = ref<{ path: string; install_spec: string; files: string[]; note: string } | null>(null);
const scaffoldErr = ref('');
async function doScaffold() {
  scaffoldErr.value = '';
  scaffoldOut.value = null;
  const name = scaffoldName.value.trim();
  if (!name) {
    scaffoldErr.value = '请先填插件名';
    return;
  }
  scaffoldBusy.value = true;
  try {
    const caps = scaffoldCaps.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    const eg = scaffoldEgress.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    scaffoldOut.value = await createScaffold(name, { capabilities: caps, egress: eg });
  } catch (e) {
    scaffoldErr.value = `生成失败：${(e as Error).message}`;
  } finally {
    scaffoldBusy.value = false;
  }
}

// T-142 / T12：技能市场上架（作者侧）
const pubFile = ref<HTMLInputElement | null>(null);
const pubVersion = ref('1.0.0');
const pubPublisher = ref('本机作者');
const pubBusy = ref(false);
const pubMsg = ref('');
const pubErr = ref('');
const myPublished = ref<PublishedSkill[]>([]);
async function loadPublished() {
  if (!online.value) return;
  try {
    myPublished.value = (await fetchPublishedSkills()).items || [];
  } catch { /* 忽略 */ }
}
async function onPublishFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  pubBusy.value = true;
  pubMsg.value = '';
  pubErr.value = '';
  try {
    const r = await publishSkill(file, pubVersion.value.trim() || '1.0.0', pubPublisher.value.trim() || '本机作者');
    pubMsg.value = `已上架「${r.name}」v${r.version}（审核：扫描 ${r.audit?.scan_risk || '?'} / 评测 ${r.audit?.eval_verdict || '?'}），已出现在技能市场`;
    await reloadSkills();
    await loadPublished();
  } catch (err) {
    pubErr.value = `上架被拒或失败：${(err as Error).message}`;
  } finally {
    pubBusy.value = false;
    input.value = '';
  }
}
async function doInstallPublished(name: string) {
  pubBusy.value = true;
  pubErr.value = '';
  try {
    const r = await installPublishedSkill(name);
    pubMsg.value = `已安装「${r.name}」v${r.version} 到用户级技能目录：可用 /${r.name} 唤起`;
    await reloadSkills();
  } catch (err) {
    pubErr.value = `安装失败：${(err as Error).message}`;
  } finally {
    pubBusy.value = false;
  }
}
async function doUnpublish(name: string) {
  pubBusy.value = true;
  pubErr.value = '';
  try {
    await unpublishSkill(name);
    pubMsg.value = `已下架「${name}」（版本体与审核记录保留在本机，可再上架）`;
    await loadPublished();
    await reloadSkills();
  } catch (err) {
    pubErr.value = `下架失败：${(err as Error).message}`;
  } finally {
    pubBusy.value = false;
  }
}

// T-142 / T9：打分（1-5 星）+ 可选评论，本机存储
const rateMsg = ref('');
async function doRate(item: CatalogItem, score: number) {
  rateMsg.value = '';
  try {
    const comment = (item.rating_comment || '');
    await rateItem(item.name, score, comment);
    await reloadPlugins();
    await reloadSkills();
    rateMsg.value = `已为「${item.name}」评分 ${score} 星`;
  } catch (err) {
    rateMsg.value = `评分失败：${(err as Error).message}`;
  }
}
function stars(n: number | null | undefined): string {
  const v = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
  return '★'.repeat(v) + '☆'.repeat(5 - v);
}

// T-142 / T8：上传技能（.skill.zip 导入到用户级技能目录）
const skillFile = ref<HTMLInputElement | null>(null);
const skillUploading = ref(false);
const skillMsg = ref('');
async function onSkillFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  skillUploading.value = true;
  skillMsg.value = '';
  try {
    const r = await importSkill(file);
    const sc = r.scan;
    const scanTxt = sc && sc.risk && sc.risk !== 'safe'
      ? `（安全扫描：${scanRiskLbl(sc)}）`
      : '（安全扫描：未见风险）';
    const ev = r.eval_report;
    const evalTxt = ev ? `；行为评测：${ev.verdict === 'passed' ? '通过' : ev.verdict === 'rejected' ? '拒上架' : '需留意'}` : '';
    skillMsg.value = `已导入技能「${r.imported}」：可在对话中用 /${r.imported} 唤起${scanTxt}${evalTxt}`;
  } catch (err) {
    skillMsg.value = `导入失败：${(err as Error).message}`;
  } finally {
    skillUploading.value = false;
    input.value = ''; // 允许重复选择同一文件
  }
}
async function doRollbackSkill(s: CatalogItem) {
  busyName.value = s.name;
  skillMsg.value = '';
  try {
    await rollbackSkill(s.name);
    await reloadSkills();
    skillMsg.value = `已回滚技能「${s.name}」到上一个版本`;
  } catch (err) {
    skillMsg.value = `回滚失败：${(err as Error).message}`;
  } finally {
    busyName.value = '';
  }
}

const artIcon: Record<string, string> = { code: 'code', media: 'video', chart: 'chart' };
const artBg: Record<string, string> = {
  code: 'linear-gradient(135deg, #23262d, #3a3f4a)',
  media: 'linear-gradient(135deg, #8fb7f2, #5b8ef2)',
  chart: 'linear-gradient(135deg, #eaf1ff, #cfe0fb)',
};
</script>

<template>
  <div class="page market">
    <div class="page-head">
      <div>
        <h1 class="page-title">{{ i18n.t('page.market.title') }}</h1>
        <div class="page-sub">{{ i18n.t('page.market.sub') }}</div>
      </div>
      <button class="btn" :disabled="refreshingCatalog" @click="doRefreshCatalog" title="重新读取插件目录（后端默认缓存 1 小时）">
        <UIcon name="search" :size="13" /> {{ refreshingCatalog ? '刷新中…' : '刷新目录' }}
      </button>
      <button class="btn" @click="openManage" title="管理已安装插件"><UIcon name="sliders" :size="13" /> 管理</button>
    </div>

    <div class="tab-row">
      <div class="seg">
        <button class="seg-item" :class="{ active: tab === 'plugin' }" @click="tab = 'plugin'">插件</button>
        <button class="seg-item" :class="{ active: tab === 'skill' }" @click="tab = 'skill'">技能</button>
        <button class="seg-item" :class="{ active: tab === 'recommend' }" @click="tab = 'recommend'">能力推荐</button>
        <button class="seg-item" :class="{ active: tab === 'subagent' }" @click="tab = 'subagent'; loadSubAgents()">Sub-agent</button>
      </div>
      <div class="spacer" />
      <!-- T-142 / T9：排序（信任级>评分>安装量） -->
      <select v-if="tab === 'plugin' || tab === 'skill'" v-model="sortMode" class="sort-sel" title="排序方式">
        <option v-for="o in sortOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
      </select>
      <div v-if="tab === 'plugin'" class="search-box input" style="width: 220px">
        <UIcon name="search" :size="13" style="color: var(--t3)" />
        <input v-model="keyword" placeholder="搜索插件" style="border: none; outline: none; width: 100%; font-size: 12.5px; background: none" />
      </div>
      <button v-else class="btn btn-dark" :disabled="skillUploading" @click="skillFile?.click()">
        <UIcon name="upload" :size="13" /> {{ skillUploading ? '导入中…' : '上传技能' }}
      </button>
      <input ref="skillFile" type="file" accept=".zip" style="display: none" @change="onSkillFile" />
    </div>

    <p v-if="skillMsg" class="act-err">
      <UIcon name="info" :size="13" /> <span>{{ skillMsg }}</span>
      <button class="ua-btn" @click="skillMsg = ''">关闭</button>
    </p>

    <!-- 插件 Tab -->
    <template v-if="tab === 'plugin'">
      <div class="feature-row">
        <div v-for="f in pluginFeatureCards" :key="f.title" class="feature-card card">
          <div class="feature-info">
            <div class="feature-t">{{ f.title }}</div>
            <ul>
              <li v-for="it in f.items" :key="it"><span class="li-dot" /> {{ it }}</li>
            </ul>
          </div>
          <div class="feature-art" :style="{ background: artBg[f.art] }">
            <UIcon :name="artIcon[f.art]" :size="30" style="color: rgba(255,255,255,0.85)" />
          </div>
        </div>
      </div>

      <div class="chips-row">
        <button
          v-for="c in (meta?.pluginCats ?? pluginCats)" :key="c" class="chip"
          :class="{ active: cat === c }" @click="cat = c"
        >{{ c }}</button>
      </div>

      <p v-if="actErr" class="act-err">
        <UIcon name="info" :size="13" /> <span>{{ actErr }}</span>
        <button class="ua-btn" @click="actErr = ''">关闭</button>
      </p>
      <p v-if="rateMsg" class="act-err">
        <UIcon name="info" :size="13" /> <span>{{ rateMsg }}</span>
        <button class="ua-btn" @click="rateMsg = ''">关闭</button>
      </p>

      <UAsync
        :loading="pluginLoading" :error="pluginError"
        hint="正在加载插件…" @retry="reloadPlugins"
      >
        <div class="grid3 plug-grid">
          <!-- stack：与技能卡同一套纵向分层。插件的操作元素同样多（徽章 + 更新/停用/卸载），
               横排会把描述压成一条窄线（截图里就是这样）。 -->
          <div v-for="p in (pluginData ?? [])" :key="p.name" class="plug-card plug-card-stack card">
            <div class="plug-top">
              <span class="plug-ic" :style="{ background: p.color, color: 'rgba(28,30,36,0.78)' }"><UIcon :name="p.icon" :size="18" /></span>
              <div class="plug-info">
              <div class="plug-name">
                {{ p.name }}
                <span class="plug-badge trust" :class="trustCls(p)">{{ trustLbl(p) }}</span>
                <!-- T-142 / T21：需要多模态能力（未就绪时标红提示） -->
                <span
                  v-if="p.multimodal && p.multimodal.abilities.length"
                  class="plug-badge" :class="p.multimodal.ready ? 'skill' : 'scan danger'"
                  :title="p.multimodal.details.map((d) => `${d.label}：${d.usable ? '可用' : d.reason}`).join('；')"
                >{{ p.multimodal.ready ? '多模态就绪' : '缺多模态通道' }}</span>
              </div>
              <div class="plug-desc" :title="p.desc">{{ p.desc }}</div>
              <!-- T-142 / T9：评分（可点星打分）+ 本机安装量。**已安装的不显示**——
                   本机装好的插件没有市场评分，那一串星星是噪音，还会和打分按钮混成一团。 -->
              <div v-if="!instState(p).installed" class="plug-rate">
                <span class="rate-stars" :title="p.rating ? `社区评分 ${p.rating}` : '还没有人评分'">{{ stars(p.rating) }}</span>
                <span v-if="p.rating" class="rate-num">{{ p.rating }}</span>
                <span class="rate-dl" title="本机安装次数">⬇ {{ p.downloads ?? 0 }}</span>
                <span class="rate-do" title="给它打分（你的评分只记在本机）">
                  <span class="rate-do-lbl">你的评分</span>
                  <button
                    v-for="n in 5" :key="n" class="rate-star" :class="{ on: n <= (p.my_rating || 0) }"
                    :title="`打 ${n} 星`" @click="doRate(p, n)"
                  >★</button>
                </span>
              </div>
              </div>
            </div>
            <!-- T-030：安装/启用/停用/卸载，全部走后端真实状态 -->
            <div class="plug-acts">
              <template v-if="instState(p).installed">
                <span class="plug-badge" :class="{ on: instState(p).enabled }">
                  {{ instState(p).enabled ? i18n.t('common.enabled') : i18n.t('common.disabled') }}
                </span>
                <span v-if="instState(p).installed && installedScan(p) === 'danger'" class="plug-badge scan danger">高危</span>
                <span v-else-if="instState(p).installed && installedScan(p) === 'warn'" class="plug-badge scan warn">告警</span>
                <span v-if="needsUpdate(p)" class="plug-badge upd">可更新 · {{ p.version }}</span>
                <button
                  v-if="needsUpdate(p)" class="install-btn" :disabled="updating === p.name"
                  @click="doUpdate(p)"
                >{{ updating === p.name ? '更新中…' : '更新' }}</button>
                <button
                  class="install-btn" :disabled="busyName === p.name"
                  @click="doToggle(p, !instState(p).enabled)"
                >{{ instState(p).enabled ? i18n.t('common.disable') : i18n.t('common.enable') }}</button>
                <button
                  class="install-btn" :disabled="busyName === p.name" @click="doUninstall(p)"
                >{{ i18n.t('common.uninstall') }}</button>
              </template>
              <button
                v-else class="install-btn" :disabled="!online || !p.spec"
                :title="!p.spec ? '该条目暂未声明安装来源' : (online ? i18n.t('common.install') : i18n.t('common.offline'))"
                @click="openInstall(p)"
              ><UIcon name="plus" :size="12" /> {{ p.spec ? i18n.t('common.install') : '暂无安装源' }}</button>
            </div>
          </div>
        </div>
      </UAsync>

      <!-- T-142 / T11：插件开发脚手架（离线一键生成最小可跑插件工程） -->
      <div class="scaffold card">
        <div class="sc-title"><UIcon name="code" :size="14" /> 开发你的插件</div>
        <p class="im-hint">
          离线生成一个<b>零依赖、可直接本地安装调试</b>的 MCP 插件工程：清单（capabilities / egress_policy / agent_protocol）、
          服务骨架、sub-agent 模板。生成后用「本地命令」安装即可真跑。
        </p>
        <div class="sc-row">
          <input v-model="scaffoldName" class="sc-input" placeholder="插件名，如 my-reviewer" />
          <input v-model="scaffoldCaps" class="sc-input" placeholder="能力，逗号分隔（network, command）" />
          <input v-model="scaffoldEgress" class="sc-input" placeholder="出口 allowlist（api.github.com）" />
          <button class="install-btn" :disabled="scaffoldBusy || !online" @click="doScaffold">
            {{ scaffoldBusy ? '生成中…' : '生成脚手架' }}
          </button>
        </div>
        <p v-if="scaffoldErr" class="act-err"><UIcon name="info" :size="13" /> {{ scaffoldErr }}</p>
        <div v-if="scaffoldOut" class="sc-out">
          <p class="im-ok"><UIcon name="check" :size="13" /> 已生成：<code>{{ scaffoldOut.path }}</code></p>
          <p class="im-hint">在市场点「安装」，来源填这条本地命令：</p>
          <p class="im-tool"><b>{{ scaffoldOut.install_spec }}</b></p>
          <p class="im-scan-sum">文件：{{ scaffoldOut.files.join('、') }}。{{ scaffoldOut.note }}</p>
        </div>
      </div>
    </template>

    <!-- 技能 Tab -->
    <template v-else-if="tab === 'skill'">
      <div class="chips-row" style="margin-top: 22px">
        <button
          v-for="c in (meta?.skillCats ?? skillCats)" :key="c" class="chip"
          :class="{ active: skillCat === c }" @click="skillCat = c"
        >{{ c }}</button>
      </div>

      <UAsync
        :loading="skillLoading" :error="skillError"
        hint="正在加载技能…" @retry="reloadSkills"
      >
        <!-- 按分类分组：标题 + 该组卡片（无分类的技能落在「其他」里，不会丢）。
             ⚠️ v-for 用 `g in ...` 而不是 `[cat, list] in ...`：Vue 3 模板表达式
             不支持数组解构，编译器会报 "Element is missing end tag" 把整个页面挂掉
             （而且 vue-tsc 抓不到，只有运行时编译才炸）。 -->
        <template v-for="g in skillGroups" :key="g.cat">
        <div class="skill-cat">
          {{ g.cat }}<span class="skill-cat-n">{{ g.list.length }}</span>
        </div>
        <div class="grid3 plug-grid">
          <!-- stack：技能的操作按钮最多 4 个（已启用/停用/卸载/回退），沿用插件卡的横向布局
               会把信息区挤成一条竖线、标题被挤到换行——所以技能卡改为**纵向分层**。 -->
          <div v-for="s in g.list" :key="s.name" class="plug-card plug-card-stack card">
            <div class="plug-top">
              <span class="plug-ic" :style="{ background: s.color, color: s.color === '#111111' ? '#fff' : 'inherit' }"><UIcon :name="s.icon" :size="18" /></span>
              <div class="plug-info">
                <div class="plug-name">
                  {{ s.name }}
                  <!-- 徽章说的是"这个技能从哪来"：随包内置 / 项目级 / 本机 / 市场已加载。
                       只挂一个：两个都挂等于把同一句话说两遍。 -->
                  <span v-if="s.scope === 'builtin'" class="plug-tag local" title="内置技能，随应用分发（apps/skills）">内置</span>
                  <span v-else-if="s.scope === 'project'" class="plug-tag local" title="项目级技能（工作区 .evawork/skills、.eva-skills、skills）">项目</span>
                  <span v-else-if="s.scope === 'custom'" class="plug-tag local" title="EVAWORK_SKILL_DIR 指定的技能目录">自定义</span>
                  <span v-else-if="s.local" class="plug-tag local" title="本机技能（~/.evawork/skills）">本机</span>
                  <span v-else-if="s.loaded" class="plug-tag" title="本地已加载该技能（可用 /name 唤起）">已加载</span>
                </div>
                <div class="plug-desc" :title="s.desc">{{ s.desc }}</div>
              <!-- T-142 / T9：评分 + 本机安装量。**本地/内置技能不显示**——
                   它们没有市场评分，显示"1 个人评分"纯属噪音还会让人以为是热门官方技能。 -->
              <div v-if="!s.local" class="plug-rate">
                <span class="rate-stars" :title="s.rating ? `评分 ${s.rating}` : '未评分'">{{ stars(s.rating) }}</span>
                <span v-if="s.rating" class="rate-num">{{ s.rating }}</span>
                <span class="rate-dl" title="本机安装次数">⬇ {{ s.downloads ?? 0 }}</span>
                <span class="rate-do">
                  <button
                    v-for="n in 5" :key="n" class="rate-star" :class="{ on: n <= (s.my_rating || 0) }"
                    :title="`打 ${n} 星`" @click="doRate(s, n)"
                  >★</button>
                </span>
              </div>
            </div>
            </div>
            <div class="plug-acts">
              <template v-if="s.source === 'published' && !instState(s).installed">
                <!-- T-142 / T12：本机上架技能：一键装进用户级技能目录 -->
                <span class="plug-badge trust official" title="本机作者上架，已过安全扫描与行为评测">本机上架</span>
                <button class="install-btn" :disabled="pubBusy || !online" @click="doInstallPublished(s.name)">一键安装</button>
              </template>
              <template v-else-if="instState(s).installed">
                <span class="plug-badge" :class="{ on: instState(s).enabled }">
                  {{ instState(s).enabled ? i18n.t('common.enabled') : i18n.t('common.disabled') }}
                </span>
                <button
                  class="install-btn" :disabled="busyName === s.name"
                  @click="doToggle(s, !instState(s).enabled)"
                >{{ instState(s).enabled ? i18n.t('common.disable') : i18n.t('common.enable') }}</button>
                <button
                  class="install-btn" :disabled="busyName === s.name" @click="doUninstall(s)"
                >{{ i18n.t('common.uninstall') }}</button>
              </template>
              <!-- S-01：无安装源的目录条目**诚实禁用**（对齐插件 tab 的同一道守卫，
                   PluginMarketView.vue:939-942）。此前这里只判 !online，按钮长得能点，
                   点了却因为 canInstall 恒为 false 而静默返回——「点了没反应」比直接禁用更伤。 -->
              <button
                v-else class="install-btn" :disabled="!online || !s.source"
                :title="!s.source ? '该条目暂未声明安装来源' : (online ? i18n.t('common.install') : i18n.t('common.offline'))"
                @click="openInstall(s)"
              ><UIcon name="plus" :size="12" /> {{ s.source ? i18n.t('common.install') : '暂无安装源' }}</button>
              <!-- T-142 / T20：已导入（loaded）的技能可一键回滚到上一个版本 -->
              <button
                v-if="s.loaded" class="install-btn" :disabled="busyName === s.name"
                @click="doRollbackSkill(s)"
              >回滚上一版</button>
            </div>
          </div>
          </div>
        </template>
      </UAsync>

      <!-- T-142 / T12：技能市场上架（作者侧发布 → 过扫描/评测 → 市场可装） -->
      <div class="scaffold card">
        <div class="sc-title"><UIcon name="upload" :size="14" /> 上架我的技能</div>
        <p class="im-hint">
          上传 <code>.skill.zip</code>，先过<b>安全扫描 + 行为评测</b>，通过才进市场；高危技能会被<b>直接拒上架</b>并说明原因。
        </p>
        <div class="sc-row">
          <input v-model="pubVersion" class="sc-input" style="min-width: 110px" placeholder="版本 1.0.0" />
          <input v-model="pubPublisher" class="sc-input" style="min-width: 130px" placeholder="发布者" />
          <button class="install-btn" :disabled="pubBusy || !online" @click="pubFile?.click()">
            {{ pubBusy ? '处理中…' : '选择 .skill.zip 上架' }}
          </button>
        </div>
        <input ref="pubFile" type="file" accept=".zip" style="display: none" @change="onPublishFile" />
        <p v-if="pubMsg" class="im-ok"><UIcon name="check" :size="13" /> {{ pubMsg }}</p>
        <p v-if="pubErr" class="act-err"><UIcon name="info" :size="13" /> {{ pubErr }}</p>
        <div v-if="myPublished.length" class="sc-out">
          <p class="im-hint">我在架的技能：</p>
          <div v-for="it in myPublished" :key="it.name" class="trace-row">
            <b class="trace-name">{{ it.name }}</b>
            <span class="im-scan-sum">v{{ it.version }} · 审核 扫描{{ it.audit?.scan_risk || '?' }}/评测{{ it.audit?.eval_verdict || '?' }}</span>
            <button class="install-btn" :disabled="pubBusy" @click="doInstallPublished(it.name)">一键安装</button>
            <button class="ua-btn" :disabled="pubBusy" @click="doUnpublish(it.name)">下架</button>
          </div>
        </div>
      </div>
    </template>

    <!-- Sub-agent Tab（T-142 / T17）：插件声明为子智能体，主 agent 委派并聚合结构化结果 -->
    <template v-else-if="tab === 'subagent'">
      <div class="scaffold card">
        <div class="sc-title"><UIcon name="box" :size="14" /> Sub-agent 编排</div>
        <p class="im-hint">
          装了带 <code>subagent.json</code> 的插件/技能即自动注册。委派时只给它<b>声明的工具白名单</b>，
          输入输出按 <b>schema</b> 硬校验；<code>tool</code> 模式走确定性入口工具（离线可跑），
          <code>llm</code> 模式需登录账号调用模型（未登录会如实报错，不编造结论）。
        </p>
        <p v-if="subLoading" class="im-hint">加载中…</p>
        <p v-else-if="!subAgents.length" class="im-hint">暂无已注册的子智能体。用「开发你的插件」生成带 subagent.json 的插件并安装。</p>
        <div v-else class="sc-out">
          <div v-for="sa in subAgents" :key="sa.name" class="trace-row">
            <b class="trace-name">{{ sa.display_name || sa.name }}</b>
            <span class="im-scan-sum">
              来自 {{ sa.owner }}（{{ sa.owner_kind }}）· 模式 {{ sa.modes.join('/') || '无' }} · 工具 {{ sa.tools.join('、') || '未声明' }}
            </span>
            <span v-if="sa.issues.length" class="trace-err">{{ sa.issues.join('；') }}</span>
          </div>
          <div class="sc-row" style="margin-top: 10px">
            <select v-model="subTarget" class="sc-input" style="min-width: 200px">
              <option value="">选择子智能体…</option>
              <option v-for="sa in subAgents" :key="sa.name" :value="sa.name">{{ sa.display_name || sa.name }}</option>
            </select>
            <input v-model="subInput" class="sc-input" placeholder="target（要处理的文件/目录）" />
          </div>
          <div class="sc-row">
            <input v-model="subTask" class="sc-input" placeholder="子任务描述，如：审查这个目录" />
            <button class="install-btn" :disabled="subBusy || !online || !subTarget" @click="doDelegate">
              {{ subBusy ? '委派中…' : '委派子任务' }}
            </button>
          </div>
          <p v-if="subMsg" class="im-ok"><UIcon name="check" :size="13" /> {{ subMsg }}</p>
          <p v-if="subErr" class="act-err"><UIcon name="info" :size="13" /> {{ subErr }}</p>
          <div v-if="subResult" class="sc-out">
            <p class="im-scan-sum">输出（已按 output_schema 校验）：</p>
            <p class="im-tool"><b>{{ JSON.stringify(subResult.output) }}</b></p>
            <p v-if="subResult.output_warnings.length" class="trace-err">校验告警：{{ subResult.output_warnings.join('；') }}</p>
          </div>
        </div>
      </div>
    </template>

    <!-- 能力推荐 Tab（T-142 / T16）：按任务描述推荐插件/技能，理由可追溯 -->
    <template v-else>
      <div class="rec-box">
        <p class="rec-tip">
          <UIcon name="sparkles" :size="13" />
          描述你要做的事，EVA 自动推荐最匹配的插件 / 技能 / 上下文提供者——无需手动翻找。
        </p>
        <div class="rec-input">
          <UIcon name="search" :size="14" style="color: var(--t3)" />
          <input
            v-model="recTask" class="rec-task"
            placeholder="例如：分析这个 repo 的安全漏洞，并生一张架构图"
            @keyup.enter="runRecommend"
          />
          <button class="btn btn-dark" :disabled="recLoading" @click="runRecommend">
            {{ recLoading ? '推荐中…' : '推荐' }}
          </button>
        </div>
        <p v-if="recErr" class="act-err"><UIcon name="info" :size="13" /> {{ recErr }}</p>

        <div v-if="recs.length" class="rec-list">
          <div v-for="r in recs" :key="r.kind + r.name" class="rec-item card">
            <div class="rec-head">
              <span class="plug-ic" :style="{ background: r.kind === 'skill' ? '#7c5cff' : '#2b6cff', color: '#fff' }">
                <UIcon :name="r.kind === 'skill' ? 'sparkle' : 'box'" :size="16" />
              </span>
              <b class="rec-name">{{ r.name }}</b>
              <span class="plug-badge" :class="r.kind">{{ r.kind === 'skill' ? '技能' : '插件' }}</span>
              <span v-if="r.installed" class="plug-badge on">已装</span>
            </div>
            <div class="rec-desc">{{ r.desc }}</div>
            <div class="rec-reasons">
              <span v-for="(reason, i) in r.reasons" :key="i" class="rec-reason">{{ reason }}</span>
            </div>
            <div class="rec-acts">
              <button
                v-if="r.kind === 'plugin' && !r.installed" class="install-btn" :disabled="!online"
                :title="online ? '安装' : '离线不可用'" @click="openInstallByName(r)"
              ><UIcon name="plus" :size="12" /> 安装</button>
              <button
                v-else-if="r.kind === 'skill' && !r.installed" class="install-btn"
                @click="tab = 'skill'"
              >前往技能页</button>
              <span v-else class="plug-badge on">已安装</span>
            </div>
          </div>
        </div>
        <p v-else-if="!recLoading && recSearched" class="rec-empty">没有匹配的能力，换个说法试试？</p>

        <div v-if="ctxProviders.length" class="ctx-box">
          <div class="ctx-title">
            <UIcon name="box" :size="13" /> 可注入的上下文（Context Provider）
            <span class="ctx-sub">装上对应能力后，agent 规划时可自动取这些上下文</span>
          </div>
          <div class="ctx-list">
            <div v-for="p in ctxProviders" :key="p.kind + p.name" class="ctx-item">
              <div class="ctx-head">
                <b>{{ p.name }}</b>
                <span class="plug-badge" :class="p.kind">{{ p.kind === 'skill' ? '技能' : '插件' }}</span>
                <span v-if="p.installed" class="plug-badge on">已装</span>
              </div>
              <div class="ctx-labels">
                <span v-for="l in p.context_labels" :key="l" class="ctx-label">{{ l }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 安装弹层（T-030）：填来源 + 确认高危动作 -->
    <div v-if="installTarget" class="modal-mask" @click.self="closeInstall">
      <div class="modal card">
        <button class="modal-x icon-btn" @click="closeInstall"><UIcon name="x" :size="15" /></button>
        <div class="im-head">
          <div class="im-title">安装「{{ installTarget.name }}」</div>
          <p class="im-desc">{{ installTarget.desc }}</p>
        </div>
        <div class="im-body">
          <div class="fld">
            <span class="fld-t">安装来源</span>
            <!-- T-142 / T13：本地/包 或 远程托管 MCP -->
            <select v-model="installKind" class="sort-sel" style="height: 26px">
              <option value="local">本地 / npm 包</option>
              <option value="remote">远程托管 MCP（HTTP / SSE）</option>
            </select>
          </div>
          <div v-if="installKind === 'remote'" class="im-src">
            <span class="fld-t">远程地址</span>
            <input
              v-model="remoteUrl" class="input im-input" spellcheck="false"
              placeholder="https://mcp.example.com/mcp（Streamable HTTP）或 .../sse"
            />
            <select v-model="remoteTransport" class="sort-sel" style="height: 26px">
              <option value="">自动判断</option>
              <option value="http">Streamable HTTP</option>
              <option value="sse">HTTP+SSE</option>
            </select>
          </div>
          <div v-else class="im-src">
            <span class="fld-t">包名 / 命令</span>
            <input
              v-model="spec" class="input im-input" spellcheck="false"
              :placeholder="installTarget.spec ? '已自动填入目录声明的安装来源' : 'npm 包名（如 @scope/pkg）或本地命令（如 node ./server.mjs）'"
            />
          </div>
          <label v-if="installKind !== 'remote' && !installTarget.spec" class="im-chk">
            <input v-model="customInstall" type="checkbox" />
            <span>该来源不在市场目录中，我自行核实来源并承担风险</span>
          </label>
          <label v-if="installKind !== 'remote'" class="im-chk">
            <input v-model="trustSource" type="checkbox" />
            <span>信任该来源（放宽完整性限制以便运行；特权仍禁用、资源仍限额）</span>
          </label>
          <p v-if="installKind === 'remote'" class="im-hint warn">
            <UIcon name="info" :size="12" />
            远程 MCP 的工具调用会把内容发往该地址（数据出境）。请确认地址可信；接入属高危操作，握手失败不会留下幽灵服务。
          </p>
          <p v-else class="im-hint">
            安装会真实写入本地并注册为 MCP 服务，成功后其工具会出现在工具注册表里。<br />
            无外网时 npm 安装会失败并把 npm 的原文错误显示出来；想离线验证请用本地命令形态。
          </p>
          <div class="im-src">
            <span class="fld-t">发布者</span>
            <span class="im-src-name">{{ installTarget.publisher || '（未知来源）' }}</span>
            <span class="plug-badge trust" :class="trustCls(installTarget)">{{ trustLbl(installTarget) }}</span>
          </div>
          <div v-if="installTarget.egress_policy && installTarget.egress_policy.length" class="im-src">
            <span class="fld-t">网络许可</span>
            <span class="im-src-name">{{ installTarget.egress_policy.join('、') }}</span>
          </div>
          <!-- T-142：需要参数/令牌的包（如 Sentry）：不填就会启动即退，如实说明 -->
          <template v-if="installKind !== 'remote' && (installTarget.needs_args || installTarget.needs_env?.length)">
            <div class="im-src">
              <span class="fld-t">启动参数</span>
              <input
                v-model="extraArgs" class="input im-input" spellcheck="false"
                placeholder="如 --access-token=xxx --agent-provider=anthropic"
              />
            </div>
            <div v-if="installTarget.needs_env?.length" class="im-src">
              <span class="fld-t">环境变量</span>
              <input
                v-model="extraEnv" class="input im-input" spellcheck="false"
                :placeholder="installTarget.needs_env.map((k) => k + '=…').join('  ')"
              />
            </div>
            <p class="im-hint warn">
              <UIcon name="info" :size="12" />
              这个服务<strong>必须带参数才能启动</strong>，否则会打印用法后立即退出。
              {{ installTarget.setup_hint || '' }}参数与令牌<strong>只用于本次安装</strong>，不会写入市场目录。
            </p>
          </template>
          <p v-if="trustLevel(installTarget) === 'community'" class="im-hint warn">
            <UIcon name="info" :size="12" /> 社区插件未经官方审核，请自行评估风险；建议保持沙箱开启并留意其声明的能力。
          </p>
          <!-- T-142 / T21：多模态能力就绪度（缺通道如实告知，不假装能用） -->
          <div v-if="installTarget.multimodal && installTarget.multimodal.abilities.length" class="im-caps">
            <div class="im-caps-t">多模态能力</div>
            <div v-for="d in installTarget.multimodal.details" :key="d.ability" class="im-cap" :class="{ warn: !d.usable }">
              <UIcon name="sparkle" :size="12" /> {{ d.label }}
              <span v-if="d.usable">· 可用</span>
              <span v-else>· 不可用（{{ d.reason }}）</span>
            </div>
          </div>
          <div class="im-caps">
            <div class="im-caps-t">能力声明</div>
            <template v-if="installTarget.capabilities && installTarget.capabilities.length">
              <div v-for="c in installTarget.capabilities" :key="c" class="im-cap">
                <UIcon name="shield" :size="12" /> {{ capLabel(c) }}
              </div>
            </template>
            <div v-else class="im-cap warn">
              <UIcon name="info" :size="12" /> 未声明能力（默认按可访问网络处理）
            </div>
            <div v-if="isLocalSpec" class="im-cap warn">
              <UIcon name="info" :size="12" /> 本地命令将以你的完整用户权限运行（不受以上声明限制）
            </div>
          </div>
          <div v-if="installScan" class="im-scan" :class="installScan.risk">
            <div class="im-caps-t">安全扫描</div>
            <div class="im-scan-risk">风险等级：<b>{{ scanRiskLbl(installScan) }}</b></div>
            <div v-if="installScan.note" class="im-hint">{{ installScan.note }}</div>
            <div v-if="installScan.summary" class="im-scan-sum">{{ scanSummary(installScan) }}</div>
          </div>
          <label class="im-chk">
            <input v-model="confirmed" type="checkbox" />
            <span>我确认安装（高危动作：会下载/执行外部代码）</span>
          </label>

          <button class="apply-btn" :disabled="!canInstall || installing || installDone" @click="doInstall">
            {{ installing ? i18n.t('common.installing') : (installDone ? '已安装' : i18n.t('common.install')) }}
          </button>

          <p v-if="installErr" class="im-err"><UIcon name="info" :size="13" /> {{ installErr }}</p>
          <!-- 安装结果：摘要优先，工具明细默认折叠（30 个工具铺满屏对用户没意义） -->
          <div v-if="installTools.length" class="im-ok">
            <UIcon name="check" :size="13" />
            <b>安装成功</b>，已注册 {{ installTools.length }} 个工具到工具注册表，可在对话中直接调用。
            <p class="im-hint">来源：{{ installTarget?.spec || spec }}；完整性：{{ installIntegrity }}<template v-if="installScan?.risk && installScan.risk !== 'safe'">；扫描：{{ scanRiskLbl(installScan) }}</template></p>
            <button class="ua-btn" @click="toolsExpanded = !toolsExpanded">
              {{ toolsExpanded ? '收起工具清单' : `查看工具清单（${installTools.length}）` }}
            </button>
            <div v-if="toolsExpanded" class="tool-list">
              <div v-for="t in installTools" :key="t.name" class="im-tool">
                <b>{{ t.name }}</b>
                <span class="im-scan-sum">{{ t.description || '（该工具未提供说明）' }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 管理面板（T7）：已装插件管理 -->
    <div v-if="manageOpen" class="modal-mask" @click.self="manageOpen = false">
      <div class="modal card manage">
        <button class="modal-x icon-btn" @click="manageOpen = false"><UIcon name="x" :size="15" /></button>
        <div class="im-head">
          <div class="im-title">已安装插件</div>
          <p class="im-desc">管理插件的启用、权限与工具。</p>
        </div>
        <div class="im-body">
          <div v-if="manageBusy" class="im-hint">加载中…</div>
          <div v-else-if="manageErr" class="im-err"><UIcon name="info" :size="13" /> {{ manageErr }}</div>
          <div v-else-if="!installedList.length" class="im-hint">尚未安装任何插件。</div>
          <div v-else>
            <div v-for="p in installedList" :key="p.name" class="mg-item">
              <div class="mg-top">
                <b class="mg-name">{{ p.name }}</b>
                <span class="plug-badge" :class="{ on: p.enabled }">{{ p.enabled ? '已启用' : '已停用' }}</span>
                <!-- T-142 / T23：兼容状态（可更新/待灰度/需升级 agent） -->
                <span v-if="compatLbl(p)" class="plug-badge" :class="p.compat?.status === 'needs_agent' ? 'scan danger' : 'upd'">{{ compatLbl(p) }}</span>
              </div>
              <!-- T-142 / T23：版本兼容矩阵 + 灰度分组（本机分桶 bucket） -->
              <div v-if="p.compat" class="mg-src">
                <span class="fld-t">版本</span>
                <span class="mg-src-name">{{ p.compat.installed_version }}<template v-if="p.compat.latest_version && p.compat.latest_version !== p.compat.installed_version"> → {{ p.compat.latest_version }}</template></span>
                <span v-if="p.compat.detail" class="im-scan-sum">{{ p.compat.detail }}</span>
              </div>
              <div v-if="p.compat" class="mg-src">
                <span class="fld-t">灰度</span>
                <select class="sort-sel" :value="p.compat.rollout_pct" @change="doSetRollout(p.name, Number(($event.target as HTMLSelectElement).value))">
                  <option :value="0">0%（全停）</option>
                  <option :value="25">25%</option>
                  <option :value="50">50%</option>
                  <option :value="100">100%（全量）</option>
                </select>
                <span class="im-scan-sum">本机分桶 {{ p.compat.bucket }}<template v-if="p.compat.in_cohort">（命中）</template><template v-else>（未命中）</template></span>
              </div>
              <div class="mg-src">
                <span class="fld-t">发布者</span>
                <span class="mg-src-name">{{ p.publisher || '（未知）' }}</span>
                <span v-if="p.scan && (p.scan.risk === 'danger' || p.scan.risk === 'warn')" class="plug-badge scan" :class="p.scan.risk">{{ p.scan.risk === 'danger' ? '高危扫描' : '告警扫描' }}</span>
              </div>
              <div v-if="p.capability_ticket && (p.capability_ticket.egress || []).length" class="mg-src">
                <span class="fld-t">网络许可</span>
                <span class="mg-src-name">{{ (p.capability_ticket.egress || []).join('、') }}</span>
              </div>
              <div class="mg-caps">
                <span v-for="c in (p.capabilities || [])" :key="c" class="mg-cap">
                  <UIcon name="shield" :size="11" /> {{ capLabel(c) }}
                </span>
                <span v-if="!(p.capabilities || []).length" class="mg-cap warn">未声明能力</span>
              </div>
              <div class="mg-acts">
                <button class="ua-btn" @click="manageToggle(p.name, !p.enabled)">{{ p.enabled ? '停用' : '启用' }}</button>
                <button class="ua-btn" @click="toggleTools(p.name)">{{ toolsOpen === p.name ? '收起工具' : '工具' }}</button>
                <button class="ua-btn" @click="toggleEval(p.name)">{{ evalOpen === p.name ? '收起评测' : '行为评测' }}</button>
                <button v-if="p.can_rollback" class="ua-btn" :disabled="busyName === p.name" @click="manageRollback(p.name)">回滚上一版</button>
                <button class="ua-btn danger" @click="doManageUninstall(p.name)">卸载</button>
              </div>
              <div v-if="toolsOpen === p.name" class="mg-tools">
                <div v-if="toolsBusy" class="im-hint">加载工具…</div>
                <div v-else-if="toolsErr" class="im-err">{{ toolsErr }}</div>
                <div v-else-if="(toolsMap[p.name] || []).length" v-for="t in toolsMap[p.name]" :key="t.name" class="im-tool">
                  <b>{{ t.name }}</b> — {{ t.description }}
                </div>
                <div v-else class="im-hint">该插件未暴露工具。</div>
              </div>
              <div v-if="evalOpen === p.name" class="mg-tools">
                <div v-if="evalBusy" class="im-hint">评测中…</div>
                <div v-else-if="evalErr" class="im-err">{{ evalErr }}</div>
                <div v-else-if="evalMap[p.name]" class="eval-r">
                  <div class="eval-verdict" :class="(evalMap[p.name].verdict as string)">
                    行为评测结论：{{ { passed: '通过', warn: '需留意', rejected: '拒上架' }[evalMap[p.name].verdict as string] || evalMap[p.name].verdict }}
                  </div>
                  <div class="im-scan-sum">
                    静态风险：{{ evalMap[p.name].static_risk || 'safe' }}；
                    出口策略：{{ (evalMap[p.name].egress as any)?.enforced ? '已强制拦截（行为验证）' : (evalMap[p.name].egress as any)?.note || '无' }}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <!-- T-142 / T14：安全边界评测流水线（回归） -->
          <div class="mg-telemetry">
            <div class="mg-top">
              <b>安全评测（T-14 回归集）</b>
              <button class="ua-btn" :disabled="evalRunBusy" @click="doRunEvals">
                {{ evalRunBusy ? '评测中…' : '重跑评测' }}
              </button>
            </div>
            <p class="im-hint">12 条边界用例（静态扫描 / 越权 / 出口拦截 / 协议兼容 / 上架审核）+ 目录声明合规审计，确定性、离线可跑。</p>
            <p v-if="evalRunMsg" class="im-scan-sum">{{ evalRunMsg }}</p>
            <template v-if="evalReport">
              <div v-for="c in evalReport.cases" :key="c.name" class="trace-row">
                <span :class="c.ok ? 'ev-ok' : 'ev-fail'">{{ c.ok ? '✓' : '✗' }}</span>
                <span class="trace-name">{{ c.name }}</span>
                <span class="im-scan-sum">{{ c.detail }}</span>
              </div>
              <p v-if="evalReport.catalog_audit" class="im-scan-sum">
                目录声明合规：{{ evalReport.catalog_audit.compliant }}/{{ evalReport.catalog_audit.total }}（缺失 {{ evalReport.catalog_audit.non_compliant }} 项，如实标红不假装）
              </p>
            </template>
          </div>
          <!-- T-142 / T22：端到端 Tracing（按插件聚合） -->
          <div v-if="traceRows.length" class="mg-telemetry">
            <div class="mg-top">
              <b>调用追踪</b>
              <button class="ua-btn" :disabled="traceBusy" @click="doClearTracing">清空</button>
            </div>
            <div v-for="r in traceRows" :key="r.plugin" class="trace-row">
              <b class="trace-name">{{ r.plugin }}</b>
              <span class="im-scan-sum">
                {{ r.calls }} 次 · 成功率 {{ (r.success_rate * 100).toFixed(0) }}% · 平均 {{ r.avg_ms }}ms<template v-if="r.fail"> · 失败 {{ r.fail }}</template>
              </span>
              <span v-if="r.last_error" class="trace-err">{{ r.last_error }}</span>
            </div>
          </div>
          <!-- T-142 / T10：遥测最小集（默认关；仅本机聚合，无内容/凭据） -->
          <div v-if="telemetry" class="mg-telemetry">
            <div class="mg-top">
              <b>匿名遥测</b>
              <span class="plug-badge" :class="telemetry.enabled ? 'on' : ''">{{ telemetry.enabled ? '已开启' : '已关闭' }}</span>
            </div>
            <p class="im-hint">
              仅在本机记录安装/卸载/启停/崩溃次数（匿名 id {{ telemetry.anon_id }}），不含对话内容、文件路径或凭据；不上传任何服务器。默认关闭。
            </p>
            <div class="mg-acts">
              <button class="ua-btn" :disabled="telemetryBusy" @click="toggleTelemetry">
                {{ telemetry.enabled ? '关闭遥测' : '开启遥测' }}
              </button>
              <span v-if="telemetry.total" class="im-scan-sum">本机已记录 {{ telemetry.total }} 条</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tab-row { display: flex; align-items: center; gap: 10px; margin-top: 20px; }
.spacer { flex: 1; }
.feature-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 22px; }
.feature-card { display: flex; justify-content: space-between; padding: 18px; overflow: hidden; }
.feature-t { font-size: 15px; font-weight: 700; }
.feature-info ul { list-style: none; margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.feature-info li { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.li-dot { width: 16px; height: 16px; border-radius: 5px; background: var(--line-2); flex: none; }
.feature-art {
  width: 108px; height: 96px; border-radius: 10px; flex: none;
  display: flex; align-items: center; justify-content: center;
}
.chips-row { display: flex; gap: 8px; margin-top: 22px; flex-wrap: wrap; }
.plug-grid { margin-top: 18px; }
/* 评分区：左边的「社区评分」是只读的，右边的「你的评分」可点——
   此前两边都是一排星星，用户分不清哪个能点。 */
.rate-do-lbl {
  font-size: 10.5px; color: var(--tx-3); margin-right: 3px;
}
.rate-do-lbl::before { content: "·"; margin-right: 4px; }
/* 分类标题：50+ 个技能平铺没法用，按类分组。视觉上比筛选器更直观——一眼看全。 */
.skill-cat {
  display: flex; align-items: center; gap: 6px;
  margin: 20px 0 4px; font-size: 12.5px; font-weight: 600; color: var(--tx-2);
}
.skill-cat::before { content: ""; width: 3px; height: 12px; border-radius: 2px; background: var(--violet); }
.skill-cat-n {
  font-size: 11px; font-weight: 400; color: var(--tx-3);
  background: var(--line-2); border-radius: 5px; padding: 0 5px;
}

.plug-card { display: flex; gap: 12px; padding: 16px; align-items: flex-start; }
.plug-ic {
  width: 38px; height: 38px; border-radius: 10px; flex: none;
  display: inline-flex; align-items: center; justify-content: center; color: var(--t1);
}
.plug-info { flex: 1; min-width: 0; }
.plug-name { font-size: 13.5px; font-weight: 600; }
.plug-desc {
  font-size: 12px; color: var(--t2); margin-top: 4px; line-height: 1.55;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.install-btn {
  display: inline-flex; align-items: center; gap: 4px; flex: none;
  height: 28px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line);
  font-size: 12px; background: var(--panel);
}
.install-btn:hover:not(:disabled) { background: var(--line-2); }
.install-btn:disabled { opacity: 0.5; cursor: default; }

/* T-030：安装态 */
.plug-acts { flex: none; display: flex; align-items: center; gap: 6px; }

/* 技能卡（TS-061 UI）：操作按钮最多 4 个，横排会把信息区挤成竖线、标题被挤换行。
   所以技能卡改成纵向分层：信息在上、操作在下（右侧对齐、可换行）。
   插件卡不动——它只有一两个按钮，横排本来就对。 */
.plug-card-stack { flex-direction: column; align-items: stretch; gap: 10px; }
.plug-card-stack .plug-top { display: flex; gap: 12px; align-items: flex-start; }
.plug-card-stack .plug-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.plug-card-stack .plug-desc { -webkit-line-clamp: 3; margin-top: 6px; }
.plug-card-stack .plug-acts {
  margin-top: 2px; padding-top: 10px; border-top: 1px solid var(--line);
  flex-wrap: wrap; justify-content: flex-end;
}
.plug-tag.local { background: var(--line-2); color: var(--t3); }
.plug-badge {
  flex: none; height: 22px; padding: 0 8px; border-radius: 6px; font-size: 11px;
  display: inline-flex; align-items: center; background: var(--line-2); color: var(--t3);
}
/* T-076：本地已加载标记 */
.plug-tag {
  margin-left: 6px; padding: 1px 6px; border-radius: 4px; font-size: 10px;
  background: var(--violet-bg); color: var(--violet);
}
.plug-badge.on { background: var(--ok-bg); color: #0cb277; }
.plug-badge.upd { background: var(--warn-bg, #fff4e0); color: var(--warn, #b7791f); }
.plug-badge.trust.official { background: #e8f0ff; color: #2b6cff; }
.plug-badge.trust.verified { background: var(--ok-bg); color: #0cb277; }
.plug-badge.trust.community { background: #f1f1f3; color: #8a8f99; }
.plug-badge.plugin { background: #e8f0ff; color: #2b6cff; }
.plug-badge.skill { background: #efe9ff; color: #7c5cff; }
.sort-sel { height: 28px; border-radius: 7px; border: 1px solid var(--line); background: var(--panel); color: var(--t1); font-size: 12px; padding: 0 6px; }
.scaffold { margin-top: 20px; padding: 16px; }
/* 安装结果里的工具清单：可滚动限高，避免几十条工具把弹层撑爆 */
.tool-list { max-height: 220px; overflow-y: auto; margin-top: 8px; padding-right: 4px; }
.tool-list .im-tool { display: flex; gap: 8px; align-items: baseline; }
.tool-list .im-tool b { flex: 0 0 auto; }
.tool-list .im-tool .im-scan-sum { flex: 1; line-height: 1.45; }
.sc-title { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.sc-row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.sc-input { flex: 1; min-width: 160px; height: 30px; border-radius: 7px; border: 1px solid var(--line); background: var(--panel); color: var(--t1); font-size: 12.5px; padding: 0 10px; }
.sc-out { margin-top: 10px; }
.sc-out code { font-size: 12px; }
.plug-rate { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 11.5px; color: var(--t3); }
.rate-stars { color: #e0a800; letter-spacing: 1px; }
.rate-num { color: var(--t2); }
.rate-dl { color: var(--t3); }
.rate-do { display: inline-flex; gap: 1px; }
.rate-star { background: none; border: none; cursor: pointer; font-size: 12px; color: #d5d8de; padding: 0 1px; line-height: 1; }
.rate-star.on { color: #e0a800; }
.rate-star:hover { color: #e0a800; }
.plug-badge.scan.danger { background: #ffe9e9; color: #d23f3f; }
.plug-badge.scan.warn { background: var(--warn-bg, #fff4e0); color: var(--warn, #b7791f); }
.im-src { display: flex; align-items: center; gap: 8px; margin: 10px 0 2px; }
.im-src .fld-t { color: var(--t3); font-size: 12px; }
.im-src-name { font-weight: 600; font-size: 13px; }
.im-hint.warn { color: #b7791f; }
.im-scan { margin: 10px 0 2px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--line-2); }
.im-scan.danger { border-color: #f0b4b4; background: #fff5f5; }
.im-scan.warn { border-color: #ecd9a8; background: #fffaf0; }
.im-scan-risk { font-size: 12.5px; color: var(--t1); }
.im-scan-risk b { color: inherit; }
.im-scan.danger .im-scan-risk b { color: #d23f3f; }
.im-scan.warn .im-scan-risk b { color: #b7791f; }
.im-scan-sum { font-size: 12px; color: var(--t3); margin-top: 4px; }
.rec-box { margin-top: 22px; }
.rec-tip { font-size: 12.5px; color: var(--t2); display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.rec-input { display: flex; align-items: center; gap: 8px; background: var(--line-2); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; }
.rec-task { flex: 1; border: none; outline: none; background: none; font-size: 13px; color: var(--t1); }
.rec-list { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin-top: 16px; }
.rec-item { padding: 16px; }
.rec-head { display: flex; align-items: center; gap: 8px; }
.rec-name { font-size: 14px; }
.rec-desc { font-size: 12.5px; color: var(--t2); margin: 8px 0; line-height: 1.5; }
.rec-reasons { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.rec-reason { font-size: 11px; background: var(--ok-bg); color: #0cb277; padding: 2px 8px; border-radius: 999px; }
.rec-acts { display: flex; justify-content: flex-end; }
.rec-empty { font-size: 13px; color: var(--t3); margin-top: 16px; }
.ctx-box { margin-top: 22px; border-top: 1px solid var(--line-2); padding-top: 16px; }
.ctx-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ctx-sub { font-size: 11.5px; font-weight: 400; color: var(--t3); }
.ctx-list { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 12px; }
.ctx-item { background: var(--line-2); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.ctx-head { display: flex; align-items: center; gap: 8px; }
.ctx-labels { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.ctx-label { font-size: 11px; background: #e9f3ff; color: #2b6cff; padding: 2px 8px; border-radius: 999px; }
.mg-src { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.mg-src .fld-t { color: var(--t3); font-size: 12px; }
.mg-src-name { font-weight: 600; font-size: 13px; }
.act-err {
  display: flex; align-items: center; gap: 8px; margin: 12px 0 0;
  padding: 10px 12px; border-radius: 8px; background: var(--err-bg); color: var(--err); font-size: 12.5px;
}
.act-err span { flex: 1; }
.act-err .ua-btn { height: 24px; padding: 0 10px; border-radius: 6px; border: 1px solid currentColor; color: inherit; background: transparent; font-size: 12px; }

/* 安装弹层 */
.im-caps { margin: 14px 0 2px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--line-2); }
.im-caps-t { font-size: 12px; color: var(--t3); margin-bottom: 8px; font-weight: 600; }
.im-cap { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--t1); padding: 3px 0; }
.im-cap.warn { color: var(--warn, #b7791f); }
/* 管理面板（T7） */
.mg-item { padding: 14px 0; border-bottom: 1px solid var(--line); }
.mg-item:last-child { border-bottom: none; }
.mg-top { display: flex; align-items: center; gap: 10px; }
.mg-name { font-size: 13.5px; font-weight: 600; }
.mg-caps { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
.mg-cap { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--t2); background: var(--line-2); border-radius: 6px; padding: 3px 8px; }
.mg-cap.warn { color: var(--warn, #b7791f); }
.mg-acts { display: flex; gap: 8px; margin-top: 4px; }
.ua-btn { height: 28px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--line); background: var(--panel); font-size: 12px; color: var(--t1); }
.ua-btn:hover { background: var(--line-2); }
.ua-btn.danger { color: var(--err); border-color: var(--err-bg); }
.mg-tools { margin-top: 10px; padding: 10px 12px; border-radius: 8px; background: var(--line-2); }
.mg-telemetry { margin-top: 14px; padding: 12px; border-radius: 8px; background: var(--line-2); }
.mg-telemetry .mg-top { display: flex; align-items: center; gap: 8px; }
.trace-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; font-size: 12px; }
.trace-name { min-width: 90px; }
.trace-err { color: var(--err); font-size: 11px; }
.ev-ok { color: #0cb277; font-weight: 700; }
.ev-fail { color: var(--err); font-weight: 700; }
.eval-r { font-size: 12.5px; }
.eval-verdict { font-weight: 600; margin-bottom: 4px; }
.eval-verdict.passed { color: #0cb277; }
.eval-verdict.warn { color: #b7791f; }
.eval-verdict.rejected { color: #d23f3f; }
.modal-mask {
  position: fixed; inset: 0; background: rgba(15, 17, 21, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 50; padding: 24px;
}
.modal { width: 520px; max-width: 100%; max-height: 86vh; overflow: auto; position: relative; padding: 0; }
.modal-x { position: absolute; top: 12px; right: 12px; z-index: 2; }
.im-head { padding: 22px 22px 14px; background: var(--line-2); border-bottom: 1px solid var(--line); }
.im-title { font-size: 16px; font-weight: 700; }
.im-desc { margin: 8px 0 0; font-size: 12.5px; color: var(--t2); line-height: 1.6; }
.im-body { padding: 16px 22px 22px; }
.fld { display: flex; flex-direction: column; gap: 6px; }
.fld-t { font-size: 11.5px; color: var(--t3); }
.im-input { height: 34px; border: 1px solid var(--line); border-radius: 8px; padding: 0 10px; font-size: 12.5px; background: var(--panel); color: var(--t1); }
.im-hint { margin: 10px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--t3); }
.im-chk { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 12.5px; }
.apply-btn {
  margin-top: 16px; width: 100%; height: 38px; border-radius: 9px;
  background: var(--violet); color: #fff; font-size: 13.5px; font-weight: 600;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.apply-btn:disabled { background: var(--violet-soft); cursor: default; }
.im-err {
  display: flex; align-items: center; gap: 6px; margin-top: 12px; padding: 10px 12px;
  border-radius: 8px; background: var(--err-bg); color: var(--err); font-size: 12.5px;
  white-space: pre-wrap; word-break: break-word; line-height: 1.6;
}
.im-ok { margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: var(--ok-bg); color: var(--ok); font-size: 12.5px; }
.im-tool { margin-top: 4px; font-size: 12px; opacity: 0.9; }
</style>
