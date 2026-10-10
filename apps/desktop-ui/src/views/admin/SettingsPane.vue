<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import UIcon from '@/components/UIcon.vue';
import UToggle from '@/components/UToggle.vue';
import { bridgeAvailable, checkUpdates, fetchAppVersion, setKeepAwake, setVoiceHot, type UpdateCheck } from '@/api/backend';
import { fetchModels, type ModelItem } from '@/api/catalog';
import { fetchSettings, putSettings } from '@/api/settings';
import { fetchFileRoots, setWorkspaceRoot } from '@/api/files';
import { clearMemory, fetchMemory, saveMemory, type MemoryState } from '@/api/memory';
import { openTraceDir, tsAgentRestart } from '@/api/tsAgent';
import { useThemeStore, type ThemeMode } from '@/stores/theme';
import { useI18nStore } from '@/stores/i18n';
import { playChime, requestNotifyPermission, type ChimeKind } from '@/composables/useNotify';
import { createWorktree, deleteWorktree, fetchWorktrees, pruneWorktrees, type WorktreeItem, type WorktreeState } from '@/api/worktree';
import { browserShotURL, clearBrowserData, fetchBrowser, openInBrowser, type BrowserState } from '@/api/browser';
import { addProvider, deleteProvider, fetchProviders, testProvider, testProviderDraft, updateProvider, type ProviderDraft, type ProviderItem } from '@/api/providers';
import { tsAgentAvailable, tsAgentStatus } from '@/api/tsAgent';

/* T-128：设置与管理控制台合并为一个界面（同一个深色壳、同一条侧栏）。
   这一页只承载"本机偏好"——改这台电脑 / EVA 怎么干活，落 /api/settings 的 kv；
   账号、用量、MCP、规则条目等"服务资产"是同壳里的另一组页面，那里才接真后端。 */
const route = useRoute();
/* 节名取自路径最后一段，而不是 route.params：父级路由没有 :page 形参（见 router.ts 注释）。
   取不到就落 about —— 兜底节必须是"关于"这种无害页，不能是空的。 */
const page = computed(() => route.path.replace(/^\/admin\/?/, '').split('/')[0] || 'about');

/* T-119：关于页的「检查更新」以前是个空按钮——没有 @click，点下去毫无反应。
   菜单栏收起后它是唯一的更新入口，所以必须真的说话：检查中 / 已是最新 / 有新版本 /
   当前环境不支持，都得写出来。 */
const updateState = ref<{ busy: boolean; text: string; tone: 'ok' | 'warn' }>({
  busy: false, text: '', tone: 'ok',
});

async function onCheckUpdates() {
  if (updateState.value.busy) return;
  updateState.value = { busy: true, text: i18nStore.t('正在检查…'), tone: 'ok' };
  const r = await checkUpdates();
  const text: Record<UpdateCheck['status'], string> = {
    latest: i18nStore.t('已是最新版本'),
    // 没给版本号也要成句，不能落下"发现新版本 ，请在…"这种空格豁口
    available: r.version ? `${i18nStore.t('发现新版本 ')}v${r.version}${i18nStore.t('，请在安装包页面下载')}` : i18nStore.t('发现新版本，请在安装包页面下载'),
    unsupported: r.message || i18nStore.t('当前环境不支持自动更新'),
    error: `${i18nStore.t('检查失败：')}${r.message || i18nStore.t('未知错误')}`,
  };
  updateState.value = { busy: false, text: text[r.status], tone: r.status === 'error' ? 'warn' : 'ok' };
}

// 各节内的本地开关（部分仍是 mock 外观，但整体走 T-015 落盘）
const t = ref({
  privacy: false, voiceHot: true, aiWatermark: false,
  mobileControl: true, keepAwake: false,
  notify: true, sound: true, followUp: true,
  innerBrowser: true, outerBrowser: false, autoScreenshot: true,
  computerControl: true, worktreeClean: false, agentsMd: true, claudeMd: false, memory: true,
  trace: false, // 调试模式（请求留痕）：勾上给 agent 注入 EVA_TS_TRACE
});
const volume = ref(50);
const worktreeGb = ref('5');

/* 智能体只剩 TS 一套内核（Python 后端已废弃），这里只**展示状态**，没有可切换项。
   状态仍要问主进程：子进程可能没起来（没登录 / 启动失败），
   显示"运行中"却其实发不出任务，比不显示更糟。 */
const agentRunning = ref(false);
const agentMsg = ref('');
const agentBridge = tsAgentAvailable();

onMounted(() => {
  void (async () => {
    // 桥在但状态可能是旧的（比如刚启动还没拉起）：再问一次真实状态，别显示"运行中"骗人
    if (!agentBridge) return;
    const s = await tsAgentStatus().catch(() => null);
    if (s) {
      agentRunning.value = Boolean(s.running && s.ready);
      agentMsg.value = agentRunning.value ? '' : i18nStore.t('TS 智能体未运行：需要登录 EVA 账号后才能调用模型。');
    }
  })();
});
/** S-23：AI 任务默认浏览器（内置浏览器 / 系统默认浏览器）——真决定 `open_url` 走哪条路 */
const browserDefault = ref('系统默认浏览器');

/* S-09：主题与语言本来就有真实现（stores/theme、stores/i18n，改了立刻换令牌并记在
   localStorage）。缺的只是"设置页这两个下拉是死的"——这里把它们接到同一批 store 上，
   改完刷新保持（持久化在 store 侧，不重复落 KV，免得两处各存一份互相打架）。 */
const themeStore = useThemeStore();
const i18nStore = useI18nStore();
const themeOptions = computed(() => [
  { v: 'light' as ThemeMode, label: i18nStore.t('亮色') },
  { v: 'dark' as ThemeMode, label: i18nStore.t('暗色') },
  { v: 'system' as ThemeMode, label: i18nStore.t('跟随系统') },
]);
const localeOptions = computed(() => [
  { v: 'zh' as const, label: i18nStore.t('简体中文') },
  { v: 'en' as const, label: i18nStore.t('English') },
]);

/* 这两个下拉必须经 store 的 set() 动作，不能直接 v-model 到 store.mode/locale：
   只有 set() 内部才调 apply()——主题的 apply() 写 `<html data-theme>`、语言的写 `<html lang>`
   并落 localStorage。直接绑 state 等于绕开 apply()，主题选了完全没反应（这就是"设置里改主题无效"，
   而用户菜单里走 chooseTheme→theme.set() 所以是好的）。 */
const themeModel = computed({
  get: () => themeStore.mode,
  set: (v: ThemeMode) => themeStore.set(v),
});
const localeModel = computed({
  get: () => i18nStore.locale,
  set: (v: 'zh' | 'en') => i18nStore.set(v),
});

/* S-10：产物/工作区存储路径——走主进程目录选择框 + `PUT /api/workspace`，
   显示的是后端**当前真正在用的**工作区根，不再是写死的模板路径。 */
const wsRoot = ref('');
const wsMsg = ref('');
const wsBusy = ref(false);

async function loadWorkspaceRoot() {
  try {
    const r = await fetchFileRoots();
    wsRoot.value = r.workspace || '';
  } catch {
    wsRoot.value = '';
  }
}

async function changeWorkspaceRoot() {
  if (wsBusy.value) return;
  const g = window as unknown as { evawork?: { pickFolder?: () => Promise<string> } };
  if (!g.evawork?.pickFolder) {
    wsMsg.value = i18nStore.t('当前环境无法打开目录选择框（仅桌面安装版支持）');
    return;
  }
  wsBusy.value = true;
  wsMsg.value = '';
  try {
    const picked = await g.evawork.pickFolder();
    if (!picked) return; // 用户取消：不报错，也不改
    const r = await setWorkspaceRoot(picked);
    wsMsg.value = r.ok ? `${i18nStore.t('已切换到 ')}${r.root}` : r.note || i18nStore.t('切换失败');
    await loadWorkspaceRoot();
  } catch (e) {
    wsMsg.value = (e as Error).message;
  } finally {
    wsBusy.value = false;
  }
}

/* S-11：网络代理。三档：跟随系统 / 关闭（直连） / 自定义（填地址）。
   后端每次出网前读这两个键写进 HTTP(S)_PROXY（见 evawork/settings.py）。 */
const proxyMode = ref<'system' | 'off' | 'custom'>('system');
const proxyUrl = ref('');

/* S-12：提示音/通知。播放按钮真的响（Web Audio，音量取上面的滑条），
   上传自定义音效没有实现 → 那个按钮标 data-coming，不做假入口。 */
const audioMsg = ref('');
const CHIME_OF: Record<string, ChimeKind> = { 任务完成: 'done', 等待操作: 'waiting', 异常打断: 'error' };

function previewChime(kind: string) {
  audioMsg.value = '';
  playChime(CHIME_OF[kind] ?? 'done', volume.value / 100);
  audioMsg.value = `${i18nStore.t('已试听「')}${i18nStore.t(kind)}${i18nStore.t('」')}`;
}

async function onNotifyToggle(on: boolean) {
  if (!on) return;
  const p = await requestNotifyPermission();
  if (p === 'denied') audioMsg.value = i18nStore.t('系统通知已被浏览器/系统拒绝，请在系统设置里允许后重试');
  else if (p === 'unsupported') audioMsg.value = i18nStore.t('当前环境不支持系统通知（仅桌面安装版）');
}

