<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UIcon from '@/components/UIcon.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import DiffView from '@/components/DiffView.vue';
// 工作区面板（文件树 + xterm 终端）体积不小，且只在点开时才用得上 → 按需加载，
// 别让"打开任务页"先把终端那一坨拖下来。
const WorkspacePanel = defineAsyncComponent(() => import('@/components/WorkspacePanel.vue'));
import { fetchInstalledSkills, type LoadedSkill, type ModelItem } from '@/api/catalog';
import { fetchInstalledPlugins, fetchPluginTools, type InstalledPlugin } from '@/api/plugins';
import { quickChips, taskSuggestions } from '@/data/mock';
import { useUiStore } from '@/stores/ui';
import { useAccountStore } from '@/stores/account';
import { newTaskSeq } from '@/stores/newTaskBus';
import { bridgeAvailable, onBackend, onShortcut } from '@/api/backend';
import { useVoiceInput } from '@/composables/useVoiceInput';
import {
  cancelTask,
  createTask,
  appendTaskMessage,
  fetchFollowup,
  fetchTask,
  fetchTaskEvents,
  STEP_LABEL,
  streamTask,
  type Artifact,
  type ContextUsage,
  type Step,
  type StreamEvent,
} from '@/api/tasks';
import { useArtifactSave } from '@/composables/useArtifactSave';
import { useToolRuns, type ToolRun } from '@/composables/useToolRuns';
import { notifyTask, playChime, type ChimeKind } from '@/composables/useNotify';
import { fetchSettings } from '@/api/settings';
import { getAgentChoice, tsAgentAvailable } from '@/api/tsAgent';
import { cancelTsAgentFor, isTsTaskId, replayTsTask, streamTsTask, tsSessionOf, tsTaskId } from '@/api/tsChannel';
import { tsAgentContextUsage, fetchTsModels } from '@/api/tsAgent';
import { fetchFileContent, fetchFileRoots, openFilePath, type FilePreview } from '@/api/files';
import { attachPaths, attachmentPreview, captureScreen, pickFiles, removeAttachment, type Attachment } from '@/api/attachments';
import { addProvider, deleteProvider, fetchProviders, testProvider, testProviderDraft, updateProvider, type ProviderDraft } from '@/api/providers';

/* T-035：产物回写「我的文件」 */
const { savingId: savingArtifact, artMsg, saveArtifact } = useArtifactSave();

/* 产物预览/打开：产物 path 是工作区内的绝对路径（write_file 落盘后回传），
   内容读取复用「我的文件」那套预览约束（越界/体积上限都在后端拦）。 */
const wsRoot = ref('');
const artOpen = ref(false);
const artLoading = ref(false);
const artErr = ref('');
const artPreview = ref<FilePreview | null>(null);

async function loadWorkspaceRoot() {
  try {
    wsRoot.value = (await fetchFileRoots()).workspace;
  } catch {
    wsRoot.value = ''; // 拿不到也能预览 text 产物（事件里带了 content）
  }
}

async function previewArtifact(a: Artifact) {
  artOpen.value = true;
  artErr.value = '';
  if (a.kind !== 'file' || !a.path) {
    // 纯文本产物：事件里就带着全文，不用再读盘
    artPreview.value = {
      kind: 'text', name: a.name, path: a.path || '', ext: '.md', type: '文档',
      size: (a.content || '').length, mtime: 0, truncated: false, content: a.content || '',
    };
    return;
  }
  if (!wsRoot.value) await loadWorkspaceRoot();
  artLoading.value = true;
  artPreview.value = null;
  try {
    artPreview.value = await fetchFileContent(a.path, wsRoot.value);
  } catch (e) {
    artErr.value = (e as Error).message || '读取失败';
  } finally {
    artLoading.value = false;
  }
}

async function openArtifact(a: Artifact) {
  if (!a.path) {
    void previewArtifact(a); // 纯文本产物没有落盘路径，预览就是"打开"
    return;
  }
  try {
    await openFilePath(a.path);
  } catch (e) {
    notices.value.push(`打开失败：${(e as Error).message}`);
  }
}

const ui = useUiStore();
const account = useAccountStore();
const prompt = ref('');
const inputRef = ref<HTMLInputElement>();

const plusOpen = ref(false);
const modelOpen = ref(false);
const model = ref('auto'); // T-140：默认「自动选择模型」，按任务类型匹配档位

/* 任务通道：Python 后端废弃后只剩 TS 一套，所以**默认就是 TS**。
   置 true 而不是等 `getAgentChoice()` 回来再改——很多初始化动作（模型清单等）
   一上来就问"走哪条通道"，若初值 false 它们会先走后端那条已不存在的路，
   会先去撞那条已经不存在的路（旧实现里还要轮询后端健康接口等到超时）。
   只有一种情况会回落 false：纯 vite 预览、没有主进程桥，此时确实没有智能体可用。

   声明放在这里（模型区）而不是下面：模型清单按 useTs 分流，而 `onBackend(loadModels)`
   在 preload 已注入地址时会**同步**回调，那时下面那行还没执行到，直接 TDZ 报错。 */
const useTs = ref(true);

/* 输入栏下拉的开关。同一时刻只开一层：+ 菜单（及其二级面板）、模型
   都是贴着输入框往上弹的，同时开会互相盖住，窗口一矮就顶出视口。 */
function togglePlus() {
  const next = !plusOpen.value;
  closeComposerPops();
  plusOpen.value = next;
  if (next) void loadSkills();
}
function toggleModel() {
  const next = !modelOpen.value;
  closeComposerPops();
  modelOpen.value = next;
}

/* S-08 / S-12：「结束提醒」（通知/声音）读设置 KV。 */
const prefs = ref({ notify: true, sound: true, volume: 50 });

async function loadPrefs() {
  if (!bridgeAvailable()) return;
  try {
    const d = await fetchSettings();
    const tg = (d.toggles ?? {}) as Record<string, unknown>;
    if (typeof tg.notify === 'boolean') prefs.value.notify = tg.notify;
    if (typeof tg.sound === 'boolean') prefs.value.sound = tg.sound;
    if (typeof d.volume === 'number') prefs.value.volume = d.volume;
  } catch {
    /* 拿不到设置就沿用默认值：偏好读不出来不该拦住用户发任务 */
  }
}

/** 一轮跑完的提醒：横幅（需授权）+ 提示音（音量取设置滑条）。 */
function announceResult() {
  if (!['done', 'partial', 'error'].includes(phase.value)) return;
  const kind: ChimeKind = phase.value === 'error' ? 'error' : 'done';
  const label =
    phase.value === 'partial'
      ? '任务完成（部分调用失败）'
      : phase.value === 'done'
        ? '任务已完成'
        : '任务执行失败';
  if (prefs.value.sound) playChime(kind, prefs.value.volume / 100);
  if (prefs.value.notify) notifyTask('EvaWork', `${label}：${runTitle.value.slice(0, 60)}`);
}

/* 模型清单来自模型通道（eva 通道即 eva-ai 的 /api/ai/v1/models），不是本地写死的名单。
   拉不到就**显示空**并把原因摆出来——不再回退任何内置/兜底模型，不假装"有这些模型"。
   T-140：首项固定「自动选择模型」（值 auto）——后端按任务类型/上下文体量挑模型，
   触发条件与优先级见 evawork/agent.py 的 resolve_auto 注释。
   T-141：后端已把模型目录合并进清单（实测可用的百炼模型 + 定位描述 + 档位），
   这里按档位给中文标签，悬停时在面板底部显示描述。 */
const TIER_TAGS: Record<string, string> = {
  heavy: '旗舰', balanced: '均衡', fast: '快', long: '长文本', code: '代码',
};
/* T-141：能力标签中文名。后端目录（model_catalog.ABILITIES）是新集合的权威，
   这里只映射已知的；后端新增能力而前端没映射时按原样显示英文，不会崩。 */
const ABILITY_NAMES: Record<string, string> = {
  text: '文本', reasoning: '推理', code: '代码', tools: '工具调用', long_ctx: '长文本',
  image_in: '图片输入', image_gen: '生图', video_in: '视频输入', video_gen: '生视频',
  audio_in: '语音输入', audio_out: '语音合成',
  // 模型广场带来的能力（agent-ts 侧映射过来；未列出的按原文显示）
  web_search: '联网搜索', multimodal: '多模态', embedding: '向量化',
};
const THINKING_NAMES: Record<string, string> = { low: '低（low）', high: '高（high）', max: '极致（max）' };
const remoteModels = ref<ModelItem[]>([]);
const modelsError = ref('');
const modelHover = ref<{ name: string; label?: string; tag: string; desc?: string; abilities: string[]; thinking?: string; contextWindow?: number } | null>(null);
const modelCardStyle = ref<Record<string, string>>({});
/* 详情卡原先在 .pop-menu 内做绝对定位，被菜单的 overflow-y:auto 裁剪（与 .pop-sub2
   注释里同一个坑），实际只看到原生 title 提示。改成 fixed + 行矩形定位：优先放菜单
   右侧，贴窗口右缘时翻到左侧，纵向跟随悬停行；fixed 不受滚动容器裁剪。 */