/* S-15：版本号来自主进程 app.getVersion()，写死的数字会让人在排障时报假版本号。 */
const appVer = ref('');
const appPackaged = ref(false);

/* S-05：模型清单来自通道真返回值（/api/models），不是写死的提供商名单。
   ok=false 时后端会把原因（未登录/令牌失效/通道不可达）写进 error，照原样显示。 */
const models = ref<ModelItem[]>([]);
const modelsLoading = ref(false);
const modelsError = ref('');
const modelDefault = ref('');
const modelProvider = ref('');
const modelsChannelError = ref(''); // S-25：EVA 通道没拿到时的原因（自定义通道仍可用）

async function loadModels() {
  if (!canPersist.value || modelsLoading.value) return;
  modelsLoading.value = true;
  modelsError.value = '';
  try {
    const d = await fetchModels();
    models.value = d.models ?? [];
    modelDefault.value = d.default || '';
    modelProvider.value = d.provider || '';
    modelsChannelError.value = d.channel_error || '';
    modelsError.value = d.ok ? '' : d.error || i18nStore.t('未能获取模型清单');
  } catch (e) {
    models.value = [];
    modelsError.value = (e as Error).message;
  } finally {
    modelsLoading.value = false;
  }
}

/* S-21：长期记忆（user_profile.md）——开关、路径、正文都来自后端真文件。
   开关现在**真生效**：开＝正文注入每一步与终答、AI 可用 remember 工具写记忆；
   关＝两件事都不做（`settings.denied_tools()` 把工具一起剔掉）。 */
const mem = ref<MemoryState | null>(null);
const memBusy = ref(false);
const memMsg = ref('');
const memTone = ref<'ok' | 'warn'>('ok');
const memEditing = ref(false);
const memDraft = ref('');
/** 后端按 KV 算出来的真实开关状态（与界面上的 t.memory 应一致；不一致说明还没保存） */
const memEnabled = computed(() => (mem.value ? mem.value.enabled : null));

async function loadMemory() {
  if (!canPersist.value) {
    mem.value = null;
    return;
  }
  try {
    mem.value = await fetchMemory();
  } catch (e) {
    mem.value = null;
    memMsg.value = (e as Error).message;
    memTone.value = 'warn';
  }
}

function startEditMemory() {
  memDraft.value = mem.value?.content ?? '';
  memEditing.value = true;
  memMsg.value = '';
}

async function onSaveMemory() {
  if (memBusy.value) return;
  memBusy.value = true;
  memMsg.value = '';
  try {
    mem.value = await saveMemory(memDraft.value);
    memEditing.value = false;
    memMsg.value = i18nStore.t('已保存：后续任务会带着这份记忆跑');
    memTone.value = 'ok';
  } catch (e) {
    // 超限等原因后端会给成句 detail，照实显示，别自己编一句"保存失败"
    memMsg.value = (e as Error).message;
    memTone.value = 'warn';
  } finally {
    memBusy.value = false;
  }
}

async function onClearMemory() {
  if (memBusy.value) return;
  if (!window.confirm(i18nStore.t('清空整份记忆？此操作不可撤销。'))) return;
  memBusy.value = true;
  memMsg.value = '';
  try {
    await clearMemory();
    memEditing.value = false;
    await loadMemory();
    memMsg.value = i18nStore.t('已清空');
    memTone.value = 'ok';
  } catch (e) {
    memMsg.value = (e as Error).message;
    memTone.value = 'warn';
  } finally {
    memBusy.value = false;
  }
}

watch(page, (p) => {
  if (p === 'model') void loadModels();
  if (p === 'context') void loadMemory();
  if (p === 'worktree') void loadWorktrees(); // S-22
  if (p === 'browser') void loadBrowser(); // S-23
  if (p === 'model') void loadProviders(); // S-25
});

/* S-22：工作树——之前这页只有"能点但没人读"的控件和一张写死"暂无数据"的表，
   因为后端根本没有工作树能力。现在建/清/统计都是真 `git worktree`：
   表里的每一行是真目录真字节数，阈值真的在建树前挡一道，保留分支真的决定删不删分支。 */
const wt = ref<WorktreeState | null>(null);
const wtBusy = ref(false);
const wtMsg = ref('');
const wtTone = ref<'ok' | 'warn'>('ok');

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(ts: number): string {
  return ts ? new Date(ts * 1000).toLocaleString() : '—';
}

/** 超过设置阈值时如实说一句——这个阈值以前只是个能填的输入框 */
const wtOver = computed(() => !!wt.value?.supported && wt.value.totalBytes >= wt.value.thresholdBytes);
const wtTotalText = computed(() => fmtBytes(wt.value?.totalBytes || 0));
const wtThresholdText = computed(() => fmtBytes(wt.value?.thresholdBytes || 0));
const wtHasTree = computed(() => (wt.value?.items || []).some((i) => !i.main));
const wtRows = computed<WorktreeItem[]>(() => (wt.value?.supported ? wt.value.items : []));

async function loadWorktrees() {
  if (!canPersist.value) {
    wt.value = null;
    return;
  }
  try {
    wt.value = await fetchWorktrees();
  } catch (e) {
    wt.value = null;
    wtMsg.value = (e as Error).message;
    wtTone.value = 'warn';
  }
}

/* 只有"清理/统计"没有"建"的话，这页永远是一张空表——能力照样等于没有。
   建树入口放在这里：填分支名 → 真 `git worktree add -b`，随后占用表里就多一行真数据。 */
const wtNew = ref('');
const wtNewBusy = ref(false);

async function onCreateWorktree() {
  const branch = wtNew.value.trim();
  if (wtBusy.value || wtNewBusy.value || !branch) return;
  wtNewBusy.value = true;
  wtMsg.value = '';
  try {
    const it = await createWorktree(branch);
    wtNew.value = '';
    wtMsg.value = `${i18nStore.t('已新建工作树：')}${it.branch || it.name}`;
    wtTone.value = 'ok';
    await loadWorktrees();
  } catch (e) {
    // 超阈值、分支名非法、分支已存在——后端都给了成句原因
    wtMsg.value = (e as Error).message;
    wtTone.value = 'warn';
  } finally {
    wtNewBusy.value = false;
  }
}

async function onDeleteWorktree(item: WorktreeItem) {
  if (wtBusy.value) return;
  const label = item.branch || item.name;
  if (!window.confirm(`${i18nStore.t('清理工作树 ')}${label}${i18nStore.t('？')}${wt.value?.keepBranch ? i18nStore.t('分支会保留。') : i18nStore.t('分支会一起删除（有未合并提交时 git 会拒绝）。')}`)) return;
  wtBusy.value = true;
  wtMsg.value = '';
  try {
    const r = await deleteWorktree(item.path);
    wtMsg.value = r.branchDropped ? `${i18nStore.t('已清理 ')}${label}${i18nStore.t('（分支一并删除）')}` : `${i18nStore.t('已清理 ')}${label}${i18nStore.t('（分支保留）')}`;
    wtTone.value = 'ok';
    await loadWorktrees();
  } catch (e) {
    // git 的原话（有未提交改动 / 分支未合并）比自造一句"清理失败"有用得多
    wtMsg.value = (e as Error).message;
    wtTone.value = 'warn';
  } finally {
    wtBusy.value = false;
  }
}

async function onPruneWorktrees() {
  if (wtBusy.value) return;
  const mine = (wt.value?.items || []).filter((i) => !i.main).length;
  if (!mine) return;
  if (!window.confirm(`${i18nStore.t('清理全部 ')}${mine}${i18nStore.t(' 棵工作树（只保留最近 1 棵）？')}`)) return;
  wtBusy.value = true;
  wtMsg.value = '';
  try {
    const r = await pruneWorktrees(1);
    wtMsg.value = r.failed.length
      ? `${i18nStore.t('已清理 ')}${r.removed.length}${i18nStore.t(' 棵，')}${r.failed.length}${i18nStore.t(' 棵未成功（多半有未提交改动）')}`
      : `${i18nStore.t('已清理 ')}${r.removed.length}${i18nStore.t(' 棵，保留 ')}${r.kept}${i18nStore.t(' 棵')}`;
    wtTone.value = r.failed.length ? 'warn' : 'ok';
    await loadWorktrees();
  } catch (e) {
    wtMsg.value = (e as Error).message;
    wtTone.value = 'warn';
  } finally {
    wtBusy.value = false;
  }
}

/* S-25：自定义模型通道（自带 Key）。此前「添加模型」点了没反应：没有地方录 Key，
   录了也没人消费——没登录就彻底不能用模型。现在录入的通道会出现在 `/api/models` 里，
   任务里选它就用它自己的地址与 Key 发请求（不登录也能跑）。 */
const providers = ref<ProviderItem[]>([]);
const pvForm = ref(false);
const pvBusy = ref(false);
const pvMsg = ref('');
const pvTone = ref<'ok' | 'warn'>('ok');
const pvTestMsg = ref('');
const pvTestOk = ref(false);
const pvDraft = ref<ProviderDraft>({ name: '', base_url: '', model: '', api_key: '' });