function onModelHover(m: { name: string; label?: string; tag: string; desc?: string; abilities: string[]; thinking?: string; contextWindow?: number }, ev: MouseEvent) {
  modelHover.value = m;
  const el = ev.currentTarget as HTMLElement;
  const row = el.getBoundingClientRect();
  const menu = el.parentElement as HTMLElement | null;
  const mr = menu?.getBoundingClientRect();
  const CARD_W = 240, GAP = 8, CARD_H = 180;
  let left = (mr ? mr.right : row.right) + GAP;
  if (left + CARD_W > window.innerWidth - 8) left = (mr ? mr.left : row.left) - GAP - CARD_W;
  left = Math.max(8, Math.min(left, window.innerWidth - CARD_W - 8));
  const top = Math.max(8, Math.min(row.top - 6, window.innerHeight - CARD_H - 8));
  modelCardStyle.value = { left: `${left}px`, top: `${top}px` };
}
function formatContextWindow(n?: number): string {
  if (!n) return '';
  if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K`;
  return String(n);
}
const hoverMeta = computed(() => ({
  desc: modelHover.value?.desc || '',
  abilities: (modelHover.value?.abilities || []).map((a) => ABILITY_NAMES[a] || a),
  thinking: modelHover.value?.thinking ? THINKING_NAMES[modelHover.value.thinking] || modelHover.value.thinking : '',
  contextWindow: formatContextWindow(modelHover.value?.contextWindow),
}));
const modelLabel = computed(() => {
  if (model.value === 'auto') return '自动选择模型';
  const hit = remoteModels.value.find((m) => m.id === model.value);
  return hit && hit.name !== hit.id ? hit.name : model.value;
});
const modelOptions = computed<{ name: string; label?: string; ratio: string; tag: string; desc?: string; abilities: string[]; thinking?: string; contextWindow?: number; custom?: boolean }[]>(() => {
  /* 无兜底：模型通道没返回就不列表项（直接为空），只保留固定首项「自动选择模型」。 */
  const list = remoteModels.value.map((m) => ({
    name: m.id,
    label: m.name !== m.id ? m.name : '',
    ratio: '',
    tag: TIER_TAGS[m.tier ?? ''] ?? (m.custom ? '自定义' : ''),
    desc: m.desc,
    abilities: m.abilities ?? [],
    thinking: m.thinking,
    contextWindow: m.contextWindow,
    custom: m.custom === true,
  }));
  return [{ name: 'auto', label: '自动选择模型', ratio: '', tag: '按任务匹配', desc: '按任务类型自动匹配最合适的模型：分析/写作走旗舰，闲聊走快档，超长上下文换长窗口模型', abilities: ['text'], thinking: undefined, contextWindow: undefined }, ...list];
});
/** 登录态已确认且未登录 → 智能体不可用（未登录一律不发起模型请求）。 */
const loginRequired = computed(() => account.loaded && !account.loggedIn);

async function loadModels() {
  /* 后端任务通道已经移除，只剩 TS 一条：模型清单走 agent-ts（模型广场同步）。
     以前这里在两条通道间分流，非 TS 那条要先 `waitBackendReady()` 轮询
     /api/health（后端不拉起 → 白等 20s 超时）才拿到"没有模型"。
     现在如实说明，不再等一个注定不响应的地址。 */
  if (useTs.value) return loadTsModels();
  modelsError.value = '模型清单不可用：后端任务通道已移除，请在桌面版（TS 智能体）中使用';
}

/** TS 模式的模型清单：主进程 → agent-ts → 平台模型广场。
 *  source/reason 原样带出来：降级到缓存或内置表时界面要能说明"拿到的不是实时数据"。 */
async function loadTsModels(force = false) {
  try {
    const r = await fetchTsModels(force);
    const list = (r.models || []).map((m) => ({
      id: m.id,
      name: m.name,
      desc: m.desc,
      tier: m.tier,
      abilities: m.abilities || [],
      thinking: m.thinking,
      contextWindow: m.contextWindow,
      custom: m.custom === true, // S-25：用户自己加的通道
    }));
    if (list.length) {
      remoteModels.value = list;
      if (model.value !== 'auto' && !list.some((m) => m.id === model.value)) model.value = 'auto';
      modelsError.value = r.reason || '';
    } else {
      modelsError.value = r.reason || '模型广场未返回可用模型';
    }
  } catch (e) {
    modelsError.value = (e as Error).message || '模型清单获取失败';
  }
}

/* S-25：任务页里的「添加模型」（自带 Key / BYOK）。与设置→模型页同一套通道
   （主进程 userData/providers.json），只是把入口搬到模型下拉里——为了加一个自己的
   模型（如 DeepSeek）跳到设置里翻半天没必要。录完刷新清单并直接选中它。
   Key 只存本机、列表只回显后 4 位。 */
const providerFormOpen = ref(false);
const pvBusy = ref(false);
const pvMsg = ref('');
const pvTone = ref<'ok' | 'warn'>('ok');
const pvTestMsg = ref('');
const pvTestOk = ref(false);
const pvDraft = ref<ProviderDraft>({ name: '', base_url: '', model: '', api_key: '' });
/** 非空＝正在**编辑**这条通道；空＝新增。 */
const pvEditId = ref('');

/** `custom:<通道 id>` → 通道 id。不是自带通道就返回空串（调用方据此拒绝）。 */
function providerIdOf(modelId: string): string {
  return modelId.startsWith('custom:') ? modelId.slice('custom:'.length) : '';
}

function closeProviderForm() {
  providerFormOpen.value = false;
  pvEditId.value = '';
  pvDraft.value = { name: '', base_url: '', model: '', api_key: '' };
  pvTestMsg.value = '';
  pvMsg.value = '';
}

function openProviderForm() {
  closeProviderForm(); // 先清干净，免得带着上一条（或上次编辑）的残留字段
  modelOpen.value = false; // 关掉模型下拉，免得两层浮层叠在一起
  providerFormOpen.value = true;
}

/** 编辑已有通道。模型清单里只有名字和摘要（`model · base_url`），没有完整字段，
 *  所以先把整条记录取回来再填表；Key 不回显（渲染层拿不到原文），留空即"不改动"。 */
async function openProviderEdit(m: { name: string; label?: string }) {
  const id = providerIdOf(m.name);
  if (!id) return;
  try {
    const p = ((await fetchProviders()).items || []).find((x) => x.id === id);
    if (!p) {
      notices.value.push('这条通道已经不在了（可能刚被删掉）');
      await loadTsModels(true);
      return;
    }
    closeProviderForm();
    pvEditId.value = id;
    pvDraft.value = { name: p.name, base_url: p.base_url, model: p.model, api_key: '' };
    modelOpen.value = false;
    providerFormOpen.value = true;
  } catch (e) {
    notices.value.push((e as Error).message);
  }
}

async function onTestDraft() {
  if (pvBusy.value) return;
  pvBusy.value = true;
  pvTestMsg.value = '';
  try {
    /* 编辑时若没重填 Key，就拿**已存的那把**测（渲染层手里没有 Key 原文，
       用空 Key 去测只会得到一句把人带偏的 401）。 */
    const r =
      pvEditId.value && !pvDraft.value.api_key
        ? await testProvider(pvEditId.value)
        : await testProviderDraft({ ...pvDraft.value });
    pvTestOk.value = r.ok;
    pvTestMsg.value = r.ok ? r.output || '连通' : r.error || '连接失败';
  } catch (e) {
    pvTestOk.value = false;
    pvTestMsg.value = (e as Error).message;
  } finally {
    pvBusy.value = false;
  }
}

async function onSaveProvider() {
  if (pvBusy.value) return;
  if (!pvDraft.value.base_url.trim()) {
    pvTone.value = 'warn';
    pvMsg.value = '先填接口地址（OpenAI 兼容，通常以 /v1 结尾）';
    return;
  }
  if (!pvDraft.value.model.trim()) {
    pvTone.value = 'warn';
    pvMsg.value = '先填模型名（例如 deepseek-chat）';
    return;
  }
  pvBusy.value = true;
  pvMsg.value = '';
  const id = pvEditId.value;
  try {
    if (id) {
      await updateProvider(id, {
        name: pvDraft.value.name,
        base_url: pvDraft.value.base_url,
        model: pvDraft.value.model,
        api_key: pvDraft.value.api_key, // 空串＝保留原 Key（providers.update 的约定）
      });
      closeProviderForm();
      await loadTsModels(true);
      notices.value.push('已保存修改');
      return;
    }
    const r = await addProvider({ ...pvDraft.value });
    closeProviderForm();
    await loadTsModels(true); // 新通道要立刻出现在下拉里（绕过 6h 缓存）
    model.value = `custom:${r.item.id}`; // 刚加的，多半就是要用它的
    notices.value.push(`已添加「${r.item.name}」，模型已切到它`);
  } catch (e) {
    pvTone.value = 'warn';
    pvMsg.value = (e as Error).message;
  } finally {
    pvBusy.value = false;
  }
}

async function onProviderRemove(m: { name: string; label?: string }) {
  const id = providerIdOf(m.name);
  if (!id) return;
  const label = m.label || m.name;
  if (!window.confirm(`移除通道「${label}」？已保存的 Key 会一并删掉。`)) return;
  try {
    await deleteProvider(id);
    /* 选中的正是这条就先退回「自动」：不然会停在一个已经不存在、
       再发出去必然报错的模型 id 上（loadTsModels 也会兜这一下，但那要靠清单拉得到）。 */
    if (model.value === m.name) model.value = 'auto';
    await loadTsModels(true);
    closeProviderForm(); // 从弹窗里删的时候顺手把弹窗收掉（没开就是空操作）
    notices.value.push(`已移除「${label}」`);
  } catch (e) {
    notices.value.push((e as Error).message);
  }
}

// 后端地址由主进程异步注入（preload 早于地址就绪时调用会拿到空串），
// 故挂载时拉一次 + 地址就绪回调里再拉一次，与 DesignSystemView 一致。
onMounted(loadModels);
onBackend(loadModels);
onMounted(loadPrefs); // S-08/S-12：结束提醒
onBackend(loadPrefs);
// 登录态转成"已登录"后必须重新拉一次清单：上面两个时机都只在启动阶段跑，
// 若那一刻还没登录，下拉会永久停在「内置模型 + 未登录提示」，用户登录成功了它也不自愈。
watch(() => account.loggedIn, (now, before) => {
  if (now && !before) void loadModels();
});
/* 智能体选择是**异步**定下来的（onMounted 里等 getAgentChoice），所以上面那些
   loadModels 调用几乎都跑在 useTs 落定之前 —— 一律走后端那条老路。
   这里补一刀：useTs 一落定（或用户中途切换）就按新通道重拉，
   否则「切到 TS 智能体但下拉还是 Python 那份清单」会成为常态。 */
watch(useTs, (now, before) => {
  if (now !== before) void loadModels();
});

/* ---------- 任务执行（T-021 前端侧 / T-050 三态） ---------- */
/* T-073：'cancelled' 是独立终态——与 done/failed 区分开，用户得知道是自己停的。
   'partial'：跑完了，但本轮有工具调用没做成（TS 侧 failed>0）——
   不能和全绿"已完成"混为一谈，否则"三个命令全失败却显示已完成"。 */
type Phase = 'idle' | 'creating' | 'streaming' | 'error' | 'done' | 'cancelled' | 'partial';

const phase = ref<Phase>('idle');
const runState = ref('');
const runTitle = ref('');
const steps = ref<Step[]>([]);
const output = ref('');
const artifacts = ref<Artifact[]>([]);
const errMsg = ref('');
const taskId = ref('');
/** 侧栏条目的临时 id：createTask 拿到真实任务 id 后替换，点侧栏才能回显。 */
const sidebarKeyRef = ref('');

/* T-070：模型自主发起的工具调用（调用 → 结果），让"它到底做了什么"对用户可见。
   T-108：条目挂在过程时间线里渲染（顺序＝发生顺序），这里不再直接遍历 toolRuns。 */
const { resetToolRuns, pushToolCall, patchToolResult } = useToolRuns();

/* T-089：工作区文件面板（文件树 + 预览）——agent 到底动了哪些文件，要能自己看见 */
const filesOpen = ref(false);
function openWorkspaceFiles() {
  filesOpen.value = true;
  closeComposerPops();
}

/* T-071：系统提示（如"模型服务限流，正在重试同一请求"），别让后台重试在 UI 上悄无声息 */
const notices = ref<string[]>([]);
function resetNotices() {
  notices.value = [];
}

/* ---------- S-20：语音输入 ----------
   麦克风按钮此前是 data-coming。现在走服务端 ASR（eva-ai `/api/ai/asr`，凭据用已登录的 IAM token），
   桌面端不持有任何厂商密钥。**识别结果只回填输入框，不自动发送**——转写会错，必须让人先看一眼。 */
const {
  recording: voiceRecording,
  working: voiceWorking,
  error: voiceError,
  seconds: voiceSeconds,
  supported: voiceSupported,
  toggle: toggleVoice,
} = useVoiceInput((text) => {
  const cur = prompt.value.trimEnd();
  prompt.value = cur ? `${cur} ${text}` : text;
  nextTick(() => inputRef.value?.focus());
});

/* Alt+V（设置里开了「语音转录快捷键」）由主进程全局快捷键送进来：焦点在别的软件也能唤起录音 */
onShortcut((m) => {
  if (m.action === 'voice') void toggleVoice();
});

/* ---------- S-24：智能跟进推荐 ----------
   任务跑完后给出"接着可以做什么"；点一下就当追问发出去（不是摆着看的装饰）。
   生成走一次后端请求（模型），因此只在**任务真的结束**时才要，打开历史任务只读已存的。 */
const followups = ref<string[]>([]);
const followupMsg = ref('');
const followupBusy = ref(false);

async function loadFollowups(refresh: boolean) {
  if (!taskId.value) return;
  /* 智能跟进是**后端**能力（它自己调模型生成建议），TS 通道没有对应实现。
     以前这里无条件打后端，TS 任务下每次都抛错、界面挂一条"加载失败"。
     没有替代实现就别假装——直接不显示，而不是显示一个永远失败的区块。 */
  if (isTsTaskId(taskId.value)) {
    followups.value = [];
    followupMsg.value = '';
    return;
  }
  followupBusy.value = true;
  followupMsg.value = '';
  try {
    const st = refresh ? await fetchFollowup(taskId.value, true) : await fetchFollowup(taskId.value);
    followups.value = st.items ?? [];
    // 关掉开关 / 未登录 / 离线演示：后端都给了成句原因，照实显示（静默失败最伤人）
    followupMsg.value = st.ok === false ? st.reason || '' : '';
  } catch (e) {
    followups.value = [];
    followupMsg.value = (e as Error).message || '跟进推荐加载失败';
  } finally {
    followupBusy.value = false;
  }
}

/** 点一条建议 = 把它当下一句提问发出去（走正常的追问链路，仍追在同一个任务上）。 */
function askFollowup(text: string) {
  if (!text || busy.value) return;
  prompt.value = text;
  void submit();
}

async function regenFollowups() {
  if (!taskId.value || followupBusy.value) return;
  await loadFollowups(true);
}

/* ---------- T-092：改动与撤销 ---------- */

/* T-072：已消费到的最大事件 rev，断线续跑时用它补发缺失的帧 */
const lastRev = ref(0);

/* 正文分段：token 先进 streamBuf；模型发起工具调用 → 这段是过程叙述（沉进执行过程区），
   回合结束 → 这段是最终答案（进 output 正文）。历史回放走同一份 applyEvent，天然一致。 */
const streamBuf = ref('');

/* T-108：执行过程时间线。以前「叙述」和「工具」是两个平行数组，渲染时先铺完所有叙述
   再列所有工具——顺序信息丢了，看起来像"先想一堆、再干一堆"，对不上每次调用是为哪句话发的。
   现在按事件到达顺序交错存放：工具紧跟自己那段说明之后，读到的就是当时的思考轨迹。 */
type ProcItem = { kind: 'narration'; text: string } | { kind: 'tool'; run: ToolRun };
const timeline = ref<ProcItem[]>([]);

/** 把 streamBuf 里攒着的文本沉成一条过程叙述（换步/发起工具/收尾轮之前调用） */
function sinkNarration() {
  const text = streamBuf.value.trim();
  streamBuf.value = '';
  if (text) timeline.value.push({ kind: 'narration', text });
}

function commitStreamAsAnswer() {
  if (streamBuf.value.trim()) output.value = streamBuf.value.trim();
  streamBuf.value = '';
}

/* EvaWork 式对话流：开始任务后页面从"居中表单"切成"聊天视图"——
   用户消息右对齐气泡，回答区带「执行过程」折叠；回合结束后沉入 history，可继续发下一条。 */
interface Turn {
  user: string;
  title: string;
  output: string;
  /** T-108：过程时间线（叙述与工具按发生顺序交错）——不进正文，折叠在执行过程里 */
  timeline: ProcItem[];
  steps: Step[];
  artifacts: Artifact[];
  phase: string;
  errMsg: string;
  skill: string;
  processOpen: boolean;
}
const history = ref<Turn[]>([]);
const curUser = ref('');
/* T-106：执行期间**默认展开**——用户要能实时看到步骤与工具在跑；正常跑完自动折回（见 done 分支）。
   以前是默认折叠，过程虽然一直在推送、一直在增长，但用户看到的只有「执行过程（46）」一行。 */
const processOpen = ref(true);
const threadEnd = ref<HTMLElement>();

function snapshotTurn(): Turn {
  return {
    user: curUser.value,
    title: runTitle.value,
    output: output.value,
    // 深拷一份：历史回合不能被下一回合的后续推送改到（工具结果回填是就地 Object.assign）
    timeline: timeline.value.map<ProcItem>((it) =>
      it.kind === 'tool' ? { kind: 'tool', run: { ...it.run } } : { ...it },
    ),
    // T-112：数组也各拿一份。回放会逐段复用同一批响应式 refs，不拷贝的话
    // 历史回合的步骤/产物会跟着下一段一起变（"切回来发现每轮都长一样"）。
    steps: [...steps.value],
    artifacts: [...artifacts.value],
    phase: phase.value,
    errMsg: errMsg.value,
    skill: skillName.value,
    processOpen: false,
  };
}

/* 流式输出时把最新内容保持在视线内（滚到会话底部） */
watch([output, streamBuf, () => timeline.value.length, () => steps.value.length], () => {
  nextTick(() => threadEnd.value?.scrollIntoView({ block: 'end' }));
});

/* T-076：本次任务加载的技能 + 本地已加载技能清单（供 + 菜单唤起）
   技能不再内联铺在 + 菜单里：装几十个技能包后那张单子能有多高，直接顶穿屏幕（用户截图），
   技能名还会被挤成两三行。现在一级只留「技能 (N)」一行，清单进二级面板 + 搜索框。 */
const skillName = ref('');
const skillTools = ref<string[]>([]);
const loadedSkills = ref<LoadedSkill[]>([]);
const skillsRoot = ref('');
const skillPanel = ref(false);
/* 截图选项二级面板：目前只有「隐藏窗口截图」一个开关。设置项不摊在一级面板里——
   一级要留给"点一下就做"的动作，混进设置项既占地方又容易点错（用户反馈）。 */
const shotPanel = ref(false);
const skillQ = ref('');
const skillFiltered = computed(() => {
  const kw = skillQ.value.trim().toLowerCase();
  if (!kw) return loadedSkills.value;
  return loadedSkills.value.filter(
    (s) => s.name.toLowerCase().includes(kw) || (s.description || '').toLowerCase().includes(kw),
  );
});
async function loadSkills() {
  if (!bridgeAvailable()) return;
  try {
    const r = await fetchInstalledSkills();
    loadedSkills.value = r.items || [];
    skillsRoot.value = r.root || '';
  } catch {
    loadedSkills.value = []; // 拿不到就是没有，不假装
  }
}
void loadSkills();
function toggleSkillPanel() {
  skillPanel.value = !skillPanel.value;
  pluginPanel.value = false;
  shotPanel.value = false;
  hoverPluginName.value = '';
  if (skillPanel.value) {
    skillQ.value = '';
    void loadSkills(); // 面板开着就保证是最新清单（技能可能刚装上）
    nextTick(() => document.querySelector<HTMLInputElement>('.ps-search input')?.focus());
  }
}
function useSkill(name: string) {
  prompt.value = `/${name} `;
  closeComposerPops();
  nextTick(() => inputRef.value?.focus());
}

/* T-142：+ 菜单「插件」——已装插件与真实工具清单。
   工具由后端 MCP 子系统（T-031）在需要时拉起服务并 tools/list 得到；
   这里的价值是让用户看见"带了什么"，点工具名即把全名 mcp:<sid>:<tool> 填进输入框。 */
const installedPlugins = ref<InstalledPlugin[]>([]);
const pluginPanel = ref(false);
const hoverPluginName = ref(''); // 悬停/选中的插件——第三级面板显示它的工具
const pluginTools = ref<Record<string, string[]>>({});
const pluginToolsError = ref<Record<string, string>>({}); // 握手失败的真实原因（别只甩一句「没有发现工具」）
const pluginToolsLoading = ref('');
let hideTimer: ReturnType<typeof setTimeout> | null = null;
async function loadInstalledPlugins() {
  if (!bridgeAvailable()) return;
  try {
    const rows = await fetchInstalledPlugins();
    // 只展示启用的：停用的服务不参与会话，列出来等于撒谎
    installedPlugins.value = Object.values(rows).filter((r) => r.enabled !== false);
  } catch {
    installedPlugins.value = []; // 拿不到就是没有，不假装
  }
}
function togglePluginPanel() {
  pluginPanel.value = !pluginPanel.value;
  skillPanel.value = false; // 三个二级面板互斥：同开两层会把主菜单挤到视口外
  shotPanel.value = false;
  if (pluginPanel.value) {
    hoverPluginName.value = '';
    void loadInstalledPlugins();
  }
}
/** 截图选项面板（点截图行右侧的小箭头才开）。点行本身是"立刻截图"，所以设置项单独一层。
    位置跟第三级工具面板同一套：fixed + 行矩形定位，**顶边对齐「截图」行**。
    不能用 .pop-sub 的 bottom 对齐——一级菜单是底部锚定的，行越靠上、面板离得越远
    （截图行在第二行，面板会被甩到菜单最底下去，用户截图）。 */
const shotPanelStyle = ref<Record<string, string>>({});
function toggleShotPanel(ev?: MouseEvent) {
  shotPanel.value = !shotPanel.value;
  skillPanel.value = false;
  pluginPanel.value = false;
  hoverPluginName.value = '';
  if (!shotPanel.value) return;
  // 事件源是行内的小箭头，要往上取到整行，才能按行的顶边与右缘定位
  const host = ev?.currentTarget as HTMLElement | null;
  const row = host?.closest<HTMLElement>('.pop-item');
  if (!row) return;
  const r = row.getBoundingClientRect();
  // 面板很矮（一行开关 + 说明），贴着行顶往下放；行太靠下时整体上移，保证不出视口
  const top = Math.max(8, Math.min(r.top - 6, window.innerHeight - 150));
  // 行有 6px 内边距，再留 8px 间隙 → 面板距一级菜单右缘 8px（与改动前观感一致）
  shotPanelStyle.value = { top: `${top}px`, left: `${r.right + 14}px` };
}
/** 悬停插件行：切换第三级面板内容（工具清单懒加载，带缓存），并把面板对齐到该行正右侧 */
const sub2Style = ref<Record<string, string>>({});
function hoverPlugin(p: InstalledPlugin, ev?: MouseEvent) {
  cancelHide();
  hoverPluginName.value = p.name;
  if (ev?.currentTarget) {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    // 顶部对齐悬停行；行太靠下时整体上移，保证面板(≤340px)不出视口
    const top = Math.max(8, Math.min(r.top - 6, window.innerHeight - 356));
    sub2Style.value = { top: `${top}px`, left: `${r.right + 8}px` };
  }
  void loadPluginTools(p);
}
async function loadPluginTools(p: InstalledPlugin) {
  // 有结果就复用；空结果允许重试（首次握手常因服务正在下载/启动而失败）
  if (pluginTools.value[p.name]?.length || pluginToolsLoading.value === p.name) return;
  pluginToolsLoading.value = p.name;
  try {
    const r = await fetchPluginTools(p.name);
    pluginToolsError.value[p.name] = r.error || '';
    // discover 返回短名，注册表里是 mcp:<sid>:<tool> 全名；填进输入框必须用全名，
    // 否则与内置工具重名（如 Filesystem 的 read_file）会被解析到内置版本
    pluginTools.value[p.name] = (r.tools || []).map((t) =>
      t.name.startsWith('mcp:') ? t.name : `mcp:${p.server_id}:${t.name}`,
    );
  } catch (e) {
    pluginToolsError.value[p.name] = (e as Error).message || '加载失败';
    pluginTools.value[p.name] = [];
  } finally {
    pluginToolsLoading.value = '';
  }
}
/** 鼠标在插件面板与工具面板之间要走 8px 间隙，直接 mouseleave 会误收——延迟兜底 */
function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hoverPluginName.value = '';
    hideTimer = null;
  }, 160);
}
function cancelHide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}
/** 点击插件行 = 固定显示该插件工具（与悬停一致，习惯点击的用户也有落点） */
function openPluginTools(p: InstalledPlugin, ev?: MouseEvent) {
  hoverPlugin(p, ev);
}
function usePluginTool(full: string) {
  prompt.value = `用工具 ${full} `;
  closeComposerPops();
  nextTick(() => inputRef.value?.focus());
}

/* ---------- 输入框附件（+ 菜单「添加文件 / 截图」） ----------
   附件由后端复制进工作区 `.evawork/attachments/`（files.attach），这里只管三件事：
   选料 / 摆 chip / 发消息时按相对路径写进正文。 */
interface AttachChip extends Attachment {
  /** 图片缩略图（data URL）；读不到就空着，chip 退回文件图标 */
  preview?: string;
}
const attachments = ref<AttachChip[]>([]);
const attachBusy = ref(false);
const attachMsg = ref('');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/* 「隐藏窗口截图」：开着的話截图前先把本窗口藏起来，免得每张图里都糊着一个 EvaWork
   （截别人窗口内容时尤其明显）。偏好存 localStorage，跟侧栏折叠/主题一个待遇，下次打开还在。 */
const HIDE_WIN_KEY = 'evawork.hideWindowShot';
const hideWindowShot = ref(typeof localStorage !== 'undefined' && localStorage.getItem(HIDE_WIN_KEY) === '1');
watch(hideWindowShot, (v) => {
  try {
    localStorage.setItem(HIDE_WIN_KEY, v ? '1' : '0');
  } catch {
    /* 隐私模式下写不了就算了，本次会话内的选择照样生效 */
  }
});

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function attachIcon(ext: string): string {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (['.xlsx', '.xls', '.csv'].includes(ext)) return 'table';
  if (['.pptx', '.ppt', '.key'].includes(ext)) return 'slides';
  if (['.mp4', '.mov', '.webm'].includes(ext)) return 'video';
  return 'doc';
}

/** 收料 → 落地 → 摆 chip。挑中的文件被后端拒了要逐个说清，不能只弹一句"失败"。 */
async function ingest(paths: string[]) {
  if (!paths.length || attachBusy.value) return;
  attachBusy.value = true;
  attachMsg.value = '';
  try {
    const r = await attachPaths(paths);
    attachments.value = [...attachments.value, ...r.items];
    if (!wsRoot.value) await loadWorkspaceRoot();
    await Promise.all(
      r.items
        .filter((it) => IMAGE_EXT.has(it.ext))
        .map(async (it) => {
          const chip = attachments.value.find((c) => c.rel === it.rel);
          if (chip) chip.preview = await attachmentPreview(it.rel, wsRoot.value).catch(() => '');
        }),
    );
    if (r.errors?.length) attachMsg.value = `有 ${r.errors.length} 个文件没进来：${r.errors.join('；')}`;
  } catch (e) {
    attachMsg.value = (e as Error).message || '附件添加失败';
  } finally {
    attachBusy.value = false;
  }
}
async function addFiles() {
  closeComposerPops();
  try {
    await ingest(await pickFiles());
  } catch (e) {
    attachMsg.value = (e as Error).message || '附件添加失败';
  }
}
async function addScreenshot() {
  closeComposerPops();
  attachMsg.value = '';
  try {
    const shot = await captureScreen(hideWindowShot.value);
    // 用户在截图工具里点了「取消」或按 Esc：返回空串，这是正常路径，别报错误
    if (shot) await ingest([shot]);
    else attachMsg.value = '已取消截图';
  } catch (e) {
    attachMsg.value = (e as Error).message || '截图失败';
  }
}
async function dropAttachment(a: AttachChip) {
  attachments.value = attachments.value.filter((c) => c.rel !== a.rel);
  try {
    await removeAttachment(a.rel);
  } catch {
    /* 删不掉就留在磁盘上：界面已经不再引用它，不必为此打扰用户 */
  }
}

/** 发消息时把附件写进正文——AI 只能看到文字，得明确告诉它文件在哪、怎么读。
    放进正文而不是只摆 chip，是因为消息不持久化，回放靠事件日志：
    清单不进正文，回看这一轮就只剩一句"看看这个"，等于附件凭空消失。 */
function withAttachments(text: string): string {
  if (!attachments.value.length) return text;
  const lines = attachments.value.map(
    (a) => `- \`${a.rel}\`（${a.type || '文件'}${a.ext ? ` ${a.ext}` : ''}，${fmtSize(a.bytes)}）`,
  );
  return `${text}\n\n【随这条消息附加的文件，已复制到工作区；按上面的相对路径用 read_file / read_image 读取】\n${lines.join('\n')}`;
}