async function loadProviders() {
  if (!canPersist.value) {
    providers.value = [];
    return;
  }
  try {
    providers.value = (await fetchProviders()).items || [];
  } catch (e) {
    providers.value = [];
    pvMsg.value = (e as Error).message;
    pvTone.value = 'warn';
  }
}

async function onTestDraft() {
  if (pvBusy.value) return;
  pvBusy.value = true;
  pvTestMsg.value = '';
  try {
    const r = await testProviderDraft(pvDraft.value);
    pvTestOk.value = r.ok;
    pvTestMsg.value = r.ok ? r.output || i18nStore.t('接口可用') : r.error || i18nStore.t('接口不可用');
  } catch (e) {
    pvTestOk.value = false;
    pvTestMsg.value = (e as Error).message; // 地址不合法等：后端给的成句原因
  } finally {
    pvBusy.value = false;
  }
}

async function onTestProvider(id: string) {
  if (pvBusy.value) return;
  pvBusy.value = true;
  pvMsg.value = '';
  try {
    const r = await testProvider(id);
    pvTone.value = r.ok ? 'ok' : 'warn';
    pvMsg.value = r.ok ? r.output || i18nStore.t('接口可用') : r.error || i18nStore.t('接口不可用');
  } catch (e) {
    pvTone.value = 'warn';
    pvMsg.value = (e as Error).message;
  } finally {
    pvBusy.value = false;
  }
}

async function onAddProvider() {
  if (pvBusy.value) return;
  pvBusy.value = true;
  pvMsg.value = '';
  try {
    await addProvider(pvDraft.value);
    pvMsg.value = i18nStore.t('已添加：任务里选它就会用它自己的地址与 Key 发请求');
    pvTone.value = 'ok';
    pvForm.value = false;
    pvDraft.value = { name: '', base_url: '', model: '', api_key: '' };
    pvTestMsg.value = '';
    await loadProviders();
    await loadModels(); // 可用模型清单要立刻多出这一条
  } catch (e) {
    pvTone.value = 'warn';
    pvMsg.value = (e as Error).message;
  } finally {
    pvBusy.value = false;
  }
}

async function onToggleProvider(p: ProviderItem, v: boolean) {
  pvMsg.value = '';
  try {
    await updateProvider(p.id, { enabled: v });
    await loadModels();
  } catch (e) {
    p.enabled = !v; // 改不动就把开关拨回去，别显示一个假状态
    pvTone.value = 'warn';
    pvMsg.value = (e as Error).message;
  }
}

async function onRemoveProvider(p: ProviderItem) {
  if (pvBusy.value) return;
  if (!window.confirm(`${i18nStore.t('移除通道「')}${p.name}${i18nStore.t('」？已保存的 Key 会一并删掉。')}`)) return;
  pvBusy.value = true;
  pvMsg.value = '';
  try {
    await deleteProvider(p.id);
    pvTone.value = 'ok';
    pvMsg.value = i18nStore.t('已移除');
    await loadProviders();
    await loadModels();
  } catch (e) {
    pvTone.value = 'warn';
    pvMsg.value = (e as Error).message;
  } finally {
    pvBusy.value = false;
  }
}

/* S-23：内置浏览器——窗口就是 Electron 自己的 BrowserWindow（独立 partition，
   数据独立），后端下命令、主进程真执行。此前这三个控件点了没反应，因为后端没有窗口；
   现在「允许 AI 控制」真决定 AI 能不能用内置浏览器打开网页、「清除」真清站点数据、
   「自动截图」真落一张 png 到工作区、`open_url` 真按「默认浏览器」走内置或系统浏览器。 */
const bs = ref<BrowserState | null>(null);
const bsBusy = ref(false);
const bsMsg = ref('');
const bsTone = ref<'ok' | 'warn'>('ok');
const bsUrl = ref('');
const bsRows = computed(() => bs.value?.shots || []);
/* 截图地址：没有后端可拼 URL 了，主进程直接把图带回来（data URL）。
   按名字缓存，避免每次重渲染都重取一遍整张图。 */
const shotUrls = ref<Record<string, string>>({});

async function loadShotUrls() {
  for (const s of bsRows.value) {
    if (shotUrls.value[s.name]) continue;
    const u = await browserShotURL(s.name).catch(() => '');
    if (u) shotUrls.value = { ...shotUrls.value, [s.name]: u };
  }
}

async function loadBrowser() {
  if (!canPersist.value) {
    bs.value = null;
    return;
  }
  try {
    bs.value = await fetchBrowser();
    await loadShotUrls();
  } catch (e) {
    bs.value = null;
    bsMsg.value = (e as Error).message;
    bsTone.value = 'warn';
  }
}

async function onOpenInBrowser() {
  const url = bsUrl.value.trim();
  if (bsBusy.value || !url) return;
  bsBusy.value = true;
  bsMsg.value = '';
  try {
    const r = await openInBrowser(url, t.value.autoScreenshot);
    bsMsg.value = `${i18nStore.t('已在内置浏览器打开：')}${r.title || r.url}`;
    bsTone.value = 'ok';
    await loadBrowser(); // 自动截图会多一张，表要跟着变
  } catch (e) {
    bsMsg.value = (e as Error).message; // 窗口不在 / 网址不合法都如实说
    bsTone.value = 'warn';
  } finally {
    bsBusy.value = false;
  }
}

async function onClearBrowserData() {
  if (bsBusy.value) return;
  if (!window.confirm(i18nStore.t('清除内置浏览器的站点数据（Cookies、本地存储等）？只清内置浏览器，不影响应用登录态与系统浏览器。'))) return;
  bsBusy.value = true;
  bsMsg.value = '';
  try {
    await clearBrowserData();
    bsMsg.value = i18nStore.t('已清除内置浏览器的站点数据');
    bsTone.value = 'ok';
  } catch (e) {
    bsMsg.value = (e as Error).message;
    bsTone.value = 'warn';
  } finally {
    bsBusy.value = false;
  }
}

/* ---------- 设置持久化（T-015）：打开即回填、改动防抖写回 ---------- */
type SaveState = 'idle' | 'loading' | 'saving' | 'saved' | 'error';

const saveState = ref<SaveState>('idle');
const saveErr = ref('');
const failedOp = ref<'load' | 'save'>('load');
const canPersist = computed(() => bridgeAvailable());

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let hydrating = false; // 回填期间不应触发写回

function snapshot() {
  return {
    toggles: { ...t.value },
    volume: volume.value,
    worktreeGb: worktreeGb.value,
    browserDefault: browserDefault.value, // S-23
    proxyMode: proxyMode.value, // S-11
    proxyUrl: proxyUrl.value,
  };
}

async function loadSettings() {
  if (!canPersist.value) return;
  saveState.value = 'loading';
  try {
    const data = await fetchSettings();
    hydrating = true;
    const target = t.value as unknown as Record<string, unknown>;
    const toggles = (data.toggles ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(toggles)) {
      // 只回填已知字段，避免脏数据污染
      if (Object.prototype.hasOwnProperty.call(target, k)) target[k] = v;
    }
    if (typeof data.volume === 'number') volume.value = data.volume;
    if (typeof data.worktreeGb === 'string') worktreeGb.value = data.worktreeGb;
    if (typeof data.browserDefault === 'string') browserDefault.value = data.browserDefault; // S-23
    if (data.proxyMode === 'system' || data.proxyMode === 'off' || data.proxyMode === 'custom') {
      proxyMode.value = data.proxyMode;
    }
    if (typeof data.proxyUrl === 'string') proxyUrl.value = data.proxyUrl;
    setKeepAwake(t.value.keepAwake); // S-04：回填后立刻把本机行为对齐（后端重启也不丢）
    setVoiceHot(t.value.voiceHot); // S-20：同上——Alt+V 注册/注销不等后端写盘
    saveState.value = 'idle';
    saveErr.value = '';
  } catch (e) {
    failedOp.value = 'load';
    saveState.value = 'error';
    saveErr.value = (e as Error).message;
  } finally {
    // watcher 在微任务里跑，晚于此处、早于定时器，因此能正确被 hydrating 拦下
    setTimeout(() => {
      hydrating = false;
    }, 0);
  }
}

async function persist() {
  if (!canPersist.value) return;
  saveState.value = 'saving';
  try {
    await putSettings(snapshot());
    saveState.value = 'saved';
    saveErr.value = '';
    setTimeout(() => {
      if (saveState.value === 'saved') saveState.value = 'idle';
    }, 1600);
  } catch (e) {
    failedOp.value = 'save';
    saveState.value = 'error';
    saveErr.value = (e as Error).message;
  }
}

watch(
  [t, volume, worktreeGb, proxyMode, proxyUrl, browserDefault],
  () => {
    if (hydrating || !canPersist.value) return;
    // 本机行为不等后端那次防抖写盘：唤醒/休眠、快捷键都是"点了就该变"的事
    setKeepAwake(t.value.keepAwake);
    setVoiceHot(t.value.voiceHot); // S-20：Alt+V 即时注册/注销
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void persist(), 400);
  },
  { deep: true },
);

onMounted(async () => {
  await loadSettings();
  void loadWorkspaceRoot(); // S-10：显示后端真在用的工作区根
  if (page.value === 'context') void loadMemory(); // S-21
  if (page.value === 'worktree') void loadWorktrees(); // S-22
  if (page.value === 'browser') void loadBrowser(); // S-23
  if (page.value === 'model') void loadProviders(); // S-25
  const v = await fetchAppVersion(); // S-15：真实版本号
  appVer.value = v.version;
  appPackaged.value = v.packaged;
});

function retryPersist() {
  saveErr.value = '';
  void (failedOp.value === 'load' ? loadSettings() : persist());
}

/* 调试模式（请求留痕）：勾上＝给 agent 子进程注入 EVA_TS_TRACE，
   每次模型调用的完整请求体（系统提示词 + 压缩后的消息 + 工具）落盘到
   ~/.evawork/ts-agent/trace/，调提示词时复盘用。开关要立刻生效必须重拉子进程
   （环境变量只在启动时注入）；会话都落盘，重启不掉数据。勾上顺手打开那个目录。 */
async function onTraceToggle(on: boolean) {
  if (hydrating || !canPersist.value) return;
  t.value.trace = on; // 让开关立刻反映；深度 watch 之后也会回写，但先于重启要先落盘
  await putSettings(snapshot()); // 先落盘：下面重拉子进程读到的才是新值
  await tsAgentRestart().catch(() => {}); // 重拉 agent，EVA_TS_TRACE 环境变量生效
  if (on) await openTraceDir().catch(() => {}); // 勾上就打开 trace 目录
}
</script>

<template>
  <div class="pg">
    <!-- 持久化状态（诚实提示：无后端时明确告知改动不保存） -->
    <div class="s-save" :class="saveState">
      <template v-if="!canPersist">{{ i18nStore.t('未连接后端 · 改动不保存') }}</template>
      <template v-else-if="saveState === 'loading'">{{ i18nStore.t('读取设置中…') }}</template>
      <template v-else-if="saveState === 'saving'">{{ i18nStore.t('保存中…') }}</template>
      <template v-else-if="saveState === 'saved'">{{ i18nStore.t('已保存') }}</template>
      <template v-else-if="saveState === 'error'">
        {{ saveErr }}
        <button class="s-retry" @click="retryPersist">{{ i18nStore.t('重试') }}</button>
      </template>
      <template v-else>{{ i18nStore.t('已就绪') }}</template>
    </div>

    <!-- 通用 -->
    <template v-if="page === 'general'">
      <h1>{{ i18nStore.t('通用') }}</h1>
      <div class="s-sub">{{ i18nStore.t('基础设置') }}</div>
      <div class="s-card">
        <!-- S-09：这两个下拉以前是纯静态的（选了没反应）。接到 theme/i18n store 上：
             改了立刻生效、刷新后保持（store 自己持久化）。 -->
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('主题') }}</div><div class="s-row-d">{{ i18nStore.t('选择主题') }}</div></div><select v-model="themeModel" class="input"><option v-for="o in themeOptions" :key="o.v" :value="o.v">{{ o.label }}</option></select></div>
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('语言') }}</div><div class="s-row-d">{{ i18nStore.t('选择您喜欢的按钮标签和应用内其他文本的语言') }}</div></div><select v-model="localeModel" class="input"><option v-for="o in localeOptions" :key="o.v" :value="o.v">{{ o.label }}</option></select></div>
      </div>
      <div class="s-sub">{{ i18nStore.t('偏好设置') }}</div>
      <div class="s-card">
        <div class="s-row">
          <div><div class="s-row-t">{{ i18nStore.t('语音转录快捷键') }}</div><div class="s-row-d">{{ i18nStore.t('开启或关闭语音转录快捷键，录制自定义组合键，或恢复默认值。') }}</div></div>
          <div style="display: flex; gap: 10px; align-items: center">
            <!-- S-20：语音输入已落地（麦克风按钮真录音、走服务端 ASR）→ 这个键终于有目标了：
                 开启 = 主进程注册全局 Alt+V，焦点在别的软件也能唤起录音；关闭 = 立刻注销。 -->
            <UToggle v-model="t.voiceHot" :title="i18nStore.t('开启后 Alt+V 全局唤起/结束录音（语音输入已落地，识别结果回填输入框、不自动发送）')" /><span class="key-cap">Alt</span>+<span class="key-cap">V</span>
          </div>
        </div>
        <!-- 内置浏览器尚不存在（后端无实现），"用内置浏览器打开本地链接"无从谈起 → 诚实禁用，
             不做"选了有效果其实是假"的下拉 -->
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('本地链接的默认打开方式') }}</div><div class="s-row-d">{{ i18nStore.t('点击终端中的本地链接时，是否自动使用内置浏览器打开') }}</div></div><select class="input" data-coming aria-disabled="true" disabled :title="i18nStore.t('内置浏览器尚未实现，该选项暂不可用')"><option>{{ i18nStore.t('始终询问') }}</option></select></div>
        <!-- S-10：路径显示后端**真在用的**工作区根；「更改」走系统目录选择框 + PUT /api/workspace -->
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('自定义产物存储路径') }}</div><div class="s-row-d">{{ i18nStore.t('新建任务和工作空间将保存在此（读更改不会修改已有的文件路径）') }}</div></div><div style="display: flex; gap: 8px"><span class="input" style="color: var(--t2)">{{ wsRoot || i18nStore.t('未获取到（未连接后端）') }}</span><button class="btn" :disabled="wsBusy" @click="changeWorkspaceRoot">{{ wsBusy ? i18nStore.t('切换中…') : i18nStore.t('更改') }}</button></div></div>
        <div v-if="wsMsg" class="s-row-d" style="padding-bottom: 10px">{{ wsMsg }}</div>
      </div>
      <div class="s-sub">{{ i18nStore.t('网络') }}</div>
      <div class="s-card">
        <!-- S-11：代理三档；后端每次出网前把这两个值写进 HTTP(S)_PROXY -->
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('网络代理') }}</div><div class="s-row-d">{{ i18nStore.t('为应用配置网络代理') }}</div></div><select v-model="proxyMode" class="input"><option value="system">{{ i18nStore.t('跟随系统') }}</option><option value="off">{{ i18nStore.t('关闭（直连）') }}</option><option value="custom">{{ i18nStore.t('自定义') }}</option></select></div>
        <div v-if="proxyMode === 'custom'" class="s-row"><div><div class="s-row-t">{{ i18nStore.t('代理地址') }}</div><div class="s-row-d">{{ i18nStore.t('形如 http://127.0.0.1:7890，留空则等同直连') }}</div></div><input v-model.trim="proxyUrl" class="input" style="width: 220px" placeholder="http://127.0.0.1:7890" /></div>
      </div>
      <div class="s-sub">{{ i18nStore.t('AI 水印') }}</div>
      <div class="s-card">
        <div class="s-row">
          <div><div class="s-row-t">{{ i18nStore.t('隐藏 AI 生成标识') }}</div><div class="s-row-d">{{ i18nStore.t('默认关闭。开启后，您读取生成的产物内容将不再附加"AI 生成"的水印标识。') }}<br /><span class="muted small">{{ i18nStore.t('当前产物渲染没有水印逻辑，因此无标识可隐藏——开关暂不可切换。') }}</span></div></div>
          <UToggle v-model="t.aiWatermark" disabled :title="i18nStore.t('后端与界面都没有水印实现，暂无标识可隐藏')" />
        </div>
      </div>
    </template>

    <!-- 隐私模式（原账号节里的本机偏好，账号信息归「账号设置」页） -->
    <template v-else-if="page === 'privacy'">
      <h1>{{ i18nStore.t('隐私模式') }}</h1>
      <div class="s-card">
        <div class="s-row">
          <div style="max-width: 640px">
            <div class="s-row-t">{{ i18nStore.t('隐私模式') }}</div>
            <div class="s-row-d">{{ i18nStore.t('当启用隐私模式时，EVA 不会将您的信息（如您的聊天互动，包括相关代码片段和 AI 生成的输出）用于分析、产品改进和模型训练。') }}<br /><span class="muted small">{{ i18nStore.t('本地版本来就不上传任何对话与产物（模型调用除外，由你自己的账号发出），此开关暂无可关闭的上传行为，故不可切换。') }}</span></div>
          </div>
          <UToggle v-model="t.privacy" disabled :title="i18nStore.t('本地版无数据上传行为，该开关暂无对应实现')" />
        </div>
      </div>
    </template>

    <!-- EVA 移动端 -->
    <template v-else-if="page === 'mobile'">
      <h1>{{ i18nStore.t('EVA 移动端') }}</h1>
      <div class="mobile-hero">
        <div class="m-qr"><UIcon name="qr" :size="80" /></div>
        <div class="m-qr-note">{{ i18nStore.t('扫码下载 EVA 移动端') }}</div>
      </div>
      <div class="m-title">{{ i18nStore.t('让手机也能控制 EvaWork') }}</div>
      <div class="m-sub">{{ i18nStore.t('在移动端登录当前账号，打开以下权限，允许手机控制电脑') }}</div>
      <div class="s-card">
        <div class="s-row">
          <!-- S-19：原来这里写死"生效 180 天 / 2027-03-13 到期"——那是个**假日期**（本机没有
               移动端授权体系，也不存在到期一说）。与其让用户记一个不存在的到期日，如实说明。 -->
          <div><div class="s-row-t">{{ i18nStore.t('允许 EVA 移动端控制当前设备') }} <UIcon name="info" :size="11" /></div><div class="s-row-d">{{ i18nStore.t('允许 EVA 访问已创建任务的文件夹') }}<br /><span class="muted small">{{ i18nStore.t('移动端控制尚未实现：本机没有对应的授权链路，也不存在授权到期日。') }}</span></div></div>
          <UToggle v-model="t.mobileControl" disabled :title="i18nStore.t('EVA 移动端控制尚未实现，暂无对应能力')" />
        </div>
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('保持电脑唤醒') }}</div><div class="s-row-d">{{ i18nStore.t('EvaWork 运行期间防止电脑睡眠，确保任务持续执行') }}</div></div><UToggle v-model="t.keepAwake" /></div>
      </div>
    </template>

    <!-- 模型 -->
    <template v-else-if="page === 'model'">
      <h1>{{ i18nStore.t('模型') }}</h1>
      <div class="s-sub">{{ i18nStore.t('模型管理') }}</div>
      <div class="s-row-d" style="margin-bottom: 12px">{{ i18nStore.t('配置 API key 添加更多可用模型，预置模型默认使用稳定版本。') }}</div>
      <!-- S-25：「添加模型」以前是摆设（点了没反应）。现在真能加：填 OpenAI 兼容地址 +
           自己的 Key + 模型名 → 先「测试连接」真发一次请求 → 保存后出现在可用模型里，
           任务里选它就用它发请求（**不登录也能跑**）。Key 只存本机，列表只回显后 4 位。 -->
      <button class="btn" @click="pvForm = !pvForm"><UIcon name="plus" :size="12" /> {{ i18nStore.t('添加模型') }}</button>

      <div v-if="pvForm" class="s-card" style="margin-top: 10px">
        <div class="s-row">
          <div style="flex: 1; min-width: 0">
            <div class="s-row-t">{{ i18nStore.t('名称') }}</div>
            <div class="s-row-d">{{ i18nStore.t('只是给你自己认出这条通道（例如「我的 DeepSeek」）') }}</div>
          </div>
          <input v-model="pvDraft.name" class="input" style="width: 260px" placeholder="我的模型通道" />
        </div>
        <div class="s-row">
          <div style="flex: 1; min-width: 0">
            <div class="s-row-t">{{ i18nStore.t('接口地址') }}</div>
            <div class="s-row-d">{{ i18nStore.t('OpenAI 兼容地址，通常以 /v1 结尾') }}<br /><span class="muted small">{{ i18nStore.t('例如 https://api.deepseek.com/v1、http://127.0.0.1:11434/v1') }}</span></div>
          </div>
          <input v-model="pvDraft.base_url" class="input" style="width: 260px" placeholder="https://api.deepseek.com/v1" />
        </div>
        <div class="s-row">
          <div style="flex: 1; min-width: 0">
            <div class="s-row-t">{{ i18nStore.t('API Key') }}</div>
            <div class="s-row-d">{{ i18nStore.t('存在本机 SQLite，不会上传到任何地方（本地服务可留空）') }}</div>
          </div>
          <input v-model="pvDraft.api_key" class="input" style="width: 260px" type="password" placeholder="sk-..." />
        </div>
        <div class="s-row">
          <div style="flex: 1; min-width: 0">
            <div class="s-row-t">{{ i18nStore.t('模型名') }}</div>
            <div class="s-row-d">{{ i18nStore.t('接口那边的模型 id（例如 deepseek-chat、qwen-plus）') }}</div>
          </div>
          <input v-model="pvDraft.model" class="input" style="width: 260px" placeholder="deepseek-chat" />
        </div>
        <div class="s-row">
          <div style="flex: 1; min-width: 0">
            <div v-if="pvTestMsg" class="s-row-d" :style="{ color: pvTestOk ? 'var(--green)' : 'var(--red)' }">{{ pvTestMsg }}</div>
            <div v-else class="s-row-d muted small">{{ i18nStore.t('保存前可以先测一下：真发一次最小请求，能不能用由接口说了算。') }}</div>
          </div>
          <div style="display: flex; gap: 6px">
            <button class="btn" :disabled="pvBusy" @click="onTestDraft">{{ pvBusy ? i18nStore.t('测试中…') : i18nStore.t('测试连接') }}</button>
            <button class="btn btn-save" :disabled="pvBusy" @click="onAddProvider">{{ i18nStore.t('保存') }}</button>
          </div>
        </div>
      </div>

      <div class="s-sub" style="display: flex; justify-content: space-between; align-items: center">
        <span>{{ i18nStore.t('我添加的模型') }}<template v-if="providers.length"> <span class="small muted">共 {{ providers.length }} 条</span></template></span>
        <button class="icon-btn" :disabled="pvBusy || !canPersist" @click="loadProviders" :title="i18nStore.t('重新读取')"><UIcon name="refresh" :size="13" /></button>
      </div>
      <div class="s-card">
        <div v-if="!canPersist" class="s-row-d">{{ i18nStore.t('未连接后端，读不到已添加的通道。') }}</div>
        <div v-else-if="!providers.length" class="s-row-d">{{ i18nStore.t('还没有添加任何通道——点上面的「添加模型」录入你自己的 Key。') }}</div>
        <div v-for="p in providers" :key="p.id" class="s-row">
          <div style="flex: 1; min-width: 0">
            <div class="s-row-t">{{ p.name }}</div>
            <div class="s-row-d">
              {{ p.model }} · {{ p.base_url }}
              <span v-if="p.has_key"> · Key 尾号 {{ p.key_hint }}</span>
              <span v-else> · 无 Key（本地服务）</span>
              <span v-if="!p.enabled"> · 已停用</span>
            </div>
          </div>
          <div style="display: flex; gap: 6px; align-items: center">
            <UToggle v-model="p.enabled" @update:model-value="(v: boolean) => onToggleProvider(p, v)" :title="p.enabled ? '停用后这条通道立刻不再被使用' : '启用后在可用模型里出现'" />
            <button class="btn" :disabled="pvBusy" @click="onTestProvider(p.id)">{{ i18nStore.t('测试') }}</button>
            <button class="btn" style="color: var(--red)" :disabled="pvBusy" @click="onRemoveProvider(p)">{{ i18nStore.t('移除') }}</button>
          </div>
        </div>
        <p v-if="pvMsg" class="update-note" :class="pvTone" style="margin: 8px 12px 10px">{{ pvMsg }}</p>
      </div>

      <!-- S-05：这里以前列的是 data/mock 里写死的 18 个"提供商"，点了没反应。
           改为展示**通道真返回的清单**（/api/models）：拿不到就说清为什么拿不到，
           不拿一份假名单冒充"已接入"。 -->
      <div class="s-sub" style="display: flex; justify-content: space-between">
        {{ i18nStore.t('当前可用模型') }}
        <button class="icon-btn" :title="modelsLoading ? i18nStore.t('刷新中…') : i18nStore.t('刷新模型清单')" @click="loadModels">
          <UIcon name="refresh" :size="13" />
        </button>
      </div>
      <div class="s-card">
        <div v-if="!canPersist" class="s-row-d">{{ i18nStore.t('未连接后端，无法读取模型清单。') }}</div>
        <div v-else-if="modelsLoading" class="s-row-d">{{ i18nStore.t('读取模型清单中…') }}</div>
        <div v-else-if="modelsError" class="s-row-d">{{ modelsError }}</div>
        <div v-else-if="!models.length" class="s-row-d">{{ i18nStore.t('通道未返回任何模型。') }}</div>
        <div v-for="m in models" :key="m.id" class="s-row">
          <div>
            <div class="s-row-t">{{ m.name || m.id }}<span v-if="m.custom" class="small muted">{{ i18nStore.t(' · 我添加的') }}</span></div>
            <div class="s-row-d">{{ m.id }}<span v-if="m.id === modelDefault">{{ i18nStore.t(' · 通道默认') }}</span></div>
          </div>
        </div>
      </div>
      <div v-if="modelProvider" class="s-row-d" style="margin-top: 8px">
        {{ i18nStore.t('当前通道：') }}{{ modelProvider }}
      </div>
      <div v-if="modelsChannelError" class="s-row-d" style="margin-top: 4px">
        {{ i18nStore.t('EVA 通道：') }}{{ modelsChannelError }}{{ i18nStore.t('（上面「我添加的模型」不受影响）') }}
      </div>
    </template>

    <!-- 对话流 -->
    <template v-else-if="page === 'chat'">
      <h1>{{ i18nStore.t('对话流') }}</h1>
      <div class="s-sub">{{ i18nStore.t('任务状态通知') }} <UIcon name="info" :size="11" /></div>
      <div class="s-card">
        <div class="s-row">
          <div><div class="s-row-t">{{ i18nStore.t('允许在任务完成或失败时接收通知') }}</div><div class="s-row-d">{{ i18nStore.t('允许在任务完成或失败时接收通知! 请在 Windows 的系统设置 &gt; 通知中开启通知，以便及时收到提醒') }}</div></div>
          <div style="display: flex; flex-direction: column; gap: 8px">
            <!-- S-12：打开横幅时顺手要通知授权（Electron 里默认允许；被拒就把原因说出来） -->
            <div style="display: flex; align-items: center; gap: 8px; justify-content: flex-end">{{ i18nStore.t('横幅') }} <UToggle v-model="t.notify" @update:model-value="onNotifyToggle" /></div>
            <div style="display: flex; align-items: center; gap: 8px; justify-content: flex-end">{{ i18nStore.t('声音') }} <UToggle v-model="t.sound" /></div>
          </div>
        </div>
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('音量设置') }}</div></div><div style="display: flex; align-items: center; gap: 10px"><input v-model.number="volume" type="range" min="0" max="100" style="width: 180px" /><b class="small">{{ volume }}%</b></div></div>
        <!-- S-12：播放按钮真的响（音量取上面的滑条）；上传自定义音效没实现 → 保留图标但标 data-coming -->
        <div v-for="s in ['任务完成', '等待操作', '异常打断']" :key="s" class="s-row">
          <span class="srv-ic" style="background: var(--violet-bg); color: var(--violet)"><UIcon name="play" :size="12" /></span>
          <div><div class="s-row-t">{{ i18nStore.t(s) }}</div><div class="s-row-d">{{ i18nStore.t('默认') }}</div></div>
          <div style="margin-left: auto; display: flex; gap: 4px">
            <button class="icon-btn" :title="`试听「${i18nStore.t(s)}」提示音`" @click="previewChime(s)"><UIcon name="play" :size="13" /></button>
            <button class="icon-btn" data-coming aria-disabled="true" disabled :title="i18nStore.t('上传自定义音效功能开发中，敬请期待')"><UIcon name="upload" :size="13" /></button>
          </div>
        </div>
        <div v-if="audioMsg" class="s-row-d" style="padding-bottom: 10px">{{ audioMsg }}</div>
      </div>
      <div class="s-sub">{{ i18nStore.t('智能跟进推荐') }}</div>
      <div class="s-card">
        <!-- S-24：开关已真生效——任务跑完由 `/api/tasks/{tid}/followup` 调模型生成建议，
             会话末尾以"接下来可以做"出现，点一下就当追问发出去；关掉则不出、也不生成。 -->
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('启用智能跟进推荐') }}</div><div class="s-row-d">{{ i18nStore.t('每轮任务结束后推荐下一步操作（点一下即发出追问）。') }}<br /><span class="muted small">{{ i18nStore.t('关闭后不再生成也不显示；未登录/离线演示时会如实说明原因。') }}</span></div></div><UToggle v-model="t.followUp" /></div>
      </div>
    </template>

    <!-- 浏览器 -->
    <template v-else-if="page === 'browser'">
      <h1>{{ i18nStore.t('浏览器') }}</h1>
      <!-- S-23：内置浏览器已落地（真 Electron 窗口，独立 partition）→ 开关、清除、自动截图
           全部转真；「导入...」仍未实现（不支持从别的浏览器导入书签/密码），照旧诚实禁用。 -->
      <div class="s-sub">{{ i18nStore.t('内置浏览器') }} <button class="btn-plain" style="float: right" data-coming aria-disabled="true" disabled :title="i18nStore.t('内置浏览器暂不支持从其它浏览器导入书签/密码')">导入...</button></div>
      <div class="s-card">
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('允许 AI 控制内置浏览器') }}</div><div class="s-row-d">{{ i18nStore.t('允许 AI 助手在内置浏览器中自动执行网页浏览任务') }}<br /><span class="muted small">{{ i18nStore.t('关掉＝AI 只能用系统默认浏览器（两个都关＝AI 打不开任何网页）。') }}</span></div></div><UToggle v-model="t.innerBrowser" :title="i18nStore.t('开＝AI 可在内置浏览器窗口里打开网页；关＝只剩系统默认浏览器')" /></div>
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('浏览器数据') }}</div><div class="s-row-d">{{ i18nStore.t('内置浏览器中的站点数据（如 Cookies、本地存储等）') }}<br /><span class="muted small">{{ i18nStore.t('只清内置浏览器自己的数据，不动应用登录态、也不动系统浏览器。') }}</span></div></div><button class="btn" style="color: var(--red)" :disabled="bsBusy || !bs?.connected" @click="onClearBrowserData">{{ bsBusy ? i18nStore.t('清除中…') : i18nStore.t('清除') }}</button></div>
        <div class="s-row">
          <div style="flex: 1; min-width: 0"><div class="s-row-t">{{ i18nStore.t('试一下内置浏览器') }}</div><div class="s-row-d">{{ i18nStore.t('直接在这儿打开一个网址（真窗口），验证它能不能用') }}</div></div>
          <div style="display: flex; gap: 6px">
            <input v-model="bsUrl" class="input" style="width: 220px" placeholder="https://example.com" @keyup.enter="onOpenInBrowser" />
            <button class="btn" :disabled="bsBusy || !bs?.connected || !bsUrl.trim()" @click="onOpenInBrowser">{{ bsBusy ? i18nStore.t('打开中…') : i18nStore.t('打开') }}</button>
          </div>
        </div>
        <div v-if="bs" class="s-row-d" style="padding: 0 12px 10px">
          {{ i18nStore.t('内置浏览器窗口：') }}{{ bs.connected ? i18nStore.t('已连接') : i18nStore.t('未连接（需要运行中的桌面端窗口）') }}
        </div>
      </div>
      <div class="s-sub">{{ i18nStore.t('外部浏览器') }}</div>
      <div class="s-card">
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('允许 AI 控制外部浏览器') }}</div><div class="s-row-d">{{ i18nStore.t('开启后，AI 助手可以使用外部 Chrome 浏览器执行网页浏览任务') }}</div></div><UToggle v-model="t.outerBrowser" /></div>
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('连接到 Chrome') }}</div><div class="s-row-d">{{ i18nStore.t('如果未安装 Chrome 扩展，AI 可能无法正常打开浏览器。') }}</div></div><span class="s-row-d">{{ i18nStore.t('当前版本不检测本地 Chrome（AI 直接用系统默认浏览器打开网页）') }}</span></div>
      </div>
      <div class="s-sub">{{ i18nStore.t('通用') }}</div>
      <div class="s-card">
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('AI 任务默认浏览器') }}</div><div class="s-row-d">{{ i18nStore.t('选择 AI 助手执行 Browser Use 任务时默认使用的浏览器') }}<br /><span class="muted small">{{ i18nStore.t('选内置浏览器＝AI 用 `open_url` 时开在应用内的窗口里；内置窗口不在时会如实报错（外部开着才退回系统浏览器）。') }}</span></div></div><select v-model="browserDefault" class="input"><option>{{ i18nStore.t('内置浏览器') }}</option><option>{{ i18nStore.t('系统默认浏览器') }}</option></select></div>
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('自动截图') }}</div><div class="s-row-d">{{ i18nStore.t('浏览器操作后自动截取屏幕截图，仅用于展示，不消耗 Token') }}<br /><span class="muted small">{{ i18nStore.t('截图落到工作区 .evawork/screenshots/，AI 想看才读（不自动塞进上下文）。') }}</span></div></div><UToggle v-model="t.autoScreenshot" :title="i18nStore.t('开＝内置浏览器打开页面后自动截一张存到工作区')" /></div>
      </div>
      <div class="s-sub" style="display: flex; justify-content: space-between; align-items: center">
        <span>{{ i18nStore.t('最近截图') }}<template v-if="bs?.shots.length"> <span class="small muted">共 {{ bs.shots.length }} 张</span></template></span>
        <button class="icon-btn" :disabled="bsBusy || !canPersist" @click="loadBrowser" :title="i18nStore.t('重新读取')"><UIcon name="refresh" :size="13" /></button>
      </div>
      <div class="s-card">
        <div v-if="!bs" class="s-row"><div class="s-row-d">{{ i18nStore.t('未连接后端，读不到内置浏览器状态') }}</div></div>
        <div v-else-if="!bsRows.length" class="s-row"><div class="s-row-d">{{ i18nStore.t('还没有截图——用上面的「打开」试一下，内置浏览器加载完会自动截一张') }}</div></div>
        <div v-else class="shot-grid">
          <figure v-for="s in bsRows" :key="s.name">
            <img :src="shotUrls[s.name] || ''" :alt="s.name" />
            <figcaption>{{ s.name }}<span class="small muted"> · {{ (s.bytes / 1024).toFixed(0) }} KB</span></figcaption>
          </figure>
        </div>
        <p v-if="bsMsg" class="update-note" :class="bsTone" style="margin: 8px 12px 10px">{{ bsMsg }}</p>
      </div>
    </template>

    <!-- 电脑控制 -->
    <template v-else-if="page === 'computer'">
      <h1>{{ i18nStore.t('电脑控制') }}</h1>
      <div class="s-sub">{{ i18nStore.t('启用') }}</div>
      <div class="s-card">
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('启用电脑控制') }}</div><div class="s-row-d">{{ i18nStore.t('允许 AI 助手控制你的鼠标和键盘，与桌面应用程序进行交互') }}</div></div><UToggle v-model="t.computerControl" /></div>
      </div>
    </template>

    <!-- 工作树 -->
    <template v-else-if="page === 'worktree'">
      <h1>{{ i18nStore.t('工作树') }} <UIcon name="info" :size="13" /></h1>
      <div class="s-sub">{{ i18nStore.t('工作树清理') }}</div>
      <div class="s-card">
        <!-- S-22：工作树能力已落地（真 `git worktree`），这两个控件不再是摆设——
             保留分支：真决定清理时删不删分支（未合并的分支 git 会拒绝删，如实报错）
             GB 阈值：真在建树前挡一道（达到阈值就拒绝新建并说明还差多少） -->
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('清理工作树时默认保留分支') }}</div><div class="s-row-d">{{ i18nStore.t('若保留，则清理时仅删除工作树目录；若不保留，则同时删除工作树目录和分支') }}<br /><span class="muted small">{{ i18nStore.t('未合并的分支 git 会拒绝删除，届时会如实提示（不静默丢工作）。') }}</span></div></div><UToggle v-model="t.worktreeClean" :title="i18nStore.t('开启＝只删工作树目录；关闭＝连分支一起删（有未合并提交时删不掉）')" /></div>
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('工作树磁盘空间占用提醒') }}</div><div class="s-row-d">{{ i18nStore.t('当项目中的工作树目录的磁盘空间占用达到设定大小时，提醒清理工作树') }}<br /><span class="muted small">{{ i18nStore.t('建新工作树前会按这个阈值挡一道；当前合计 ') }}{{ fmtBytes(wt?.totalBytes || 0) }}<template v-if="wtOver"> · <span style="color: var(--warn)">{{ i18nStore.t('已达阈值，新建会被拒绝') }}</span></template>。</span></div></div><div class="input" style="display: flex; align-items: center; width: 130px; justify-content: space-between; padding: 0 8px"><input v-model="worktreeGb" inputmode="numeric" :title="i18nStore.t('工作树占用达到该阈值时提醒清理，并拒绝新建')" style="width: 74px; border: none; background: transparent; color: inherit; font: inherit; outline: none" /><span class="small muted">GB</span></div></div>
      </div>
      <div class="s-sub">{{ i18nStore.t('新建工作树') }}</div>
      <div class="s-card">
        <div class="s-row">
          <div><div class="s-row-t">{{ i18nStore.t('新建一棵工作树') }}</div><div class="s-row-d">{{ i18nStore.t('在当前工作区的 .evawork/worktrees 下建一个独立目录并切出新分支；占用达到上面的阈值时会被拒绝（阈值不是摆设）') }}</div></div>
          <div style="display: flex; gap: 6px">
            <input v-model="wtNew" class="input" style="width: 190px" :placeholder="i18nStore.t('分支名，如 feature/login')" @keyup.enter="onCreateWorktree" />
            <button class="btn btn-save" :disabled="wtBusy || wtNewBusy || !wt?.supported || !wtNew.trim()" @click="onCreateWorktree">{{ wtNewBusy ? i18nStore.t('新建中…') : i18nStore.t('新建') }}</button>
          </div>
        </div>
      </div>
      <div class="s-sub" style="display: flex; justify-content: space-between; align-items: center">
        <span>{{ i18nStore.t('工作树磁盘占用') }} <span v-if="wt?.supported" class="small muted">合计 {{ wtTotalText }} / 阈值 {{ wtThresholdText }}</span></span>
        <span style="display: flex; gap: 6px; align-items: center">
          <button class="btn" :disabled="wtBusy || !wtHasTree" @click="onPruneWorktrees">{{ i18nStore.t('清理（保留最近 1 棵）') }}</button>
          <button class="icon-btn" :disabled="wtBusy || !canPersist" @click="loadWorktrees" :title="i18nStore.t('重新统计工作树占用')"><UIcon name="refresh" :size="13" /></button>
        </span>
      </div>
      <div class="s-card table-card">
        <table>
          <thead><tr><th>{{ i18nStore.t('名称') }}</th><th>{{ i18nStore.t('物理占用') }}</th><th>{{ i18nStore.t('上次使用时间') }}</th><th></th></tr></thead>
          <tbody>
            <tr v-if="!wt"><td colspan="4" class="table-empty">{{ i18nStore.t('未连接后端，读不到工作树') }}</td></tr>
            <tr v-else-if="!wt.supported"><td colspan="4" class="table-empty">{{ wt.reason || '当前环境不支持工作树' }}</td></tr>
            <tr v-else-if="!wt.items.length"><td colspan="4" class="table-empty">{{ i18nStore.t('当前没有工作树') }}<br /><span class="muted small">{{ i18nStore.t('任务直接在「我的文件」工作区内执行') }}</span></td></tr>
            <tr v-for="it in wtRows" :key="it.path">
              <td>
                {{ it.branch || it.name }}<span v-if="it.main" class="small muted">{{ i18nStore.t(' · 主工作树') }}</span>
                <span v-else-if="it.detached" class="small muted">{{ i18nStore.t(' · 游离 HEAD') }}</span>
                <div class="small muted" style="word-break: break-all">{{ it.path }}</div>
              </td>
              <td>{{ it.main ? '—' : fmtBytes(it.sizeBytes) }}<span v-if="it.truncated" class="small muted">（≥）</span></td>
              <td>{{ fmtTime(it.mtime) }}</td>
              <td><button v-if="!it.main" class="btn" :disabled="wtBusy" @click="onDeleteWorktree(it)">{{ i18nStore.t('清理') }}</button></td>
            </tr>
          </tbody>
        </table>
        <p v-if="wtMsg" class="update-note" :class="wtTone" style="margin: 8px 12px 10px">{{ wtMsg }}</p>
      </div>
    </template>

    <!-- 上下文与记忆：本机要不要读 AGENTS.md、开不开记忆，是本地偏好；
         规则条目本身在同壳的「规则」页（真落库） -->
    <template v-else-if="page === 'context'">
      <h1>{{ i18nStore.t('上下文与记忆') }}</h1>
      <div class="s-sub">{{ i18nStore.t('导入设置') }}</div>
      <div class="s-card">
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('将 AGENTS.md 包含在上下文中') }}</div><div class="s-row-d">{{ i18nStore.t('智能体将读取根目录中的 AGENTS.md 文件并将其添加到上下文中。') }}</div></div><UToggle v-model="t.agentsMd" /></div>
        <div class="s-row"><div><div class="s-row-t">{{ i18nStore.t('将 CLAUDE.md 包含在上下文中') }}</div><div class="s-row-d">{{ i18nStore.t('智能体将读取根目录中的 CLAUDE.md 和 CLAUDE.local.md 文件并将其添加到上下文中。') }}</div></div><UToggle v-model="t.claudeMd" /></div>
      </div>
      <!-- S-21：记忆已落地——开关真生效（注入上下文 + AI 可用 remember 写）、
           路径与正文都来自后端真文件，不再是写死的别人的目录。 -->
      <div class="s-sub">{{ i18nStore.t('记忆') }} <span class="tag tag-violet">Beta</span></div>
      <div class="s-card">
        <div class="s-row">
          <div>
            <div class="s-row-t">{{ i18nStore.t('记忆') }}</div>
            <div class="s-row-d">
              {{ i18nStore.t('把记忆正文注入每个任务的上下文（与项目指令同级），并允许 AI 用 remember 工具记下你说过的长期偏好。') }}<br />
              <span class="muted small">{{ i18nStore.t('关闭＝既不注入上下文，AI 也写不进记忆（工具一并从清单里剔除）。') }}</span>
            </div>
          </div>
          <UToggle v-model="t.memory" />
        </div>
        <div class="s-row">
          <span class="srv-ic" style="background: var(--violet-bg); color: var(--violet)"><UIcon name="sparkle" :size="12" /></span>
          <div style="flex: 1; min-width: 0">
            <div class="s-row-t">{{ i18nStore.t('用户记忆') }}</div>
            <div class="s-row-d mem-path">{{ mem?.path || i18nStore.t('未连接后端，无法读取记忆文件') }}</div>
          </div>
          <div style="margin-left: auto; display: flex; gap: 6px">
            <button class="btn" :disabled="!mem || memBusy" @click="startEditMemory">{{ i18nStore.t('编辑') }}</button>
            <button class="btn" :disabled="!mem?.exists || memBusy" @click="onClearMemory">{{ i18nStore.t('清空') }}</button>
          </div>
        </div>
        <div v-if="mem" class="s-row-d mem-meta">
          {{ mem.exists ? `${i18nStore.t('共 ')}${mem.chars}${i18nStore.t(' 字（上限 ')}${mem.limit}${i18nStore.t('）')}` : i18nStore.t('尚无记忆文件') }}<template v-if="mem.updated">{{ i18nStore.t(' · 更新于 ') }}{{ new Date(mem.updated * 1000).toLocaleString() }}</template>
          <template v-if="memEnabled !== null && memEnabled !== t.memory">{{ i18nStore.t(' · 后端当前') }}{{ memEnabled ? i18nStore.t('启用') : i18nStore.t('停用') }}{{ i18nStore.t('（保存后一致）') }}</template>
        </div>
        <div v-if="memEditing" class="mem-edit">
          <textarea v-model="memDraft" class="input mem-text" spellcheck="false" :placeholder="i18nStore.t('一行一条事实，例如：\n- 用户偏好用中文回复\n- 报告默认导出到 ./reports/')"></textarea>
          <div class="mem-actions">
            <button class="btn btn-save" :disabled="memBusy" @click="onSaveMemory">{{ memBusy ? i18nStore.t('保存中…') : i18nStore.t('保存') }}</button>
            <button class="btn" :disabled="memBusy" @click="memEditing = false; memMsg = ''">{{ i18nStore.t('取消') }}</button>
          </div>
        </div>
        <div v-else-if="mem?.content" class="mem-view">{{ mem.content }}</div>
        <p v-if="memMsg" class="update-note" :class="memTone">{{ memMsg }}</p>
      </div>
      <!-- 调试模式（请求留痕）：调提示词时想看"到底发给模型什么"。
           落点 ~/.evawork/ts-agent/trace/（EVA_TS_TRACE_DIR 可覆盖），每个模型调用一个
           req-<step>-<ts>.json。开关会重拉 agent 才生效，勾上顺手打开该目录。 -->
      <div class="s-sub">{{ i18nStore.t('调试') }}</div>
      <div class="s-card">
        <div class="s-row">
          <div>
            <div class="s-row-t">{{ i18nStore.t('调试模式（请求留痕）') }}</div>
            <div class="s-row-d">
              {{ i18nStore.t('开启后，每次发给模型的完整请求体（系统提示词 + 压缩后的消息 + 工具）会写入本地 trace 目录，便于调提示词时复盘。') }}<br />
              <span class="muted small">{{ i18nStore.t('默认关闭、不写盘；开启会重拉智能体子进程使其生效，会话不会丢失。') }}</span>
            </div>
          </div>
          <UToggle :model-value="t.trace" @update:model-value="(v: boolean) => onTraceToggle(v)" :title="i18nStore.t('勾上＝开留痕并自动打开 trace 目录')" />
        </div>
      </div>
    </template>

    <!-- 智能体二选一（TS-052） -->
    <template v-else-if="page === 'agent'">
      <h1>{{ i18nStore.t('智能体') }}</h1>
      <div class="s-card" style="margin-top: 16px">
        <div class="s-row">
          <div>
            <div class="s-row-t">{{ i18nStore.t('智能体内核') }}</div>
            <div class="s-row-d">
              {{ i18nStore.t('只剩一套智能体内核：TS 智能体（零依赖 Node 运行时，工具 / 沙箱档位走同一份契约') }}
              <span class="muted">（shared/agent-contract.json）</span>{{ i18nStore.t('。Python 后端已废弃，不再拉起。') }}
            </div>
          </div>
        </div>

        <div class="s-row">
          <span class="muted small" style="margin-left: auto">
            {{ agentRunning ? i18nStore.t('TS 智能体运行中') : i18nStore.t('TS 智能体未运行') }}
          </span>
        </div>
        <p v-if="!agentBridge" class="update-note warn">{{ i18nStore.t('当前不在桌面安装版内（缺少主进程桥）：智能体不可用。') }}</p>
        <p v-else-if="agentMsg" class="update-note" :class="agentMsg.includes('失败') || agentMsg.includes('未能') ? 'warn' : 'ok'">{{ agentMsg }}</p>
      </div>
    </template>

    <!-- Beta -->
    <template v-else-if="page === 'beta'">
      <h1>{{ i18nStore.t('Beta') }}</h1>
      <div class="s-card" style="margin-top: 16px">
        <div class="s-row">
          <div><div class="s-row-t">{{ i18nStore.t('实验性功能') }}</div><div class="s-row-d">{{ i18nStore.t('抢先体验尚未正式发布的新能力，功能可能随时调整。') }}<br /><span class="muted small">{{ i18nStore.t('当前没有可开关的实验性功能；新能力会先出现在这里。') }}</span></div></div>
        </div>
      </div>
    </template>

    <!-- 关于 -->
    <template v-else>
      <h1>{{ i18nStore.t('关于 EvaWork') }}</h1>
      <div class="s-card" style="margin-top: 16px">
        <div class="s-row">
          <span class="srv-ic" style="background: var(--violet-bg); color: var(--violet)"><UIcon name="chat" :size="14" /></span>
          <!-- S-15：版本号取主进程 app.getVersion()。写死的数字会让排障时报出假版本号 -->
          <div><div class="s-row-t">{{ i18nStore.t('版本: ') }}{{ appVer || i18nStore.t('不可用（仅桌面安装版）') }}</div><div class="s-row-d">{{ appPackaged ? i18nStore.t('安装版') : i18nStore.t('开发模式') }}</div></div>
          <button class="btn" style="margin-left: auto" :disabled="updateState.busy" @click="onCheckUpdates">
            {{ updateState.busy ? i18nStore.t('检查中…') : i18nStore.t('检查更新') }}
          </button>
        </div>
        <p v-if="updateState.text" class="update-note" :class="updateState.tone">{{ updateState.text }}</p>
      </div>
      <div class="s-card">
        <div v-for="l in ['用户协议', '隐私条款', '开源软件声明', '帮助文档', '联系我们', '官方社区', '报告问题', '更新日志']" :key="l" class="s-row link-row" data-coming aria-disabled="true" :title="i18nStore.t('该链接功能开发中，敬请期待')">
          <span>{{ i18nStore.t(l) }}</span><UIcon name="external" :size="12" class="muted" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pg h1 { font-size: 22px; margin-bottom: 4px; }