/* ---------- 浮层收摊 ---------- */
function closeComposerPops() {
  plusOpen.value = false;
  skillPanel.value = false;
  pluginPanel.value = false;
  shotPanel.value = false;
  hoverPluginName.value = '';
  modelOpen.value = false;
  skillQ.value = '';
}
/** 点菜单外面 / 按 Esc 都要能收摊：以前只能再点一次按钮，菜单一开就把整屏盖住。 */
function onDocPointer(e: PointerEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest?.('.composer-bar')) return; // 菜单与二级面板都在 .composer-bar 里（连 fixed 的那层也是）
  closeComposerPops();
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape' || e.key === 'Esc') closeComposerPops();
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer);
  document.addEventListener('keydown', onDocKey);
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocPointer);
  document.removeEventListener('keydown', onDocKey);
});

const busy = computed(() => phase.value === 'creating' || phase.value === 'streaming');
/** 正在回放落盘事件日志（打开历史任务）。**它不是在执行**——以前这里没区分：
 *  徽章写着"流式执行中"、过程区把上百步又走一遍、发送键还变成停止键，
 *  看起来就像"一打开历史任务就开始自动执行"（实测就是这么被报上来的）。 */
const replaying = ref(false);
function phaseLabelOf(p: string): string {
  return (
    {
      idle: '未开始',
      creating: '创建任务中',
      streaming: '流式执行中',
      error: '出错',
      done: '已完成',
      partial: '完成（有失败）',
      cancelled: '已中断',
    } as Record<string, string>
  )[p] ?? p;
}
/* 回放期间徽章说实话：读历史 ≠ 在跑。 */
const phaseLabel = computed(() => (replaying.value ? '读取历史中' : phaseLabelOf(phase.value)));

function resetRun() {
  phase.value = 'idle';
  processOpen.value = true; // T-106：新回合从「展开」开始，过程实时可见
  runState.value = '';
  steps.value = [];
  output.value = '';
  streamBuf.value = '';
  timeline.value = [];
  artifacts.value = [];
  resetToolRuns();
  resetNotices();
  followups.value = []; // S-24：上一回合的建议不该挂在新回合尾巴上
  followupMsg.value = '';
  lastRev.value = 0;
  stopping.value = false;
  skillName.value = '';
  skillTools.value = [];
  errMsg.value = '';
  taskId.value = '';
  hitLimit.value = false;
  usage.value = null;
  usageOpen.value = false;
  artOpen.value = false;
}

/* ---------- 历史任务回显（/task/:id） ---------- */
/* 对话正文只落在后端事件日志里（messages 不持久化），回放 /events 是唯一可靠的回显来源：
   任务详情拿标题与状态，事件帧重放出步骤/工具/正文/产物，等价于"断线重连补帧"的 since=0 特例。 */
const route = useRoute();
const router = useRouter();

/** T-112：把事件流按"轮"切开。
 *
 * 后端每轮开头必然先发 `status(planning)` 再发 `plan`（`plan` 是前端认定的轮次边界），
 * resume 续跑时可能没有 planning 帧、但一定有 plan。所以：
 *   段内已经见过 plan，又碰到 planning/plan → 这是下一轮的开头。
 * 首段的 planning + 规划叙述因此不会被切碎（它们本来就属于第一轮）。
 */
function splitEventTurns(items: StreamEvent[]): StreamEvent[][] {
  const segs: StreamEvent[][] = [];
  let cur: StreamEvent[] = [];
  let sawPlan = false;
  for (const ev of items) {
    const boundary = ev.type === 'plan' || (ev.type === 'status' && ev.state === 'planning');
    if (boundary && sawPlan) {
      segs.push(cur);
      cur = [];
      sawPlan = false;
    }
    if (ev.type === 'plan') sawPlan = true;
    cur.push(ev);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

async function openTask(id: string) {
  if (busy.value) return;
  resetRun();
  history.value = [];
  // T-131：TS 会话有自己的事件日志（落盘 JSONL），走回放重建——
  // 不是"不能回看"，只是不能拿它去查后端库。
  if (isTsTaskId(id)) {
    await openTsSession(id);
    return;
  }
  try {
    const t = await fetchTask(id);
    taskId.value = id;
    // T-101/T-112：回显靠两个数据源互补——
    //   messages：对话本身（user 问了什么、助手答了什么）；老任务/被清过的任务可能缺轮；
    //   events  ：执行过程（步骤/工具/叙述/产物），按轮切段后每一轮都能完整重建。
    // 以前把事件"一把"apply 完：plan 会清掉上一轮，最后只剩最后一轮——前面几轮全靠
    // messages 撑着，而 messages 里没有过程与产物，回看多轮任务时历史回合是空壳。
    // 现在按段重建：事件段够（≥ 消息轮）就全以事件为准，过程与产物一起回来；
    // 消息轮更多（前几轮没留下事件）时，多出来那部分仍由 messages 撑住，一轮都不丢。
    const msgTurns: Turn[] = [];
    for (const m of t.messages || []) {
      if (m.role === 'user') {
        msgTurns.push({
          user: m.content,
          title: t.title,
          output: '',
          timeline: [],
          steps: [],
          artifacts: [],
          phase: 'done',
          errMsg: '',
          skill: '',
          processOpen: false,
        });
      } else if (m.role === 'assistant' && msgTurns.length) {
        msgTurns[msgTurns.length - 1].output = m.content;
      }
    }
    const { items } = await fetchTaskEvents(id);
    const segs = splitEventTurns(items);
    const headCount = Math.max(0, msgTurns.length - segs.length); // 没有事件可重建的前几轮
    const settlePhase =
      t.state === 'failed' || t.state === 'error' // T-138：error = 崩在这一趟的某一环，同样是失败
        ? 'error'
        : t.state === 'cancelled'
          ? 'cancelled'
          : 'done';
    const rebuilt: Turn[] = [];
    segs.forEach((seg, i) => {
      curUser.value = msgTurns[headCount + i]?.user || t.title;
      for (const ev of seg) applyEvent(ev);
      rebuilt.push({ ...snapshotTurn(), phase: settlePhase, processOpen: false });
    });
    const all = [...msgTurns.slice(0, headCount), ...rebuilt];
    const last = all.pop();
    history.value = all;
    curUser.value = last?.user || t.title;
    runTitle.value = t.title;
    // S-24：历史任务只读已存的建议（不为一个"回看"动作再花一次模型调用）
    if (!['pending', 'planning', 'running'].includes(t.state)) void loadFollowups(false);
    if (['pending', 'planning', 'running'].includes(t.state)) {
      // 任务还活着：重放既有帧后接实时流，接着看它跑完
      phase.value = 'streaming';
      for await (const ev of streamTask(id, false, lastRev.value)) applyEvent(ev);
      if (!['error', 'cancelled'].includes(phase.value)) phase.value = 'done';
      // 上一行已经保证这里不会是 error/cancelled，条件留着是死分支（TS 也判出来了）
      hitLimit.value = false;
      errMsg.value = '';
    } else {
      phase.value =
        t.state === 'failed' || t.state === 'error' // T-138
          ? 'error'
          : t.state === 'cancelled'
            ? 'cancelled'
            : 'done';
      // 终态只要不是失败，就不要保留历史回放里的"达到轮次上限"提示
      if (!['failed', 'error'].includes(t.state)) {
        hitLimit.value = false;
        errMsg.value = '';
      }
    }
  } catch (e) {
    phase.value = 'error';
    errMsg.value = (e as Error).message || '任务详情加载失败';
    if (!curUser.value) curUser.value = '历史任务';
  }
}

function syncRouteView() {
  if (route.name === 'task-detail' && typeof route.params.id === 'string') {
    void openTask(route.params.id);
  } else if (route.name === 'new-task') {
    resetToNew();
  }
}

/**
 * T-131：回放一个 TS 会话（从事件日志重建各轮对话与执行过程）。
 *
 * 与 Python 侧 openTask 的分段重建同一套节奏：每轮 `curUser → 事件段 →
 * snapshotTurn 入 history`，最后一轮留在实时区（可从那里直接追问）。
 * 回放完 taskId 就绑定了——追问走 runTs(sessionId)，上下文不断。
 */
async function openTsSession(id: string) {
  taskId.value = id;
  phase.value = 'streaming';
  replaying.value = true;
  const rebuilt: Turn[] = [];
  try {
    for await (const ev of replayTsTask(tsSessionOf(id))) {
      if (ev.type === 'ts_turn') {
        if (rebuilt.length === 0 && curUser.value) {
          // 首轮之前不该有未提交的内容；有的话说明事件序异常，沉进历史别丢
          rebuilt.push({ ...snapshotTurn(), phase: 'done', processOpen: false });
        }
        curUser.value = ev.user || '（无正文）';
        continue;
      }
      applyEvent(ev as StreamEvent);
      if (['done', 'cancelled', 'error'].includes(ev.type)) {
        // 一轮结束：沉入历史，给下一轮腾出实时区（终态徽章以每轮自己的为准）
        rebuilt.push({ ...snapshotTurn(), processOpen: false });
      }
    }
    if (curUser.value && !rebuilt.length) {
      rebuilt.push({ ...snapshotTurn(), processOpen: false });
    }
  } catch (e) {
    phase.value = 'error';
    errMsg.value = (e as Error).message || '回放失败';
    if (!curUser.value) curUser.value = 'TS 会话';
    return;
  } finally {
    replaying.value = false;
  }
  const last = rebuilt.pop();
  history.value = rebuilt;
  if (last) {
    curUser.value = last.user;
    output.value = last.output;
    timeline.value = last.timeline;
    steps.value = last.steps;
    artifacts.value = last.artifacts;
    phase.value = (['done', 'partial', 'error', 'cancelled'].includes(last.phase) ? last.phase : 'done') as Phase;
    processOpen.value = false;
  } else {
    phase.value = 'done';
  }
  /* TS-065：回放没有 usage 帧（它不落盘），所以回放完主动查一次——旧会话也要能看到用量 */
  void refreshUsage();
}
onMounted(() => {
  syncRouteView();
  void loadWorkspaceRoot();
  // TS-052：通道由「智能体」设置决定。桥不在（浏览器直连开发）就只能是 Python，
  // 这是**能力的边界**，不是失败——不要在这里弹错误。
  void (async () => {
    const c = await getAgentChoice().catch(() => ({ agent: 'py' as const, running: false }));
    useTs.value = c.agent === 'ts' && tsAgentAvailable();
  })();
});
watch(
  () => [route.name, route.params.id] as const,
  () => syncRouteView(),
);

/** 回到新建态：清空聊天流并把光标还给用户。该任务随时可从侧栏再打开。 */
function resetToNew() {
  if (busy.value) {
    // 任务还在跑：留着现场，别把正在流的输出抹掉——但不吭声会被当成按钮坏了
    notices.value.push('当前任务还在执行中，先停止或等它跑完，再开新会话');
    return;
  }
  resetRun();
  history.value = [];
  curUser.value = '';
  // T-102：彻底离开旧会话。taskId / lastRev 不清的话，下一句提问会被误判成
  // "会话内追问"而追加到上一个任务上——用户明明点了"新建任务"。
  taskId.value = '';
  lastRev.value = 0;
  skillName.value = '';
  runTitle.value = '';
  errMsg.value = '';
  nextTick(() => inputRef.value?.focus());
}

/* 侧栏「新建任务」可能在同一个 `/` 上重复点击（不产生导航），靠这个信号让页面自己收摊：
   否则用户会觉得按钮点不动，得先切到别的页再切回来。 */
watch(newTaskSeq, () => {
  if (route.name !== 'new-task') return; // 其它页面交给路由变化处理，避免重复清空
  resetToNew();
});

async function submit() {
  const raw = prompt.value.trim();
  /* 允许"只发附件、不写正文"。但既然附件是正文里一行清单，正文至少得有东西，
     否则后端收到的 user 消息是空的，模型无从下手——这里兜底成「附件任务」。 */
  if ((!raw && !attachments.value.length) || busy.value) return;
  /* 附件清单进正文（withAttachments）。它进的是「发给模型的正文」也是用户气泡：
     消息不持久化、回放靠事件日志，清单不落文字就等于附件凭空消失。
     侧栏/标题用用户自己写的那句（或"附件任务"），别让文件清单变成任务名。 */
  const text = withAttachments(raw);
  const title = raw || '附件任务';
  // T-102：会话即任务。已经在某个任务的聊天流里 → 追问直接追到同一个任务上，
  // 侧栏不新增、不换绑（"每问一句裂出一条"的问题从根上没有了）；
  // 只有在新建态发出的第一条提问才建任务、才记进侧栏。
  //
  // T-112：**先把任务 id 存下来**。下面 resetRun() 会把 taskId 清空，而追问要用的
  // 恰恰是它——以前在 runFollowUp 内部读 taskId.value，读到的是空串，
  // 请求打到 /api/tasks//messages → 404，追问必然失败；失败后 taskId 仍是空的，
  // 用户再点一次提交就落进"新建任务（把 history 当上下文带上）"的分支：
  // 第二轮回的对话因此变成**另一条任务**，原任务永远停在第一轮——
  // 「切走再回来只剩一轮对话」就是这么来的（事件的 plan 帧数对不上 user 轮数，
  // 就是这批"假追问"任务留下的指纹）。
  const sessionId = taskId.value;
  const inSession = !!sessionId && phase.value !== 'idle';
  /* TS 会话不进后端库，侧栏条目就只有这一次机会带上工作区——
     不传就落进垫底的「默认」组，用户会以为没记上。 */
  if (!inSession) sidebarKeyRef.value = ui.addTask(title, undefined, useTs.value ? wsRoot.value : undefined);
  prompt.value = '';
  attachments.value = []; // 已并入正文（含相对路径），chip 清掉；文件仍留在工作区 .evawork/attachments
  nextTick(() => inputRef.value?.focus());
  // 上一回合已结束 → 沉入历史：页面保持聊天流，而不是被清空
  if (phase.value !== 'idle') history.value.push(snapshotTurn());

  /* 后端任务通道已经移除，能跑任务的只有 TS 一条（主进程桥 + 子进程，不碰 HTTP 后端）。
     此前无条件判"后端地址在不在"，打包态连 TS 任务都发不出去，报的还是"未连接后端"。
     现在按真正的前置条件判断：没桥就是没有智能体可用；有桥而选了别的通道，
     那是通道选错了——两种原因分开说，用户才知道该干什么。 */
  if (!useTs.value) {
    // 保持诚实：记录到侧栏，但不假装执行
    curUser.value = text;
    runTitle.value = title;
    phase.value = 'error';
    errMsg.value = bridgeAvailable()
      ? '当前选择的不是 TS 智能体：后端任务通道已移除，请在设置里切到 TS 智能体'
      : '当前环境没有主进程桥（可能是浏览器直连预览），智能体不可用；任务已记录在侧栏，未真正执行';
    return;
  }
  // 别把"还没读到登录态"当成"未登录"——没读过就先读一次
  if (!account.loaded) await account.load();
  if (!account.loggedIn) {
    curUser.value = text;
    runTitle.value = title;
    phase.value = 'error';
    errMsg.value = '请先登录 EVA 账号：智能体走你的账号调用模型，未登录不会发起任何模型请求';
    return;
  }
  resetRun();
  curUser.value = text;
  // T-076：`/name 参数` 唤起技能——把技能名与正文分开，正文才是任务标题。
  // 用 raw（用户原文）而不是 text：text 末尾可能挂了附件清单，标题不该带上。
  const invoked = parseSkillInvocation(raw);
  skillName.value = invoked?.name ?? '';
  // 给模型的任务正文去掉 `/name` 前缀（技能正文由后端注入，不占用户输入）
  const body = invoked ? invoked.args || invoked.name : raw;
  runTitle.value = body || title;
  if (inSession) {
    // T-112：把任务绑回去。resetRun() 刚清过 taskId，后续的撤销 / 回滚点 / 续跑
    // 都靠它定位任务；留着空值，追问失败后的"重试"会滑进新建任务的分支。
    taskId.value = sessionId;
    void runFollowUp(body, invoked?.name ?? '');
  } else void runOnce(body, false, invoked?.name ?? '');
}

/** T-102：同一任务上再跑一轮（追问）——不新建任务，事件接在上一轮之后。
 *  历史不用前端传：它一直在同一个 task.messages 里，模型上下文天然连续。 */
async function runFollowUp(title: string, skill = '') {
  // T-112：这道闸门本该碰不到（submit 已把 taskId 绑回原任务）。留着是为了让
  // 万一的路径失败得**说得清楚**：以前 taskId 为空时会打出 "后端返回 404"，
  // 用户和排查的人都只能猜；追问失败的真实原因只可能是"会话脱离了任务"。
  if (!taskId.value) {
    phase.value = 'error';
    errMsg.value = '当前会话没有关联任务，无法追问；请从侧栏重新打开该任务';
    return;
  }
  if (useTs.value) {
    void runTs(title, tsSessionOf(taskId.value));
    return;
  }
  try {
    phase.value = 'creating';
    await appendTaskMessage(taskId.value, title, skill);
    phase.value = 'streaming';
    // since=lastRev：只要这一轮新产出的帧，上一轮的帧不再重放一遍
    for await (const ev of streamTask(taskId.value, false, lastRev.value)) {
      applyEvent(ev);
    }
    // T-073/T-095：中断是终态，不能被这里覆盖成"已完成"
    if (!['error', 'cancelled', 'partial'].includes(phase.value)) phase.value = 'done';
    announceResult(); // S-12
    void loadFollowups(true); // S-24：跑完才要建议（没跑完的答复随时会变）
  } catch (e) {
    phase.value = 'error';
    errMsg.value = (e as Error).message || '执行失败';
    announceResult();
  }
}

/** T-076：解析 `/name 参数`（技能名只允许字母数字与 . _ -）。 */
function parseSkillInvocation(text: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z0-9._-]+)[ \t]*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1], args: m[2].trim() };
}