.s-sub { font-size: 13px; font-weight: 600; margin: 16px 0 8px; }
.s-card { border: 1px solid var(--line); border-radius: 12px; padding: 4px 14px; background: var(--panel); }
.s-card .s-row { padding: 12px 0; }
.s-row { display: flex; align-items: center; gap: 12px; }
.s-row + .s-row { border-top: 1px solid var(--line-2); }
.s-row-t { font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 5px; }
.s-row-d { font-size: 11.5px; color: var(--t2); margin-top: 3px; line-height: 1.6; }
.key-cap { border: 1px solid var(--line); border-radius: 5px; padding: 1px 7px; font-size: 11px; background: var(--line-2); }
.table-card { padding: 0; overflow: hidden; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; padding: 10px 14px; background: var(--bg); color: var(--t2); font-weight: 500; border-bottom: 1px solid var(--line); }
td { padding: 10px 14px; border-bottom: 1px solid var(--line-2); white-space: pre-line; }
.table-empty { text-align: center; padding: 36px 0; color: var(--t2); }
.rc-t { font-size: 13px; display: block; margin-bottom: 3px; }
.srv-ic { width: 26px; height: 26px; border-radius: 7px; background: var(--line-2); color: var(--green); display: inline-flex; align-items: center; justify-content: center; flex: none; font-weight: 700; font-size: 12px; }
.link-row { cursor: pointer; }
.link-row:hover { background: var(--line-2); margin: 0 -14px; padding: 12px 14px; }
.link-row span { font-size: 13px; }
.mobile-hero { display: flex; flex-direction: column; align-items: center; padding: 26px 0 8px; }
.m-qr { border: 1px solid var(--line); border-radius: 12px; padding: 16px; color: var(--t1); }
.m-qr-note { font-size: 12px; color: var(--t2); margin-top: 10px; }
.m-title { text-align: center; font-size: 16px; font-weight: 700; margin-top: 10px; }
.m-sub { text-align: center; font-size: 12px; color: var(--t2); margin: 6px 0 14px; }
.provider-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px; }
.provider { display: flex; align-items: center; gap: 8px; padding: 10px 12px; font-size: 12.5px; cursor: pointer; }
.provider:hover { border-color: var(--t3); }

/* T-119：检查更新的结果得看得见——点完什么都不发生的按钮等于没做这个功能 */
.update-note { margin: 0 0 10px; font-size: 12px; color: var(--t2); }
.update-note.warn { color: var(--red); }

/* S-21：记忆正文要能看能改——"记忆"如果不给用户看和改，就只是个黑盒 */
.mem-path { font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }
/* S-23：最近截图（真 png，直接嵌后端返回的字节） */
.shot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; padding: 12px; }
.shot-grid figure { margin: 0; }
.shot-grid img { width: 100%; border-radius: 8px; border: 1px solid var(--line); display: block; background: var(--bg); }
.shot-grid figcaption { font-size: 11px; color: var(--t2); margin-top: 4px; word-break: break-all; }
.mem-meta { padding: 0 14px 12px; }
.mem-view {
  margin: 0 14px 14px; padding: 10px 12px; border-radius: 8px; white-space: pre-wrap;
  background: var(--bg); border: 1px solid var(--line);
  font-size: 12px; line-height: 1.7; max-height: 220px; overflow: auto;
}
.mem-edit { margin: 0 14px 14px; }
.mem-text { width: 100%; min-height: 160px; resize: vertical; font-size: 12px; line-height: 1.7; padding: 10px 12px; }
.mem-actions { display: flex; gap: 8px; margin-top: 8px; }
.mem-actions .btn-save { background: var(--green); color: #fff; border-color: transparent; }

/* 持久化状态：合并后没有弹窗右上角的固定位了，改成内容区顶部一条，跟着内容走 */
.s-save {
  display: inline-flex; align-items: center; gap: 6px; margin: 4px 0 10px;
  height: 22px; padding: 0 9px; border-radius: 6px;
  font-size: 11.5px; background: var(--line-2); color: var(--t2);
}
.s-save.saved { background: var(--ok-bg); color: var(--ok); }
.s-save.saving, .s-save.loading { background: var(--violet-bg); color: var(--violet); }
.s-save.error { background: var(--err-bg); color: var(--err); }
.s-retry { font-size: 11.5px; color: inherit; text-decoration: underline; }
</style>