async function runOnce(title: string, resume: boolean, skill = '') {
  if (useTs.value) {
    // 追问走 runFollowUp（带会话 id）；新建/重跑在这里（resume 对 TS 没意义：它按会话续）
    void runTs(title, resume ? tsSessionOf(taskId.value) : '');
    return;
  }
  try {
    if (!resume) {
      phase.value = 'creating';
      // T-102 保险：凡是新建任务，一律把当前聊天流的历轮对话带上。
      // 正常路径下追问走 runFollowUp（后端任务自带历史），但只要哪条路径
      // 意外落到 createTask，上下文也必须跟着会话走——模型不许对刚才的
      // 问答一无所知。assistant 正文截 8000 字，更长的交给后端压缩。
      const prior = history.value.flatMap((t) => {
        const arr: { role: string; content: string }[] = [{ role: 'user', content: t.user }];
        if (t.output) arr.push({ role: 'assistant', content: t.output.slice(0, 8000) });
        return arr;
      });
      const t = await createTask({
        title,
        mode: ui.mode,
        model: model.value,
        skill,
        ...(prior.length ? { messages: [...prior, { role: 'user', content: title }] } : {}),
      });
      taskId.value = t.id;
      if (sidebarKeyRef.value) {
        ui.renameTask(sidebarKeyRef.value, t.id);
        sidebarKeyRef.value = '';
      }
      // 任务一落地就把 URL 换成 /task/{id}：侧栏高亮随之落到这条会话上，
      // 「新建任务」不再是当前页——否则停在同一路由，下次点它等于点空气（得先绕到别的页再回来）。
      // 此刻 phase=creating → busy 为真，syncRouteView 不会把同一个任务重复打开一遍。
      if (route.name !== 'task-detail' || route.params.id !== t.id) {
        await router.replace({ name: 'task-detail', params: { id: t.id } });
      }
    }
    phase.value = 'streaming';
    // T-072：续跑带上已看到的最大 rev，后端先补发缺失的帧再接实时流
    for await (const ev of streamTask(taskId.value, resume, resume ? lastRev.value : 0)) {
      applyEvent(ev);
    }
    // TS 无法感知 applyEvent 对 phase 的副作用，需显式放宽类型再判断
    // T-073：中断是终态——后端已结束流，
    // 不能被这里覆盖成"已完成"（界面显示已完成、实际已中断，自相矛盾）
    if (!['error', 'cancelled', 'partial'].includes(phase.value)) phase.value = 'done';
    announceResult(); // S-12
    void loadFollowups(true); // S-24
  } catch (e) {
    phase.value = 'error';
    errMsg.value = (e as Error).message || '执行失败';
    announceResult();
  }
}

/**
 * TS 智能体跑一轮（TS-052 收尾）。
 *
 * 事件形状与后端 SSE 一致，所以下面这段与 `runOnce` 是同一套消费逻辑——
 * 换数据源，不换界面。`sessionId` 为空就是新开会话；带上则是追问（同一上下文）。
 */
async function runTs(text: string, sessionId = '') {
  try {
    /* 发任务前把档位对齐到主进程。必须在**开跑之前**：档位一变主进程要重启子进程，
       那时这次会话还不存在，重启没有代价；等跑到一半再发现档位不对就晚了。
       （主进程 prompt 里也有一层兜底对齐，但那会让当前 sessionId 失效、追问丢上下文。） */
    // TS 模式没有"创建任务"这个阶段（prompt 即执行）——挂 creating 会把
    // "创建任务中"这个徽章从开头挂到结束，用户以为卡死了。
    phase.value = 'streaming';
    for await (const ev of streamTsTask(
      {
        sessionId: sessionId || undefined,
        prompt: text,
        workspace: wsRoot.value || undefined,
        /* 用户选的模型必须逐轮传下去（`auto` 交给子进程的降级链裁决）。
           之前这里不传，界面上换了模型、实际跑的还是启动参数里那一个。 */
        model: model.value === 'auto' ? undefined : model.value,
      },
      (sid) => {
        // 拿到真实会话 id 才绑：追问要发回同一个会话，不然每问一次换一个上下文
        if (!taskId.value) {
          taskId.value = tsTaskId(sid);
          if (sidebarKeyRef.value) {
            ui.renameTask(sidebarKeyRef.value, taskId.value);
            sidebarKeyRef.value = '';
          }
        }
      },
    )) {
      applyEvent(ev);
    }
    if (!['error', 'cancelled', 'partial'].includes(phase.value)) phase.value = 'done';
    /* TS-065：终局按落盘日志对一次账——流里的 usage 帧是过程值，收尾重算，免得面板停在半路的数字 */
    void refreshUsage();
    announceResult();
  } catch (e) {
    phase.value = 'error';
    errMsg.value = (e as Error).message || 'TS 智能体执行失败';
    announceResult();
  }
}

/* T-073：停止 = 请求后端协作式取消（不是关闭 SSE）——关流只会让前端看不见，任务还在跑 */
const stopping = ref(false);
async function stop() {
  if (!taskId.value || stopping.value) return;
  stopping.value = true;
  try {
    if (useTs.value) await cancelTsAgentFor(taskId.value);
    else await cancelTask(taskId.value);
  } catch (e) {
    errMsg.value = `停止失败：${(e as Error).message}`;
  }
  // 后端会在下一个安全边界停下并推送 cancelled 帧；这里只负责表达"正在停"
}

function applyEvent(ev: StreamEvent) {
  if (typeof ev.rev === 'number') lastRev.value = ev.rev; // T-072：记住断点
  switch (ev.type) {
    case 'status':
      runState.value = ev.state;
      break;
    case 'plan':
      // 计划前的 token 是规划叙述（"我来拆解一下…"）——同样不算答案
      sinkNarration();
      // T-102：plan = 新一轮的边界。回放多轮任务时，上一轮的步骤/工具/叙述
      // 会先被重放一遍，若不清掉就全堆在本轮的过程区里（看起来像这一轮跑了三遍）。
      // 实时流里 plan 也只在每轮开头出现，清的是空壳，安全。
      steps.value = ev.steps;
      resetToolRuns();
      timeline.value = []; // T-108：时间线一起清（叙述与工具都属于"这一轮"）
      output.value = '';
      // T-112：产物同样属于"这一轮"。不清的话，回放多轮任务时第一轮的产物会
      // 一直堆在最后一轮下面（实时追问有 resetRun 兜着，回放没有）。
      artifacts.value = [];
      break;
    case 'replan':
      // T-087：一步失败后重规划——新步骤接在后面；失败的那一步留在列表里（不假装它没发生过）
      steps.value = [...steps.value, ...(ev.steps || [])];
      break;
    case 'skill':
      // T-076：技能被真实加载了——显示名字与它拿到的工具，别让"技能"是个黑箱
      skillName.value = ev.name;
      skillTools.value = ev.tools || [];
      break;
    case 'step': {
      // T-103：步骤开始 = 上一段的输出到此为止。多步轮次里每步的 token
      // 都往同一个 streamBuf 攒，没有边界冲刷的话 done 时会把三步的输出
      // 连成一串（实测答案变成"123456123456123456"）。步骤一启动，
      // 把攒着的内容沉进执行过程区，回复区只留给最后一步的正文。
      if (ev.step.status === 'running') sinkNarration();
      const i = steps.value.findIndex((s) => s.id === ev.step.id);
      if (i >= 0) steps.value[i] = ev.step;
      else steps.value.push(ev.step);
      break;
    }
    case 'token':
      // 先攒着：这段到底是"工具间的叙述"还是"最终答案"，要等本轮结束才知道
      streamBuf.value += ev.content ?? '';
      break;
    case 'narration':
      // T-105：后端补"收尾轮"前的边界帧——攒着的这段是"让我查看…"执行预告，沉进过程区
      sinkNarration();
      break;
    case 'answer_restart':
      // T-138：上一趟终答只吐了一半就崩了 → 那半截作废（重连补帧会把它带回来），
      // 重问的正文从这里重新攒。与 narration 不同：它不是"过程叙述"，不该沉进过程区
      // 变成一条半截答案；原因照样说在过程区里，别让"为什么又答一遍"是个哑谜。
      streamBuf.value = '';
      if (ev.message) notices.value.push(ev.message);
      break;
    case 'notice':
      // T-109：引擎侧说明（如某步失败后跳过继续）——进执行过程区的系统提示，不影响结论
      notices.value.push(ev.message);
      break;
    case 'retry':
      notices.value.push(ev.message);
      break;
    case 'degrade':
      // T-091：换通道/换模型继续——把"走了哪条备用路由"说出来，别让降级是个黑箱
      notices.value.push(ev.message);
      break;
    case 'tool_call': {
      // 模型发起了工具 → 刚才那段文本是过程叙述（"让我查看…"），沉进执行过程区，
      // 正文只留给最终答案——否则满屏碎片叙述，真正的东西反而被淹没
      sinkNarration();
      // T-108：工具紧跟它前面那段说明入时间线（重复的调用不重复入线）
      const run = pushToolCall(ev.call);
      if (run) timeline.value.push({ kind: 'tool', run });
      break;
    }
    case 'tool_result': {
      // T-108：结果早于调用到达（续跑）时会补一条，补的那条也得进时间线
      const added = patchToolResult(ev.result);
      if (added) timeline.value.push({ kind: 'tool', run: added });
      break;
    }
    case 'artifact':
      artifacts.value.push(ev.artifact);
      break;
    case 'done':
      commitStreamAsAnswer();
      // partial：本轮有工具调用没做成——徽章与说明都要如实，不能显示全绿"已完成"
      if (ev.task.state === 'partial') {
        runState.value = 'partial';
        phase.value = 'partial';
      }
      // T-131：**不许**用 done 帧里的 task.steps / task.artifacts 回填——它们是**跨轮累计**
      // 的任务级列表（追问后 done 帧带着第一轮的产物与步骤一起回来），回填后
      // snapshotTurn 把上一轮的产物复制进本轮（实测：问 Docker 的回合挂着
      // 「分析报告1005.md」、执行过程显示 7 步）。本轮的步骤/产物由本轮的
      // plan/step/replan/artifact 帧喂齐，done 帧只取状态。
      runState.value = ev.task.state;
      // T-106：答案已经交付，过程折回折叠态让位给正文。出错/中断时**不折**——
      // 那些情况下过程就是排查线索，藏起来只会让人干瞪眼。
      processOpen.value = false;
      break;
    case 'error':
      commitStreamAsAnswer(); // 出错前已流出的内容如实保留
      errMsg.value = ev.message;
      phase.value = 'error';
      break;
    case 'cancelled':
      // T-073：已产出的正文/产物/步骤都留着，只是标记"到这里被停了"
      // T-131：步骤/产物同样**不回填任务级列表**（理由见 done 分支）——
      // 本轮跑到被停为止已经由各帧喂齐了。
      commitStreamAsAnswer();
      runState.value = ev.task.state;
      phase.value = 'cancelled';
      stopping.value = false;
      break;
    case 'limit':
      // 达到轮次上限：已产出的内容如实保留，标记为 error 态但给"继续"（复用会话、新预算接着跑）
      commitStreamAsAnswer();
      errMsg.value = ev.message;
      hitLimit.value = true;
      phase.value = 'error';
      break;
    case 'usage':
      // TS-065：上下文用量。**纯展示**——不动正文、不改 phase，只喂输入框下方那条监控
      usage.value = ev.usage;
      break;
  }
}

function retry() {
  errMsg.value = '';
  void runOnce(runTitle.value, Boolean(taskId.value));
}

/* 达到轮次上限（max_steps）：后端发来 limit 帧——内容都还在上下文里，给用户"继续"而非"重试"。 */
const hitLimit = ref(false);

/* TS-065：上下文用量监控。窗口与分类明细都来自 agent-ts（**token 是估算值**），
   输入框下方那条监控、以及点开的面板，读的都是这一份。 */
const usage = ref<ContextUsage | null>(null);
const usageOpen = ref(false);
/* 百分比口径（面板里可切）。为什么要有两种：窗口调到 256K 后，典型任务只用到 3~4%，
   "占窗口"全是零点几——看不出**内部构成**；切到"占已用"才看得出是谁吃掉的。 */
const usageBasis = ref<'window' | 'used'>('window');

/** 模型选择按钮旁的圆环图标颜色：低绿 / 中黄 / 高红。 */
const ctxRingColor = computed(() => {
  const p = usage.value?.percent ?? 0;
  if (p >= 80) return '#ef4444';
  if (p >= 50) return '#f59e0b';
  return '#22c55e';
});

/** token 数折成 "69.7K" / "1.2M" 这种短标记（面板里的数字要能一眼读出来）。 */
function fmtTokens(n: number): string {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
/**
 * 某分类的百分比。**分母可切**：
 * - `window` 占窗口 —— 回答"还能塞多少"；
 * - `used` 占已用量 —— 回答"被什么吃掉的"。
 *
 * 分段条**永远用 window**：它要反映的是"窗口用了多少"，得和顶部那个百分比对得上。
 */
function pctOf(tokens: number, basis: 'window' | 'used' = 'window'): number {
  const u = usage.value;
  if (!u) return 0;
  const den = basis === 'used' ? u.usedTokens : u.windowTokens;
  if (!den) return 0;
  return Math.max(0, Math.min(100, (tokens / den) * 100));
}
/** 分类配色：分段条与图例圆点共用一份，按 id 取（分类顺序不固定）。 */
function partColor(id: string): string {
  const map: Record<string, string> = {
    system: '#6366f1',
    tools: '#10b981',
    conversation: '#f59e0b',
    mcp: '#a855f7',
    skills: '#ec4899',
  };
  return map[id] || '#94a3b8';
}
/** 拉一次用量（跑完 / 回放完对账用）：流里的 usage 帧是过程值，终局按落盘日志重算一次，
 *  保证"跑完看到的数字"与"下次打开这个会话看到的数字"是同一个。 */
async function refreshUsage(): Promise<void> {
  const sid = taskId.value && isTsTaskId(taskId.value) ? tsSessionOf(taskId.value) : '';
  if (!sid) return;
  try {
    const r = await tsAgentContextUsage(sid);
    if (r.ok && r.usage) usage.value = r.usage;
  } catch {
    /* 用量是**锦上添花**：拉不到就不显示，绝不因此打断任务或弹错 */
  }
}

/** 未登录时直接在结果区拉起浏览器 SSO，登录成功就接着跑刚才那条任务。 */
async function loginAndRun() {
  const ok = await account.login();
  if (!ok || !runTitle.value) return;
  errMsg.value = '';
  void runOnce(runTitle.value, Boolean(taskId.value));
}
</script>

<template>
  <div class="page new-task">
    <!-- T-053 a11y：页面级 h1（视觉隐藏），满足 page-has-heading-one -->
    <h1 class="sr-only">新建任务</h1>

    <!-- 输出区（上）：任务执行面板与建议。
         输入框一律放底部（见下方 .dock）——视觉顺序＝DOM 顺序，键盘与读屏也按"先结果、后输入"走。 -->
    <div class="thread">

    <!-- 对话流（EvaWork 式两态：新任务=居中表单，开始后=聊天视图）：用户消息右对齐，
         回答区带「执行过程」折叠（计划步骤 + 工具调用），回合结束沉入历史可继续追问。 -->
    <template v-if="phase !== 'idle' || history.length">

      <!-- 历史回合 -->
      <template v-for="(t, i) in history" :key="'h' + i">
        <div class="msg-user">
          <div class="msg-bubble">{{ t.user }}</div>
        </div>
        <div class="msg-ai">
          <div class="ai-head">
            <span class="ai-logo"><UIcon name="sparkle" :size="13" /></span>
            <span class="ai-name">EvaWork</span>
            <span class="run-badge" :class="t.phase">{{ phaseLabelOf(t.phase) }}</span>
            <span v-if="t.skill" class="skill-chip" :title="'本次带技能：' + t.skill"><UIcon name="sparkle" :size="11" /> {{ t.skill }}</span>
          </div>
          <button v-if="t.steps.length || t.timeline.length" class="think" @click="t.processOpen = !t.processOpen">
            执行过程（{{ t.steps.length + t.timeline.length }}）
            <UIcon :name="t.processOpen ? 'chevron-down' : 'chevron-right'" :size="11" />
          </button>
          <div v-if="t.processOpen" class="process">
            <ol v-if="t.steps.length" class="run-steps">
              <li v-for="s in t.steps" :key="s.id" class="run-step" :class="s.status">
                <span class="dot" />
                <span class="st">{{ s.title }}</span>
                <span class="sd">{{ STEP_LABEL[s.status] }}</span>
              </li>
            </ol>
            <!-- T-108：叙述与工具按发生顺序交错——工具紧跟自己那段说明之后 -->
            <template v-for="(it, i) in t.timeline" :key="'ht' + i">
              <p v-if="it.kind === 'narration'" class="nar-line">{{ it.text }}</p>
              <div v-else-if="it.kind === 'tool'" class="rt-item" :class="it.run.status">
                <button class="rt-h" :aria-expanded="it.run.open" @click="it.run.open = !it.run.open">
                  <UIcon name="zap" :size="12" />
                  <span class="rt-n">{{ it.run.name }}</span>
                  <span class="rt-a">{{ it.run.args }}</span>
                  <span class="rt-s">{{ it.run.status === 'running' ? '执行中' : it.run.status === 'ok' ? '成功' : '失败' }}</span>
                  <span v-if="it.run.elapsed != null" class="rt-ms">{{ it.run.elapsed }}ms</span>
                  <UIcon name="chevron-down" :size="11" />
                </button>
                <pre v-if="it.run.open" class="rt-o">{{ it.run.output || it.run.error || '（暂无输出）' }}</pre>
                <!-- T-089：写文件的调用把"改了什么"摊开给人看（行级 diff） -->
                <DiffView
                  v-if="it.run.open && it.run.diff"
                  :name="it.run.diff.path"
                  :before="it.run.diff.before"
                  :after="it.run.diff.after"
                />
                <!-- T-090：派出去的子任务干了什么（模型手里有摘要，人这边得看得见轨迹） -->
                <div v-if="it.run.open && it.run.subagent" class="sub-trace">
                  <span class="sub-head">
                    子代理 · {{ it.run.subagent.rounds }} 轮
                    <template v-if="it.run.subagent.elapsed_ms"> · {{ it.run.subagent.elapsed_ms }}ms</template>
                  </span>
                  <div v-for="(c, ci) in it.run.subagent.calls" :key="ci" class="sub-row">
                    <span class="sub-dot" :class="c.ok ? 'ok' : 'no'" />
                    <span class="sub-tool">{{ c.tool }}</span>
                    <span class="sub-out">{{ c.head }}</span>
                  </div>
                  <p v-if="!it.run.subagent.calls.length" class="sub-out">（子代理未调用工具）</p>
                </div>
              </div>
            </template>
          </div>
          <MarkdownView v-if="t.output" class="ai-out" :source="t.output" :breaks="true" />
          <div v-if="t.artifacts.length" class="run-arts">
            <div class="ra-t">产物（{{ t.artifacts.length }}）</div>
            <div v-for="a in t.artifacts" :key="a.id" class="ra-item">
              <UIcon name="book" :size="12" />
              <button class="ra-n ra-link" :title="'预览 ' + a.name" @click="previewArtifact(a)">{{ a.name }}</button>
              <button v-if="a.path" class="ra-save" title="用系统默认程序打开" @click="openArtifact(a)">打开</button>
              <button
                class="ra-save" :disabled="savingArtifact === a.id"
                title="把这份产物写进「我的文件」"
                @click="saveArtifact(a)"
              >{{ savingArtifact === a.id ? '保存中…' : '保存到我的文件' }}</button>
            </div>
            <p v-if="artMsg" class="ra-msg">{{ artMsg }}</p>
          </div>
          <div v-if="t.phase === 'error'" class="run-err"><span class="er-msg">{{ t.errMsg }}</span></div>
        </div>
      </template>

      <!-- 当前回合 -->
      <template v-if="phase !== 'idle'">
        <div class="msg-user"><div class="msg-bubble">{{ curUser }}</div></div>
        <div class="msg-ai">
          <div class="ai-head">
            <span class="ai-logo"><UIcon name="sparkle" :size="13" /></span>
            <span class="ai-name">EvaWork</span>
            <span class="run-badge" :class="phase">{{ phaseLabel }}</span>
            <!-- T-076：本次带技能跑——名字与它拿到的工具都摆出来 -->
            <span v-if="skillName" class="skill-chip" :title="skillTools.length ? '该技能可用工具：' + skillTools.join('、') : '该技能未声明工具（可用全部）'">
              <UIcon name="sparkle" :size="11" /> {{ skillName }}
            </span>
          </div>

          <!-- T-073：中断说明——说清"停在哪、丢了什么没丢什么" -->
          <p v-if="phase === 'cancelled'" class="run-note">已中断：已产出的正文与产物都保留（步骤标记「已中断」）。</p>
          <!-- partial：跑完了但有失败——不说清，用户会对着全绿状态怀疑答案为什么不符 -->
          <p v-if="phase === 'partial'" class="run-note">本轮有工具调用未成功（见执行过程中标红的步骤），结果可能不完整——可追问重试失败的部分。</p>

          <!-- 加载态：尚未拿到步骤。回放历史说的是"读日志"，不是"在规划"——
               打开历史任务 ≠ 在执行，文案含糊就会看着像自动重跑。 -->
          <div v-if="replaying && !steps.length && !output && !streamBuf" class="run-hint">
            <span class="spin" /> 正在读取历史记录…
          </div>
          <div v-else-if="busy && !steps.length && !output && !streamBuf" class="run-hint">
            <span class="spin" /> 正在规划执行步骤…
          </div>

          <!-- 执行过程（T-106）：执行期间默认展开——实时看计划步骤 / 过程叙述 / 系统提示 / 工具调用；
               正常跑完后自动折回，把版面让给正文。 -->
          <button v-if="steps.length || timeline.length" class="think" @click="processOpen = !processOpen">
            执行过程（{{ steps.length + timeline.length }}）
            <UIcon :name="processOpen ? 'chevron-down' : 'chevron-right'" :size="11" />
          </button>
          <div v-if="processOpen" class="process">
            <ol v-if="steps.length" class="run-steps">
              <li v-for="s in steps" :key="s.id" class="run-step" :class="s.status">
                <span class="dot" />
                <span class="st">{{ s.title }}</span>
                <span class="sd">{{ STEP_LABEL[s.status] }}</span>
              </li>
            </ol>

            <!-- T-108：模型的过程叙述与它发起的工具按发生顺序交错——工具紧跟自己那段说明
                 之后，不再是"先铺完所有叙述、再列所有工具"（那样看不出谁为谁而调）。 -->
            <template v-for="(it, i) in timeline" :key="'t' + i">
              <p v-if="it.kind === 'narration'" class="nar-line">{{ it.text }}</p>
              <div v-else-if="it.kind === 'tool'" class="rt-item" :class="it.run.status">
                <button class="rt-h" :aria-expanded="it.run.open" @click="it.run.open = !it.run.open">
                  <UIcon name="zap" :size="12" />
                  <span class="rt-n">{{ it.run.name }}</span>
                  <span class="rt-a">{{ it.run.args }}</span>
                  <span class="rt-s">{{ it.run.status === 'running' ? '执行中' : it.run.status === 'ok' ? '成功' : '失败' }}</span>
                  <!-- T-074：耗时与执行模式——并发的多个工具耗时会重叠，一眼能看出来 -->
                  <span v-if="it.run.elapsed != null" class="rt-ms" :title="it.run.mode === 'exclusive' ? '独占执行（不与其他工具并发）' : '并发执行'">{{ it.run.elapsed }}ms</span>
                  <UIcon name="chevron-down" :size="11" />
                </button>
                <pre v-if="it.run.open" class="rt-o">{{ it.run.output || it.run.error || '（暂无输出）' }}</pre>
                <!-- T-089：diff 审阅——改了哪几行，一眼看得出（原文超大时后端已截断） -->
                <DiffView
                  v-if="it.run.open && it.run.diff"
                  :name="it.run.diff.path"
                  :before="it.run.diff.before"
                  :after="it.run.diff.after"
                />
                <!-- T-090：子代理轨迹 -->
                <div v-if="it.run.open && it.run.subagent" class="sub-trace">
                  <span class="sub-head">
                    子代理 · {{ it.run.subagent.rounds }} 轮
                    <template v-if="it.run.subagent.elapsed_ms"> · {{ it.run.subagent.elapsed_ms }}ms</template>
                  </span>
                  <div v-for="(c, ci) in it.run.subagent.calls" :key="ci" class="sub-row">
                    <span class="sub-dot" :class="c.ok ? 'ok' : 'no'" />
                    <span class="sub-tool">{{ c.tool }}</span>
                    <span class="sub-out">{{ c.head }}</span>
                  </div>
                  <p v-if="!it.run.subagent.calls.length" class="sub-out">（子代理未调用工具）</p>
                </div>
              </div>
            </template>

            <!-- T-071：系统提示（重试/降级等）——不是模型的过程，统一附在时间线之后 -->
            <p v-for="(n, i) in notices" :key="'n' + i" class="run-note">{{ n }}</p>
          </div>

          <!-- 流式正文（Markdown / Mermaid / 代码高亮；流式期间节流重排）。
               正文只承载最终答案与当前正在流出的片段——过程叙述都在上面的执行过程里。 -->
          <MarkdownView v-if="busy && streamBuf" class="ai-out" :source="streamBuf" :streaming="true" :breaks="true" />
          <MarkdownView v-else-if="output" class="ai-out" :source="output" :streaming="false" :breaks="true" />

          <!-- 产物（可回写到「我的文件」，T-035；点击文件名预览，可再用系统程序打开） -->
          <div v-if="artifacts.length" class="run-arts">
            <div class="ra-t">产物（{{ artifacts.length }}）</div>
            <div v-for="a in artifacts" :key="a.id" class="ra-item">
              <UIcon name="book" :size="12" />
              <button class="ra-n ra-link" :title="'预览 ' + a.name" @click="previewArtifact(a)">{{ a.name }}</button>
              <button
                v-if="a.path" class="ra-save"
                title="用系统默认程序打开"
                @click="openArtifact(a)"
              >打开</button>
              <button
                class="ra-save" :disabled="savingArtifact === a.id"
                title="把这份产物写进「我的文件」"
                @click="saveArtifact(a)"
              >{{ savingArtifact === a.id ? '保存中…' : '保存到我的文件' }}</button>
            </div>
            <p v-if="artMsg" class="ra-msg">{{ artMsg }}</p>
          </div>

          

          <!-- S-24：智能跟进推荐——点一下就当追问发出去（不是摆着看的装饰）。
               没建议时不留空卡；后端给了原因就照实显示（关了开关 / 未登录 / 离线演示）。 -->
          <div v-if="followups.length || followupMsg || followupBusy" class="run-fu">
            <div class="fu-t">
              接下来可以做
              <button class="fu-re" :disabled="followupBusy" title="重新生成一批建议" @click="regenFollowups">
                <UIcon name="sparkle" :size="11" /> {{ followupBusy ? '生成中…' : '换一批' }}
              </button>
            </div>
            <button
              v-for="(f, i) in followups" :key="i"
              class="fu-chip" :title="'点一下就发出去：' + f"
              @click="askFollowup(f)"
            >
              <UIcon name="arrow-up" :size="12" /> {{ f }}
            </button>
            <p v-if="followupMsg" class="fu-msg">{{ followupMsg }}</p>
            <p v-if="!followups.length && !followupMsg && followupBusy" class="fu-msg">正在生成建议…</p>
          </div>

          <!-- 错误 + 重试 / 继续 -->
          <div v-if="phase === 'error'" class="run-err">
            <span class="er-msg">{{ errMsg }}</span>
            <template v-if="!account.loggedIn">
              <button class="ap-btn primary" :disabled="account.busy" @click="loginAndRun">
                {{ account.busy ? '登录中…' : '登录 EVA 账号' }}
              </button>
            </template>
            <!-- 达到轮次上限：内容都还在上下文里，给用户"继续"而不是从头"重试" -->
            <template v-else-if="hitLimit">
              <p class="run-note">已达轮次上限：已读 / 已写的内容都保留在上下文里。</p>
            </template>
            <template v-else>
              <button class="ap-btn primary" @click="retry">重试</button>
            </template>
          </div>
        </div>
      </template>

      <div ref="threadEnd" />
    </template>

    <!-- Work 模式快捷 chips + 建议（仅空态显示；开始对话后由聊天流接管页面） -->
    <template v-if="phase === 'idle' && !history.length">
      <div class="chips-row">
        <button v-for="c in quickChips" :key="c" class="quick-chip" @click="prompt = c"><UIcon name="sparkle" :size="12" /> {{ c }}</button>
        <UIcon name="chevron-right" :size="14" class="more-arr" />
      </div>

      <div class="sug-list">
        <div v-for="s in taskSuggestions" :key="s.text" class="sug-row card" @click="prompt = s.text">
          <span class="sug-ic" style="background:#efedff; color:#5b57d9"><UIcon :name="s.icon" :size="13" /></span>
          <span class="sug-text">{{ s.text }}</span>
          <span class="sug-badge" style="background:var(--ok-bg); color:var(--ok)"><UIcon name="book" :size="11" /> 全能音频视频笔记</span>
          <button class="icon-btn sug-go" aria-label="使用此建议"><UIcon name="arrow-up" :size="13" /></button>
        </div>
      </div>
    </template>
    </div>

    <!-- 输入区（下）：吸底固定——输出很长滚起来时，输入框不该跑出视线 -->
    <div class="dock">
      <div class="composer card" :class="{ running: busy }">
        <input
          ref="inputRef"
          v-model="prompt"
          class="composer-input"
          :placeholder="'帮你整理论文综述、编写 PPT、分析 Excel 等日常工作，输出专业级工作成果。'"
          @keydown.enter="submit"
        />

        <!-- 附件 chips：选/截的文件在发送前显示在这里，可删除；发送时按相对路径写进正文 -->
        <div v-if="attachments.length || attachMsg" class="attach-row">
          <div v-for="a in attachments" :key="a.rel" class="att-chip" :title="a.rel">
            <img v-if="a.preview" :src="a.preview" class="att-thumb" alt="" />
            <UIcon v-else :name="attachIcon(a.ext)" :size="13" />
            <span class="att-name">{{ a.name }}</span>
            <span class="att-size">{{ fmtSize(a.bytes) }}</span>
            <button class="att-x" aria-label="移除附件" @click="dropAttachment(a)"><UIcon name="x" :size="11" /></button>
          </div>
          <span v-if="attachMsg" class="attach-msg">{{ attachMsg }}</span>
        </div>

        <div class="composer-bar">
          <!-- + 菜单 -->
          <div class="pop-wrap">
            <button class="bar-btn" aria-label="添加内容" :title="'添加内容（文件 / 截图 / 技能 / 插件）'" @click="togglePlus">
              <UIcon :name="plusOpen ? 'x' : 'plus'" :size="15" />
            </button>
            <!-- 一级：只放功能入口。技能/插件这类清单进二级面板（搜索 + 滚动），
                 避免技能装几十个后内联铺一长条、名字被挤成多行、列表顶穿屏幕 -->
            <div v-if="plusOpen" class="pop-menu plus-menu" @click.stop>
              <div class="pop-item" :class="{ disabled: attachBusy }" @click="addFiles">
                <UIcon name="paperclip" :size="14" /><div><b>添加文件</b><small>从本机选择，复制进工作区</small></div>
              </div>
              <!-- 截图是"点一下就做"的动作，设置项（隐藏窗口截图）收进右侧二级面板，
                   所以这一行是分流的：点行 = 立刻截图，点右侧小箭头 = 开截图选项 -->
              <div class="pop-item" :class="{ disabled: attachBusy, active: shotPanel }" @click="addScreenshot">
                <UIcon name="camera" :size="14" /><div><b>截图</b><small>框选区域 · Esc 或右键取消</small></div>
                <button class="sub-toggle" aria-label="截图选项" title="截图选项" @click.stop="toggleShotPanel($event)">
                  <UIcon name="chevron-right" :size="13" class="sub-arrow" :class="{ open: shotPanel }" />
                </button>
              </div>
              <div class="pop-sep">技能与工具</div>
              <div class="pop-item" :class="{ active: skillPanel }" :title="loadedSkills.length ? '已加载技能，搜索并插入' : '尚未加载技能'" @click="toggleSkillPanel">
                <UIcon name="sparkle" :size="14" /><div><b>技能</b><small>{{ loadedSkills.length }} 个已加载 · 搜索</small></div>
                <UIcon name="chevron-right" :size="11" class="sub-arrow" :class="{ open: skillPanel }" />
              </div>
              <div class="pop-item" :class="{ active: pluginPanel }" :title="installedPlugins.length ? '已装插件及其工具' : '尚未安装插件'" @click="togglePluginPanel">
                <UIcon name="bag" :size="14" /><div><b>插件</b><small>{{ installedPlugins.length }} 个已装</small></div>
                <UIcon name="chevron-right" :size="11" class="sub-arrow" :class="{ open: pluginPanel }" />
              </div>
              <div class="pop-sep">工作区</div>
              <!-- T-089：打开工作区文件树（只读审阅，看它动了哪些文件） -->
              <div class="pop-item" title="查看 agent 工作区里的文件" @click="openWorkspaceFiles">
                <UIcon name="folder" :size="14" /> 当前项目的文件 <UIcon name="chevron-right" :size="11" class="sub-arrow" />
              </div>
              <div class="pop-item" data-coming aria-disabled="true" title="功能开发中，敬请期待"><UIcon name="box" :size="14" /> 我的产物 <UIcon name="chevron-right" :size="11" class="sub-arrow" /></div>
            </div>

            <!-- 截图选项二级面板：目前只有「隐藏窗口截图」。放二级是因为一级面板要留给
                 "点一下就做"的动作，设置项混在里面既占地方又容易误点（用户反馈）。 -->
            <div v-if="shotPanel" class="pop-sub2 shot-panel" :style="shotPanelStyle" @click.stop>
              <div class="ps-head"><span class="ps-title">截图选项</span></div>
              <div class="pop-item" title="截图前先隐藏本窗口，避免把 EvaWork 自己拍进图里" @click="hideWindowShot = !hideWindowShot">
                <span class="pop-check" :class="{ on: hideWindowShot }"><UIcon v-if="hideWindowShot" name="check" :size="11" /></span>
                <div><b>隐藏窗口截图</b><small>{{ hideWindowShot ? '已开启：截图时不带本窗口' : '关闭：会连同窗口一起截' }}</small></div>
              </div>
              <div class="pop-hint">开着它截图时，EvaWork 会先把自己藏起来再截，图里就不会带上这个窗口。</div>
            </div>

            <!-- 技能二级面板：搜索框 + 可滚动列表 + 计数。pop-sub 与 pop-menu 同级，
                 所以不进 pop-menu 那个滚动容器，搜索框能固定顶、列表自己滚 -->
            <div v-if="skillPanel" class="pop-sub skill-panel" @click.stop>
              <div class="ps-head">
                <span class="ps-title">技能</span>
                <span class="ps-count">{{ skillFiltered.length }}/{{ loadedSkills.length }}</span>
              </div>
              <div class="ps-search"><UIcon name="search" :size="12" /><input v-model="skillQ" placeholder="搜索技能" /></div>
              <div v-if="!skillFiltered.length" class="pop-empty ps-none">
                没有匹配的技能。<br />把 SKILL.md 放进 <code>{{ skillsRoot || '~/.evawork/skills/' }}</code>
              </div>
              <div v-else class="ps-list">
                <button v-for="sk in skillFiltered" :key="sk.name" class="ps-row" :title="sk.description || sk.body" @click="useSkill(sk.name)">
                  <span class="ps-row-main">
                    <b class="pp-name">/{{ sk.name }}</b>
                    <small class="pp-spec">{{ sk.description || '（无描述）' }}</small>
                  </span>
                </button>
              </div>
            </div>

            <!-- T-142：插件二级面板（已装插件清单；悬停某插件 → 第三级工具面板） -->
            <div v-if="pluginPanel" class="pop-sub" @click.stop @mouseenter="cancelHide" @mouseleave="scheduleHide">
              <div class="ps-head">
                <span class="ps-title">已装插件</span>
                <span class="ps-count">{{ installedPlugins.length }}</span>
              </div>
              <div v-if="!installedPlugins.length" class="pop-empty">
                暂无已装插件。<br />到「插件市场」安装后，工具即可在对话中直接调用。
              </div>
              <div v-for="p in installedPlugins" :key="p.name" class="pop-plugin">
                <div
                  class="pop-item ps-row"
                  :class="{ active: hoverPluginName === p.name }"
                  :title="p.spec"
                  @mouseenter="hoverPlugin(p, $event)"
                  @click="openPluginTools(p, $event)"
                >
                  <UIcon name="bag" :size="13" />
                  <span class="ps-row-main">
                    <b class="pp-name">{{ p.name }}</b>
                    <small class="pp-spec">{{ p.spec }}</small>
                  </span>
                  <UIcon name="chevron-right" :size="12" class="ps-go" />
                </div>
              </div>
            </div>

            <!-- 第三级：悬停某插件 → 右侧工具面板（fixed + 行矩形定位，不受 pop-sub 滚动裁剪） -->
            <div v-if="hoverPluginName" class="pop-sub2" :style="sub2Style" @mouseenter="cancelHide" @mouseleave="scheduleHide">
              <div class="ps-head">
                <span class="ps-row-main">
                  <b class="pp-name">{{ hoverPluginName }}</b>
                  <small class="pp-spec">
                    {{ pluginToolsLoading === hoverPluginName
                      ? '载入中…'
                      : `${pluginTools[hoverPluginName]?.length ?? 0} 个工具 · 点击插入输入框` }}
                  </small>
                </span>
              </div>
              <div v-if="pluginToolsLoading !== hoverPluginName && !pluginTools[hoverPluginName]?.length" class="pop-empty ps-none">
                没有发现工具。<br />服务可能未启动或握手失败。
                <!-- T-031：把后端握手失败的真实原因带出来，否则用户只能看到一句笼统文案 -->
                <div
                  v-if="pluginToolsError[hoverPluginName]"
                  class="pp-spec"
                  style="margin-top: 6px; white-space: normal; word-break: break-all"
                >{{ pluginToolsError[hoverPluginName] }}</div>
              </div>
              <div v-else class="pop-tools">
                <button v-for="tn in pluginTools[hoverPluginName] || []" :key="tn" class="pop-tool" :title="tn" @click="usePluginTool(tn)">
                  {{ tn.split(':').pop() }}
                </button>
              </div>
            </div>
          </div>

          <!-- 插件快捷图标 -->
          <div class="plugin-dots">
            <span class="pd" style="background:#5b57d9"><UIcon name="video" :size="10" /></span>
            <span class="pd" style="background:#0cb277"><UIcon name="image" :size="10" /></span>
            <span class="pd" style="background:#4d80f0"><UIcon name="book" :size="10" /></span>
          </div>

          <div class="spacer" />

          <!-- 模型选择 -->
          <div class="pop-wrap model-group">
            <!-- TS-065：上下文用量圆环，点击展开用量面板 -->
            <button
              v-if="usage"
              class="bar-btn ctx-ring-btn"
              :title="`上下文用量 ${usage.percent.toFixed(1)}% · ${fmtTokens(usage.usedTokens)}/${fmtTokens(usage.windowTokens)} token`"
              @click="usageOpen = !usageOpen"
            >
              <svg class="ctx-ring" viewBox="0 0 36 36">
                <path class="ctx-ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                <path
                  class="ctx-ring-bar"
                  :stroke-dasharray="`${usage.percent}, 100`"
                  :style="{ stroke: ctxRingColor }"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />
              </svg>
            </button>

            <!-- 上下文用量详情面板：从模型选择区上方弹出 -->
            <div v-if="usageOpen && usage" class="ctx-panel">
              <div class="ctx-head">
                <span class="ctx-title">上下文用量</span>
                <div class="ctx-head-r">
                  <button class="ctx-basis" :class="{ on: usageBasis === 'window' }" @click="usageBasis = 'window'">占窗口</button>
                  <button class="ctx-basis" :class="{ on: usageBasis === 'used' }" @click="usageBasis = 'used'">占已用</button>
                  <button class="ctx-x" aria-label="关闭" @click="usageOpen = false"><UIcon name="x" :size="12" /></button>
                </div>
              </div>
              <div class="ctx-big">
                <b>{{ usage.percent.toFixed(1) }}%</b>
                <span>已使用 {{ fmtTokens(usage.usedTokens) }}/{{ fmtTokens(usage.windowTokens) }}</span>
              </div>
              <div class="ctx-bar">
                <i v-for="p in usage.parts" :key="p.id" :style="{ width: pctOf(p.tokens) + '%', background: partColor(p.id) }" />
              </div>
              <ul class="ctx-list">
                <li v-for="p in usage.parts" :key="p.id">
                  <i class="ctx-dot" :style="{ background: partColor(p.id) }" />
                  <span class="ctx-k">{{ p.label }}</span>
                  <span class="ctx-v">{{ fmtTokens(p.tokens) }} · {{ pctOf(p.tokens, usageBasis).toFixed(1) }}%</span>
                </li>
              </ul>
              <p class="ctx-foot">
                到 {{ fmtTokens(usage.thresholdTokens) }} token 开始压缩早期轮次（窗口 × 0.8）。
                token 为估算值（中文 1 字 ≈ 1 token，西文 4 字符 ≈ 1 token）。
              </p>
            </div>

            <button class="bar-btn ghost" @click="toggleModel">
              {{ modelLabel }} <UIcon name="chevron-down" :size="11" />
            </button>
            <div v-if="modelOpen" class="pop-menu right" @click.stop @mouseleave="modelHover = null">
              <div class="pop-head2">可用模型</div>
              <div v-if="modelsError" class="pop-tip">{{ modelsError }}</div>
              <div
                v-for="m in modelOptions"
                :key="m.name"
                class="pop-item"
                :class="{ checked: model === m.name }"
                @mouseenter="onModelHover(m, $event)"
                @click="model = m.name; modelOpen = false"
              >
                <UIcon name="sparkle" :size="13" />
                <span>{{ m.label || m.name }}</span>
                <span v-if="m.tag" class="tag tag-violet">{{ m.tag }}</span>
                <span class="ratio">{{ m.ratio }}</span>
                <!-- S-25：自己加的通道要能就地改 / 删。排在 .ratio 之后——它有 margin-left:auto，
                     会被一起推到最右；`.stop` 是必须的，否则点按钮会顺带把模型选中、菜单也关了。 -->
                <span v-if="m.custom" class="mi-acts">
                  <button class="mi-act" :title="`编辑「${m.label || m.name}」`" @click.stop="openProviderEdit(m)"><UIcon name="pen" :size="12" /></button>
                  <button class="mi-act danger" :title="`移除「${m.label || m.name}」`" @click.stop="onProviderRemove(m)"><UIcon name="trash" :size="12" /></button>
                </span>
              </div>
              <!-- 悬停模型的详情卡片：fixed + 行矩形定位、跟随悬停行（参考竞品的模型详情面板） -->
              <div v-if="modelHover" class="model-card" :style="modelCardStyle" @click.stop>
                <div class="mc-head">
                  <span class="mc-name">{{ modelHover.label || modelHover.name }}</span>
                  <span v-if="modelHover.tag" class="tag tag-violet">{{ modelHover.tag }}</span>
                </div>
                <p v-if="hoverMeta.desc" class="mc-desc">{{ hoverMeta.desc }}</p>
                <dl class="mc-rows">
                  <div v-if="hoverMeta.abilities.length" class="mc-row">
                    <dt>可用功能</dt>
                    <dd>{{ hoverMeta.abilities.join(' · ') }}</dd>
                  </div>
                  <div v-if="hoverMeta.thinking" class="mc-row">
                    <dt>思考强度</dt>
                    <dd>{{ hoverMeta.thinking }}</dd>
                  </div>
                  <div v-if="hoverMeta.contextWindow" class="mc-row">
                    <dt>上下文</dt>
                    <dd>{{ hoverMeta.contextWindow }}</dd>
                  </div>
                </dl>
              </div>
              <!-- S-25：真的能加——录自己的地址 + Key + 模型名（如 DeepSeek）。
                   与设置→模型页同一套通道，存完立刻出现在上面这份清单里。 -->
              <div class="pop-item" @click="openProviderForm"><UIcon name="gear" :size="13" /> 添加模型</div>
            </div>
          </div>

          <!-- S-20：麦克风真能用——点一下开始录音，再点一下转写并**回填输入框**（不自动发送）。
               录音中显示秒数；转写中或出错都如实显示（不做"点了没反应"）。 -->
          <button
            class="bar-btn" :class="{ 'mic-on': voiceRecording }"
            :aria-label="voiceRecording ? '停止录音并识别' : '语音输入'"
            :disabled="voiceWorking && !voiceRecording"
            :title="voiceRecording ? `录音中 ${voiceSeconds}s，点击停止并识别` : (voiceSupported ? '语音输入（Alt+V）' : '当前环境不支持录音')"
            @click="toggleVoice"
          >
            <UIcon name="mic" :size="15" />
            <span v-if="voiceRecording" class="mic-sec">{{ voiceSeconds }}s</span>
          </button>
          <!-- 执行中发送键变停止键（EvaWork 同款交互）：停是协作式的，已产出内容不丢 -->
          <button
            v-if="busy && !replaying" class="send-btn stop" aria-label="停止"
            :disabled="stopping" :title="stopping ? '已请求停止，正在等待后端在安全边界停下' : '停止本次执行'"
            @click="stop"
          ><UIcon name="square" :size="13" /></button>
          <button
            v-else class="send-btn" aria-label="发送"
            :disabled="(!prompt.trim() && !attachments.length) || loginRequired || replaying"
            :title="loginRequired ? '请先登录 EVA 账号' : ''"
            @click="submit"
          ><UIcon name="send" :size="14" /></button>
        </div>

        <!-- S-20：录音/转写的状态与失败原因——"点了没反应"最伤人，转写中、出错都要看得见 -->
        <p v-if="voiceError" class="voice-msg err">{{ voiceError }}</p>
        <p v-else-if="voiceWorking" class="voice-msg">正在识别…</p>
      </div>

      <!-- 本地 / 文件夹 -->
      <div class="local-bar">
        <button class="local-chip" data-coming aria-disabled="true" title="本地工作区功能开发中，敬请期待" disabled><UIcon name="monitor" :size="12" /> 本地 <UIcon name="chevron-down" :size="10" /></button>
        <!-- T-089：接上真文件树——看 agent 在工作区里写了什么 -->
        <button class="local-chip" title="查看 agent 工作区的文件（只读）" @click="openWorkspaceFiles"><UIcon name="folder" :size="12" /> 工作区文件 <UIcon name="chevron-right" :size="10" /></button>
      </div>

      <!-- T-089：工作区面板（文件树 + 预览 + 真 PTY 终端）。 -->
      <WorkspacePanel v-model:open="filesOpen" />
    </div>

    <!-- 产物预览：点产物名弹出；md 走 Markdown 渲染，图片直接显示，其余文本高亮/纯文本 -->
    <div v-if="artOpen" class="art-mask" @click="artOpen = false">
      <div class="art-panel" role="dialog" aria-label="产物预览" @click.stop>
        <header class="art-head">
          <span class="art-name">{{ artPreview?.name || '预览' }}</span>
          <button
            v-if="artPreview?.path" class="ra-save"
            title="用系统默认程序打开"
            @click="openFilePath(artPreview.path).catch((e) => (artErr = (e as Error).message))"
          >在系统中打开</button>
          <button class="art-x" aria-label="关闭" @click="artOpen = false"><UIcon name="x" :size="14" /></button>
        </header>
        <div class="art-body">
          <template v-if="artLoading"><p class="art-tip">读取中…</p></template>
          <template v-else-if="artErr"><p class="art-err">{{ artErr }}</p></template>
          <template v-else-if="artPreview">
            <MarkdownView
              v-if="artPreview.kind === 'text' && /\.md$/i.test(artPreview.name)"
              class="art-md"
              :source="artPreview.content || ''"
            />
            <img
              v-else-if="artPreview.kind === 'image' && artPreview.b64"
              class="art-img"
              :src="`data:image/*;base64,${artPreview.b64}`"
              :alt="artPreview.name"
            />
            <pre v-else-if="artPreview.kind === 'text'" class="art-code">{{ artPreview.content }}</pre>
            <p v-else class="art-tip">{{ artPreview.note || '该文件类型暂不支持预览，可用「在系统中打开」' }}</p>
            <p v-if="artPreview.truncated" class="art-tip">内容过长，已截断预览</p>
          </template>
        </div>
      </div>
    </div>

    <!-- S-25：添加自定义模型（自带 Key / BYOK）。填 OpenAI 兼容地址 + 自己的 Key +
         模型名（如 deepseek-chat），保存后立刻出现在模型下拉里，选中就走这条通道
         （**不登录 EVA 也能跑**）。Key 只存本机，不会上传任何地方。 -->
    <div v-if="providerFormOpen" class="modal-mask" @click.self="closeProviderForm">
      <div class="modal pv-modal" role="dialog" :aria-label="pvEditId ? '编辑模型' : '添加模型'">
        <button class="icon-btn modal-close" aria-label="关闭" @click="closeProviderForm"><UIcon name="x" :size="15" /></button>
        <div class="modal-title">{{ pvEditId ? '编辑模型' : '添加模型' }}</div>
        <p class="pv-tip">OpenAI 兼容地址 + 你自己的 Key，填完就能在任务里选它。Key 只存在本机。</p>
        <label class="pv-field">
          <span class="pv-label">名称</span>
          <input v-model="pvDraft.name" class="input" placeholder="我的 DeepSeek" />
        </label>
        <label class="pv-field">
          <span class="pv-label">接口地址</span>
          <input v-model.trim="pvDraft.base_url" class="input" placeholder="https://api.deepseek.com/v1" />
        </label>
        <label class="pv-field">
          <span class="pv-label">模型名</span>
          <input v-model.trim="pvDraft.model" class="input" placeholder="deepseek-chat" />
        </label>
        <label class="pv-field">
          <span class="pv-label">API Key</span>
          <input
            v-model="pvDraft.api_key"
            class="input"
            type="password"
            :placeholder="pvEditId ? '留空则不修改已存的 Key' : 'sk-...（本地服务可留空）'"
          />
        </label>
        <p v-if="pvTestMsg" class="pv-msg" :class="pvTestOk ? 'ok' : 'warn'">{{ pvTestMsg }}</p>
        <p v-else-if="pvMsg" class="pv-msg" :class="pvTone">{{ pvMsg }}</p>
        <div class="pv-actions">
          <button
            v-if="pvEditId"
            class="btn pv-danger"
            :disabled="pvBusy"
            @click="onProviderRemove({ name: `custom:${pvEditId}`, label: pvDraft.name || '这条通道' })"
          >
            移除
          </button>
          <button class="btn" :disabled="pvBusy" @click="onTestDraft">{{ pvBusy ? '测试中…' : '测试连接' }}</button>
          <button class="btn btn-dark" :disabled="pvBusy" @click="onSaveProvider">{{ pvEditId ? '保存修改' : '保存' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 布局：输出在上（.thread 吃掉剩余高度并**自己滚动**）、输入在下（.dock 独占一行）——比照参考稿的"对话在中、输入在底"。
   T-106：这里**不能**再让 .new-task 长过视口（min-height:100%）+ .dock sticky 吸底：
   内容一高，sticky 会把 .dock 从它自己的位置"贴底抬上来"（实测 864×416 抬高 147px、1080×270 抬高 157px），
   抬上来后不占位、直接盖住上面的建议卡 —— 窗口一矮整块对话区就叠成一团（用户截图）。
   改为整个视图 height:100% 铺满视口、由 .thread 内部滚动：输入框仍在视线内，且任何窗口高度都不重叠。 */
.new-task { display: flex; flex-direction: column; height: 100%; max-width: 860px; margin: 0 auto; padding-top: 24px; padding-bottom: 0; }
.thread { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }
.dock { flex: none; padding: 12px 0 18px; background: var(--bg); }

/* TS-065：上下文用量面板。从模型选择区圆环按钮上方弹出，不再常驻在输入框下方。 */
.ctx-panel {
  position: absolute; left: 0; bottom: 34px; z-index: 30; width: 300px;
  padding: 12px 13px 10px; border-radius: 12px; background: var(--panel, var(--bg));
  border: 1px solid var(--line); box-shadow: 0 10px 28px rgba(23, 25, 30, 0.16);
}
.ctx-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ctx-title { font-size: 12.5px; font-weight: 600; color: var(--t1); }
.ctx-head-r { display: flex; align-items: center; gap: 3px; }
/* 口径切换：两个小 chip。默认"占窗口"（与顶部百分比同源）；切到"占已用"才看得出内部构成 */
.ctx-basis {
  padding: 2px 6px; border-radius: 999px; font-size: 10.5px; color: var(--t3);
  background: var(--line-2); border: 1px solid transparent;
}
.ctx-basis:hover { color: var(--t1); }
.ctx-basis.on { color: var(--t1); background: var(--bg); border-color: var(--line); font-weight: 600; }
.ctx-x { display: inline-flex; color: var(--t3); background: none; }
.ctx-x:hover { color: var(--t1); }
.ctx-big { display: flex; align-items: baseline; gap: 8px; margin: 8px 0 7px; }
.ctx-big b { font-size: 20px; line-height: 1; color: var(--t1); }
.ctx-big span { font-size: 11.5px; color: var(--t2); }
.ctx-bar { display: flex; height: 7px; border-radius: 999px; overflow: hidden; background: var(--line); }
.ctx-bar i { display: block; height: 100%; }
.ctx-list { list-style: none; margin: 10px 0 0; padding: 0; }
.ctx-list li { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12px; }
.ctx-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.ctx-k { flex: 1 1 auto; color: var(--t1); }
.ctx-v { color: var(--t2); font-variant-numeric: tabular-nums; }
.ctx-foot { margin: 9px 0 0; font-size: 11px; line-height: 1.5; color: var(--t3); }
.composer { position: relative; padding: 16px 16px 12px; box-shadow: 0 2px 12px rgba(23,25,30,0.05); }
/* 运行时边框特效：creating/streaming 时一圈五彩流光沿输入框顺时针旋转。

   为什么是「双层背景」而不是伪元素：
   `.dock` 自己有背景，而 z-index:-1 的伪元素落在正常流内容层**之下**，
   会被 dock 的背景整块盖掉——之前两版都栽在这里（截图里只剩 box-shadow 的
   静态淡紫环，看着像"只有左右有特效"）。而且加 overflow:hidden 裁掉旋转矩形
   会连带裁掉输入框里向上弹出的菜单面板。双层背景不碰 z-index、不碰 overflow，
   四条边严格对称。 */
@property --angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}
.composer.running {
  border: 2px solid transparent;
  background:
    linear-gradient(var(--panel), var(--panel)) padding-box,
    conic-gradient(from var(--angle),
      transparent 0deg,
      #ff0056 26deg,
      #ff7a00 44deg,
      #ffe600 62deg,
      #00e07a 80deg,
      #00b4ff 98deg,
      #7a4dff 116deg,
      transparent 144deg) border-box;
  box-shadow: 0 6px 26px rgba(122, 77, 255, 0.16);
  animation: composer-border-spin 3.5s linear infinite;
}
@keyframes composer-border-spin {
  to { --angle: 360deg; }
}
.composer-input { width: 100%; border: none; outline: none; font-size: 14px; background: none; }
.composer-input::placeholder { color: var(--t3); }
.composer-bar { display: flex; align-items: center; gap: 8px; margin-top: 22px; }
.pop-wrap { position: relative; }
.bar-btn {
  display: inline-flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 8px; border-radius: 7px; color: var(--t1); font-size: 12.5px;
}
.bar-btn:hover { background: var(--line-2); }
.bar-btn.ghost { color: var(--t1); font-weight: 500; }
.model-group { display: inline-flex; align-items: center; gap: 4px; }
.ctx-ring-btn {
  width: 26px; padding: 0; justify-content: center; background: transparent;
}
.ctx-ring-btn:hover { background: var(--line-2); }
.ctx-ring { width: 16px; height: 16px; transform: rotate(-90deg); }
.ctx-ring-bg { fill: none; stroke: var(--line); stroke-width: 5; }
.ctx-ring-bar { fill: none; stroke-width: 5; stroke-linecap: round; transition: stroke-dasharray 0.25s ease; }
.pop-menu {
  position: absolute; bottom: 34px; left: 0; min-width: 230px; z-index: 20;
  background: var(--panel); border-radius: 12px; box-shadow: var(--shadow); padding: 6px;
  /* 技能/插件装多了菜单会很长：限高 + 内部滚动，别顶穿屏幕（用户截图里整屏被盖住） */
  max-height: min(440px, 60vh); overflow-y: auto;
}
/* + 菜单一级面板定宽：二级面板要按「菜单宽度 + 间距」定位，定宽才不会再压到一级上 */
.pop-menu.plus-menu { width: 236px; min-width: 0; }
/* 「隐藏窗口截图」勾选框：用 span 而非 input，才能跟菜单其它行共用同一套行高与配色 */
.pop-check {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; flex: none; border-radius: 4px;
  border: 1px solid var(--line); color: transparent;
}
.pop-check.on { background: var(--t1); border-color: var(--t1); color: var(--panel); }
.pop-item.disabled { opacity: 0.5; pointer-events: none; }
/* 截图行右侧的「选项」小箭头：点行 = 立刻截图，点箭头 = 开截图选项面板（一个动作 + 一个设置入口）。
   它是 button，所以 sub-arrow 的 margin-left:auto 要让位给外层按钮。
   点击区要够大：20×20 时行高 47px、箭头缩在中间一小块，很难点中（用户反馈）。
   改成撑满整行高度 + 顶到右内边距的 34px 宽条（负外边距吃掉行的 8/10px 内边距），
   实际命中区 34×47，是原来的 4 倍。 */
.pop-item .sub-toggle {
  margin: -8px -10px -8px auto; flex: none; align-self: stretch; width: 34px;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 8px; background: transparent; color: var(--t2); cursor: pointer;
}
.pop-item .sub-toggle:hover { background: var(--line); color: var(--t1); }
.pop-item .sub-toggle .sub-arrow { margin-left: 0; }
/* 截图选项面板：借用第三级的 fixed 定位（left/top 由 shotPanelStyle 按行矩形给），
   只是内容少——窄一点、不限高（一行开关 + 说明，不需要滚动） */
.pop-sub2.shot-panel { width: 264px; max-height: none; }
/* T-156：附件 chips（输入框上方）。选/截的文件在这里可删除，发送时按相对路径写进正文 */
.attach-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; align-items: center; }
.att-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 6px 0 8px;
  border-radius: 7px; border: 1px solid var(--line); background: var(--line-2); font-size: 12px; max-width: 240px;
}
.att-thumb { width: 18px; height: 18px; border-radius: 4px; object-fit: cover; flex: none; }
.att-name { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--t1); }
.att-size { color: var(--t3); font-size: 10.5px; flex: none; }
.att-x {
  flex: none; width: 16px; height: 16px; display: grid; place-items: center; border: none; border-radius: 4px;
  background: transparent; color: var(--t3); cursor: pointer;
}
.att-x:hover { background: var(--line); color: var(--err); }
.attach-msg { color: var(--orange); font-size: 11.5px; }
/* 技能二级面板：搜索框固定顶、列表自己滚（pop-sub 与 pop-menu 同级，不进滚动容器） */
.pop-sub.skill-panel {
  display: flex; flex-direction: column; width: 332px; max-height: min(460px, 58vh); padding: 6px; overflow: hidden;
}
.ps-search {
  display: flex; align-items: center; gap: 6px; margin: 2px 2px 6px; padding: 0 8px; height: 28px;
  border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--t3); flex: none;
}
.ps-search input { flex: 1; border: none; outline: none; background: none; color: var(--t1); font-size: 12.5px; min-width: 0; }
.ps-list { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
/* 技能行：名字 + 描述两行，名字单行不折（解决原截图里技能名被挤成多行的错位） */
.skill-panel .ps-row { padding: 7px 8px; text-align: left; border: none; background: none; cursor: pointer; border-radius: 8px; }
.skill-panel .ps-row:hover { background: var(--line-2); }
.skill-panel .pp-name { color: var(--violet); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.pop-menu.right { left: auto; right: 0; }
.pop-item {
  display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-radius: 8px;
  font-size: 13px; cursor: pointer;
}
.pop-item:hover { background: var(--line-2); }
.pop-item svg { color: var(--t2); flex: none; }
.pop-item b { display: block; font-size: 12.5px; font-weight: 600; }
.pop-item small { display: block; color: var(--t2); font-size: 11px; }
.pop-item.checked { background: var(--line-2); }
.pop-item.warn b { color: var(--orange); }
.pop-head { font-size: 11.5px; color: var(--t2); padding: 6px 10px; border-bottom: 1px solid var(--line-2); margin-bottom: 4px; }
.pop-head2 { font-size: 11px; color: var(--t3); padding: 6px 10px 2px; }
.pop-tip { font-size: 11px; color: var(--t3); padding: 2px 10px 6px; line-height: 1.5; }
/* 悬停模型的详情卡片。原来在 .pop-menu 内做绝对定位，被菜单的 overflow-y:auto 裁剪
   （与 .pop-sub2 同一个坑），实际只看到原生 title 提示。改为 fixed + 行矩形定位
   （left/top 由 onModelHover 给出）：优先贴菜单右侧，贴窗口右缘时翻到左侧。
   fixed 不受滚动容器裁剪，卡片也不会把菜单撑高。 */
.model-card {
  position: fixed; width: 240px;
  background: var(--panel, var(--bg)); border: 1px solid var(--line-2); border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.28); padding: 12px 14px; z-index: 30;
}
.mc-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.mc-name { font-size: 13px; font-weight: 700; }
.mc-desc { font-size: 11.5px; color: var(--t2); line-height: 1.55; margin: 0 0 8px; }
.mc-rows { margin: 0; }
.mc-row { display: flex; gap: 8px; padding: 3px 0; font-size: 11.5px; align-items: baseline; }
.mc-row dt { color: var(--t3); flex: none; }
.mc-row dd { margin: 0; color: var(--t1); text-align: right; flex: 1; }
.sub-arrow { margin-left: auto; color: var(--t3); }
.ratio { margin-left: auto; color: var(--t3); font-size: 11.5px; }
.plugin-dots { display: flex; gap: 4px; }
.pd { width: 18px; height: 18px; border-radius: 5px; color: #fff; display: inline-flex; align-items: center; justify-content: center; }
.spacer { flex: 1; }
.send-btn {
  width: 30px; height: 30px; border-radius: 8px; background: var(--violet); color: #fff;
  display: inline-flex; align-items: center; justify-content: center;
}
.send-btn:disabled { background: var(--violet-soft); cursor: default; }
/* 执行中：发送键变停止键（红底方块），与 EvaWork 的停止交互一致 */
.send-btn.stop { background: #e5484d; }
.send-btn.stop:disabled { opacity: 0.55; }
.local-bar { display: flex; gap: 8px; margin-top: 12px; }
.local-chip {
  display: inline-flex; align-items: center; gap: 5px;
  height: 26px; padding: 0 10px; border-radius: 8px; font-size: 12px; color: var(--t1);
  border: 1px solid var(--line); background: var(--panel);
}
.local-chip.faint { border-color: transparent; background: none; color: var(--t2); }
.chips-row { display: flex; align-items: center; gap: 10px; margin-top: 34px; flex-wrap: wrap; }
.quick-chip {
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line);
  background: var(--panel); font-size: 13px;
}
.quick-chip:hover { background: var(--line-2); }
.more-arr { color: var(--t3); }
.sug-list { margin-top: 16px; display: flex; flex-direction: column; gap: 10px; }
.sug-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; }
.sug-ic { width: 26px; height: 26px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.sug-text { font-size: 13px; flex: 1; }
.sug-badge { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px; border-radius: 6px; font-size: 11.5px; }
.sug-go { color: var(--t3); }

/* 对话流：用户消息右对齐气泡；回答区无卡片底，靠 logo + 名称建立归属 */
.msg-user { display: flex; justify-content: flex-end; margin-top: 26px; }
.msg-bubble {
  max-width: 78%; background: var(--line-2); border-radius: 14px; padding: 10px 14px;
  font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
}
.msg-ai { margin-top: 22px; }
.ai-head { display: flex; align-items: center; gap: 8px; }
.ai-logo {
  width: 24px; height: 24px; border-radius: 7px; background: var(--violet); color: #fff;
  display: inline-flex; align-items: center; justify-content: center; flex: none;
}
.ai-name { font-size: 13px; font-weight: 600; }
/* 「执行过程」折叠头（对应 EvaWork 的"思考过程"） */
.think { display: inline-flex; align-items: center; gap: 5px; margin-top: 14px; padding: 0; background: none; font-size: 12.5px; color: var(--t2); cursor: pointer; }
.think:hover { color: var(--t1); }
.process { margin-top: 10px; padding-left: 12px; border-left: 2px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
/* 流式正文：无底框、不限高（页面滚动），更像对话回答而不是日志面板。
   T-104：这里**不能**再写 `white-space: pre-wrap` —— 正文已是 markdown-it 渲染的 HTML，
   容器保留换行会把 HTML 源码里块级标签之间的换行符一起渲染成真换行（每个块后面多一个空行 = 双倍行距）。
   正文的分行语义交给 MarkdownView（`:breaks="true"` → `<br>`），行高也由 `.md` 统一持有。 */
.ai-out { margin: 12px 0 0; font-family: inherit; font-size: 13.5px; word-break: break-word; }

/* T-090：子代理轨迹——派出去的活干了什么，人得看得见（模型手里只有摘要） */
.sub-trace { margin: 8px 0 2px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--line-2); }
.sub-head { font-size: 11.5px; color: var(--t2); font-weight: 600; }
.sub-row { display: flex; align-items: baseline; gap: 6px; margin-top: 5px; font-size: 11.5px; }
.sub-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--t3); margin-top: 5px; }
.sub-dot.ok { background: var(--ok); }
.sub-dot.no { background: var(--err); }
.sub-tool { flex: none; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--t1); }
.sub-out { flex: 1; color: var(--t3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 任务执行面板（徽章 / 步骤 / 工具等通用件） */
.run-badge { flex: none; height: 22px; padding: 0 9px; border-radius: 6px; font-size: 11.5px; background: var(--line-2); color: var(--t2); display: inline-flex; align-items: center; }
.run-badge.streaming, .run-badge.creating { background: var(--violet-bg); color: var(--violet); }
.run-badge.waiting { background: var(--orange-bg); color: var(--orange); }
.run-badge.done { background: var(--ok-bg); color: var(--ok); }
.run-badge.error { background: var(--err-bg); color: var(--err); }
.run-badge.cancelled, .run-badge.partial { background: var(--orange-bg); color: var(--orange); }
/* T-076：技能标签与 + 菜单里的技能项 */
.skill-chip { flex: none; height: 22px; padding: 0 8px; gap: 4px; border-radius: 6px; font-size: 11.5px; background: var(--violet-bg); color: var(--violet); display: inline-flex; align-items: center; }
.pop-sep { padding: 6px 10px 2px; font-size: 10.5px; color: var(--t3); letter-spacing: .3px; }
.pop-hint { padding: 6px 10px 8px; font-size: 11px; color: var(--t3); line-height: 1.5; }
.pop-hint code { font-size: 10.5px; background: var(--line-2); padding: 1px 4px; border-radius: 3px; }
.pop-note { margin-left: auto; font-size: 10.5px; color: var(--t3); max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* T-142：+ 菜单「插件」面板——二级弹出，放主菜单右侧而不是内联展开 */
.pop-item .sub-arrow { transition: transform 0.12s ease; }
.pop-item .sub-arrow.open { transform: rotate(90deg); }
.pop-item.active { background: var(--line-2); }
/* 二级面板（技能/插件清单）。与 pop-menu 同级、不进它的滚动容器，所以不能用
   `left: calc(100% + 8px)`——那个 100% 是 `.pop-wrap`（+ 按钮）的宽度，只有 34px，
   面板会落在 42px 处把 230px 宽的一级菜单整块盖住（用户截图）。
   改为显式偏移：一级定宽 236 + 8 间距 = 244，底边与一级菜单同基线（bottom: 34px）。 */
.pop-sub {
  position: absolute; bottom: 34px; left: 244px; width: 320px; max-height: 340px; overflow-y: auto;
  background: var(--panel); border-radius: 12px; box-shadow: var(--shadow); padding: 6px; z-index: 21;
  animation: ps-in 0.12s ease;
}
/* 第三级：工具面板。fixed + 行矩形定位（正右侧、顶对齐悬停行）；
   fixed 不受 pop-sub 滚动容器裁剪，left/top 由 hoverPlugin 内联给出 */
.pop-sub2 {
  position: fixed; width: 320px; max-height: min(340px, calc(100vh - 16px)); overflow-y: auto;
  background: var(--panel); border-radius: 12px; box-shadow: var(--shadow); padding: 6px; z-index: 21;
  animation: ps-in 0.12s ease;
}
@keyframes ps-in { from { opacity: 0; transform: translateX(-4px); } to { opacity: 1; transform: none; } }
.pop-empty { padding: 10px 12px 12px; font-size: 11px; line-height: 1.7; color: var(--t3); }
.pop-empty.ps-none { padding: 14px 12px 16px; text-align: center; }
/* 面板共用头部：列表页小标题 / 工具页返回行，同一套节奏 */
.ps-head { display: flex; align-items: center; gap: 8px; padding: 4px 8px 8px; }
.ps-title { font-size: 11px; font-weight: 600; color: var(--t2); letter-spacing: 0.02em; }
.ps-count { min-width: 18px; height: 16px; padding: 0 5px; border-radius: 999px; background: var(--line-2); color: var(--t2); font-size: 10px; line-height: 16px; text-align: center; }
.ps-back { flex: none; width: 24px; height: 24px; display: grid; place-items: center; border: none; border-radius: 7px; background: transparent; color: var(--t2); cursor: pointer; }
.ps-back:hover { background: var(--line-2); color: var(--t1); }
/* 插件行：名字+spec 两行主列，右侧 chevron 暗示可进入 */
.ps-row { align-items: center; }
.ps-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pp-name { font-size: 12.5px; font-weight: 600; color: var(--t1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-spec { font-size: 10.5px; color: var(--t3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ps-go { flex: none; color: var(--t3); opacity: 0; transition: opacity 0.12s ease; }
.ps-row:hover .ps-go { opacity: 1; }
.pop-plugin .pop-item { padding: 7px 8px; }
/* 工具 chips：淡底 pill，去重边框；hover 提亮 */
.pop-tools { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 4px 6px; }
.pop-tool { max-width: 100%; padding: 3px 10px; border: none; border-radius: 999px; background: var(--line-2); color: var(--t2); font-size: 11px; line-height: 1.5; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: background 0.12s ease, color 0.12s ease; }
.pop-tool:hover { background: var(--line); color: var(--t1); }
/* T-073：停止 / 继续 */
.stop-btn { flex: none; height: 24px; padding: 0 10px; gap: 5px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--t2); font-size: 11.5px; display: inline-flex; align-items: center; cursor: pointer; }
.stop-btn:hover:not(:disabled) { background: var(--line-2); color: var(--t1); }
.stop-btn:disabled { opacity: .55; cursor: default; }
.run-hint { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12.5px; color: var(--t2); }
.spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--violet); animation: rt-spin 0.7s linear infinite; }
@keyframes rt-spin { to { transform: rotate(360deg); } }
.run-steps { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.run-step { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.run-step .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--line); flex: none; }
.run-step.running .dot { background: var(--violet); }
.run-step.waiting .dot { background: var(--orange); }
.run-step.done .dot { background: #0cb277; }
.run-step.skipped .dot, .run-step.failed .dot { background: var(--err); }
.run-step .st { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-step .sd { flex: none; font-size: 11px; color: var(--t3); }
.run-out { margin: 12px 0 0; font-size: 12.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }

.run-approve { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: var(--orange-bg); color: var(--orange); font-size: 12.5px; }
.run-approve .ap-msg { flex: 1; }
.ap-btn { height: 26px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); font-size: 12.5px; }
.ap-btn.primary { background: var(--violet); color: #fff; border-color: transparent; }
/* 产物预览弹层 */
.art-mask { position: fixed; inset: 0; z-index: 70; background: rgba(15, 17, 21, 0.4); display: flex; align-items: center; justify-content: center; }
.art-panel {
  width: min(760px, 92vw); max-height: 84vh; background: var(--bg); border: 1px solid var(--line-2);
  border-radius: 12px; display: flex; flex-direction: column; box-shadow: 0 18px 48px rgba(15, 17, 21, 0.25);
}
.art-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line-2); }
.art-name { flex: 1; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.art-x { color: var(--t2); padding: 4px; border-radius: 6px; }
.art-x:hover { background: var(--line-2); color: var(--t1); }
.art-body { padding: 12px 16px; overflow: auto; min-height: 120px; }
.art-md { font-size: 13px; line-height: 1.75; }
.art-code {
  margin: 0; padding: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  font-size: 12px; line-height: 1.6; overflow: auto; white-space: pre-wrap; word-break: break-word;
}
.art-img { max-width: 100%; border-radius: 8px; border: 1px solid var(--line); }
.art-tip { margin: 10px 2px; font-size: 12px; color: var(--t3); }
.art-err { margin: 10px 2px; font-size: 12px; color: var(--err); }
.run-arts { margin-top: 12px; border-top: 1px solid var(--line-2); padding-top: 10px; }
.ra-t { font-size: 11.5px; color: var(--t3); margin-bottom: 6px; }
.ra-item { display: flex; align-items: center; gap: 6px; font-size: 12.5px; padding: 3px 0; }
.ra-n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ra-link { text-align: left; color: var(--t1); }
.ra-link:hover { color: var(--violet); text-decoration: underline; }
/* 工具间叙述：小字灰显、行距收紧——它们是过程，不是答案 */
.nar-line { font-size: 11.5px; line-height: 1.55; color: var(--t3); margin: 2px 0; }
/* T-108：叙述与工具在同一时间线里交错，间距交给 .process 的 gap，工具条目自身不再留底边距 */
.process .rt-item { margin-bottom: 0; }
.ra-save {
  flex: none; height: 22px; padding: 0 8px; border-radius: 6px; font-size: 11px;
  border: 1px solid var(--line); background: var(--panel); color: var(--t2);
}
.ra-save:hover:not(:disabled) { color: var(--violet); border-color: var(--violet); }
.ra-save:disabled { opacity: 0.5; cursor: default; }
.ra-msg { margin: 6px 0 0; font-size: 11.5px; color: var(--t3); }

/* S-25：添加模型弹窗（自带 Key / BYOK）。字段竖排——弹窗窄，比设置页那套"左说明右输入"更合身。 */
.pv-modal { width: min(460px, 92vw); }
.pv-tip { margin: 8px 0 14px; font-size: 12px; color: var(--t3); line-height: 1.6; }
.pv-field { display: block; margin-bottom: 12px; }
.pv-label { display: block; margin-bottom: 5px; font-size: 12px; color: var(--t2); }
.pv-field .input { width: 100%; box-sizing: border-box; }
.pv-msg { margin: 2px 0 12px; font-size: 12px; line-height: 1.5; }
.pv-msg.ok { color: var(--green); }
.pv-msg.warn { color: var(--err); }
.pv-actions { display: flex; justify-content: flex-end; gap: 8px; }
/* 编辑态左边的「移除」：把右边的测试/保存推到另一头，免得误点 */
.pv-danger { margin-right: auto; color: var(--red); }

/* S-25：模型下拉里自带通道的「编辑 / 移除」小按钮。默认不显示——清单是拿来选模型的，
   常驻两个图标会把行读成工具栏；悬停那一行才浮出来。
   用 visibility 而不是 opacity:0：后者只是"看不见"，那块区域**仍然可点**，
   等于在行尾埋了一颗看不见的删除按钮。 */
.mi-acts { display: inline-flex; align-items: center; gap: 2px; margin-left: 4px; visibility: hidden; }
.pop-item:hover .mi-acts { visibility: visible; }
.mi-act {
  display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px;
  padding: 0; border: none; border-radius: 6px; background: transparent; color: var(--t2); cursor: pointer;
}
/* 图标用的是 stroke="currentColor"，而 `.pop-item svg` 单独指定了颜色，
   所以要连 svg 一起覆盖，否则悬停时只有按钮底色变、图标纹丝不动。 */
.mi-act:hover { background: var(--line); }
.mi-act:hover svg { color: var(--t1); }
.mi-act.danger:hover svg { color: var(--red); }
/* T-092：改动与撤销 */
.run-ck { margin-top: 12px; border-top: 1px solid var(--line-2); padding-top: 10px; }
.ck-item { display: flex; align-items: center; gap: 6px; font-size: 12.5px; padding: 3px 0; }
.ck-n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ck-tag { flex: none; font-size: 11px; color: var(--t3); }
.ck-hint { margin: 6px 0 0; font-size: 11px; color: var(--t3); }
/* S-24：跟进推荐——一条一行、点即追问；与"快捷 chips"同族但只出现在回合末尾 */
.run-fu { margin-top: 12px; border-top: 1px solid var(--line-2); padding-top: 10px; }
.fu-t { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--t2); margin-bottom: 8px; }
.fu-re { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--t2); background: none; border: 1px solid var(--line); border-radius: 6px; padding: 2px 7px; cursor: pointer; }
.fu-re:hover:not(:disabled) { color: var(--t1); border-color: var(--t3); }
.fu-re:disabled { opacity: .55; cursor: default; }
.fu-chip {
  display: block; width: 100%; text-align: left; margin-bottom: 6px;
  font-size: 12.5px; line-height: 1.5; padding: 8px 10px; cursor: pointer;
  border: 1px solid var(--line); border-radius: 8px; background: var(--bg-2, var(--bg)); color: var(--t1);
}
.fu-chip:hover { border-color: var(--violet); color: var(--violet); }
.fu-msg { margin: 4px 0 0; font-size: 11px; color: var(--t3); }
/* S-20：麦克风——录音中是"真在录"的状态（变紫 + 秒数），不是换个颜色装样子 */
.bar-btn.mic-on { color: #fff; background: var(--violet); border-color: var(--violet); }
.mic-sec { margin-left: 4px; font-size: 10.5px; font-variant-numeric: tabular-nums; }
.voice-msg { margin: 6px 0 0; padding: 0 4px; font-size: 11.5px; color: var(--t3); }
.voice-msg.err { color: var(--err); }
.run-err { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: var(--err-bg); font-size: 12.5px; color: var(--err); }
.run-err .er-msg { flex: 1; }
</style>
