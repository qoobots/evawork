<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import UIcon from '@/components/UIcon.vue';
import { bridgeAvailable } from '@/api/backend';
import {
  createTask,
  cancelTask,
  streamTask,
  STATE_LABEL,
  STEP_LABEL,
  type Artifact,
  type Step,
  type StreamEvent,
} from '@/api/tasks';
import {
  fetchTemplate,
  type TemplateDetail,
  type TemplateItem,
} from '@/api/templates';
import { useArtifactSave } from '@/composables/useArtifactSave';
import { useToolRuns } from '@/composables/useToolRuns';

/* T-035：把模板运行产生的产物写回「我的文件」 */
const { savingId: savingArtifact, artMsg, saveArtifact } = useArtifactSave();

const props = defineProps<{ template: TemplateItem | null }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const detail = ref<TemplateDetail | null>(null);
const loadingDetail = ref(false);
const online = computed(() => bridgeAvailable());

/* ---------- 应用模板：创建任务并流式执行（T-032） ---------- */
/* T-073：'cancelled' 独立终态——得让用户知道是自己停的，不是跑完了 */
type Phase = 'idle' | 'creating' | 'streaming' | 'waiting' | 'error' | 'done' | 'cancelled';
const phase = ref<Phase>('idle');
const steps = ref<Step[]>([]);
const output = ref('');
const artifacts = ref<Artifact[]>([]);
const errMsg = ref('');
const taskId = ref('');
const runTitle = ref('');
const busy = computed(() => phase.value === 'creating' || phase.value === 'streaming');

/* T-070：模型自主发起的工具调用（与新建任务页共用一套逻辑） */
const { toolRuns, resetToolRuns, pushToolCall, patchToolResult } = useToolRuns();

/* T-071：系统提示（如限流重试） */
const notices = ref<string[]>([]);
function resetNotices() {
  notices.value = [];
}

/* T-072：已消费到的最大事件 rev，断线续跑时用它补发 */
const lastRev = ref(0);

const phaseLabel = computed(
  () =>
    ({
      idle: '未开始',
      creating: '创建任务中',
      streaming: '流式执行中',
      waiting: STATE_LABEL.waiting_approval,
      error: '出错',
      done: '已完成',
      cancelled: '已中断',
    })[phase.value],
);

watch(
  () => props.template,
  async (t) => {
    // 重置运行态
    phase.value = 'idle';
    steps.value = [];
    output.value = '';
    artifacts.value = [];
    resetToolRuns();
    errMsg.value = '';
    taskId.value = '';
    detail.value = null;
    if (!t) return;

    const localPrompt = `请使用「${t.title}」模板，${t.desc}。请输出可直接使用的内容，并尽量结构化。`;
    if (!online.value) {
      detail.value = { ...t, prompt: localPrompt };
      return;
    }
    loadingDetail.value = true;
    try {
      detail.value = await fetchTemplate(t.title);
    } catch {
      // 后端拿不到详情也不阻塞查看，回退本地构造的 prompt
      detail.value = { ...t, prompt: localPrompt };
    } finally {
      loadingDetail.value = false;
    }
  },
);

function resetRun() {
  phase.value = 'idle';
  steps.value = [];
  output.value = '';
  artifacts.value = [];
  resetToolRuns();
  resetNotices();
  lastRev.value = 0;
  stopping.value = false;
  errMsg.value = '';
  taskId.value = '';
}

async function applyTemplate() {
  if (!detail.value || busy.value) return;
  const title = detail.value.prompt;
  if (!online.value) {
    runTitle.value = props.template?.title ?? '';
    phase.value = 'error';
    errMsg.value = '未连接后端（Electron 未注入地址，或 VITE_BACKEND_URL 未配置）；模板已就绪，但未真正执行';
    return;
  }
  resetRun();
  runTitle.value = detail.value.title;
  await runOnce(title, false);
}

async function runOnce(title: string, resume: boolean) {
  try {
    if (!resume) {
      phase.value = 'creating';
      const t = await createTask({ title, mode: 'work', model: 'auto' });
      taskId.value = t.id;
    }
    phase.value = 'streaming';
    // T-072：续跑带上已看到的最大 rev，后端先补发缺失的帧再接实时流
    for await (const ev of streamTask(taskId.value, resume, resume ? lastRev.value : 0)) {
      applyEvent(ev);
    }
    // T-073：中断是终态，不能被流结束覆盖成"已完成"
    if (!['error', 'cancelled'].includes(phase.value)) phase.value = 'done';
  } catch (e) {
    phase.value = 'error';
    errMsg.value = (e as Error).message || '执行失败';
  }
}

/* T-073：停止 = 请求后端协作式取消（不是关闭 SSE——关流只是前端看不见，任务还在跑） */
const stopping = ref(false);
async function stop() {
  if (!taskId.value || stopping.value) return;
  stopping.value = true;
  try {
    await cancelTask(taskId.value);
  } catch (e) {
    errMsg.value = `停止失败：${(e as Error).message}`;
  }
}

function applyEvent(ev: StreamEvent) {
  if (typeof ev.rev === 'number') lastRev.value = ev.rev; // T-072：记住断点
  switch (ev.type) {
    case 'status':
      break;
    case 'plan':
      steps.value = ev.steps;
      break;
    case 'replan':
      // T-087：重规划产出的新步骤接在后面；失败的那一步保留（不假装它没发生过）
      steps.value = [...steps.value, ...(ev.steps || [])];
      break;
    case 'step': {
      const i = steps.value.findIndex((s) => s.id === ev.step.id);
      if (i >= 0) steps.value[i] = ev.step;
      else steps.value.push(ev.step);
      break;
    }
    case 'token':
      output.value += ev.content ?? '';
      break;
    case 'retry':
      notices.value.push(ev.message);
      break;
    case 'tool_call':
      pushToolCall(ev.call);
      break;
    case 'tool_result':
      patchToolResult(ev.result);
      break;
    case 'artifact':
      artifacts.value.push(ev.artifact);
      break;
    case 'done':
      // T-131：done 帧里的 task.steps / task.artifacts 是**跨轮累计**的任务级列表，
      // 回填会让上一轮的产物/步骤串进本轮（与 NewTaskView 同一处坑）。本轮内容由本轮帧喂齐。
      break;
    case 'error':
      errMsg.value = ev.message;
      phase.value = 'error';
      break;
    case 'cancelled':
      // T-073：已产出的正文/产物/步骤都留着，只标记"到这里被停了"（不回填任务级累计列表，见 done）
      phase.value = 'cancelled';
      stopping.value = false;
      break;
  }
}



function retry() {
  errMsg.value = '';
  void runOnce(runTitle.value, Boolean(taskId.value));
}

function close() {
  emit('close');
}
</script>

<template>
  <div v-if="template" class="modal-mask" @click.self="close">
    <div class="modal card">
      <button class="modal-x icon-btn" @click="close"><UIcon name="x" :size="15" /></button>

      <!-- 详情头 -->
      <div class="d-head" :style="{ background: `linear-gradient(150deg, ${template.hue}, ${template.hue}cc 60%, ${template.hue}99)` }">
        <span class="d-cat">{{ template.cat }}</span>
        <div class="d-title">{{ template.title }}</div>
      </div>

      <div class="d-body">
        <div v-if="loadingDetail" class="d-loading"><span class="spin" /> 加载模板详情…</div>
        <p v-else class="d-desc">{{ detail?.desc || template.desc }}</p>
        <div v-if="detail" class="d-prompt">
          <div class="dp-h">应用后将发送给 Agent 的指令</div>
          <pre class="dp-t">{{ detail.prompt }}</pre>
        </div>

        <button class="apply-btn" :disabled="busy || !detail" @click="applyTemplate">
          <UIcon name="zap" :size="13" /> 应用模板
        </button>
        <p v-if="!online" class="d-offline">未连接后端：应用将不会真正执行，仅展示指令。</p>

        <!-- 执行面板（复用任务执行样式） -->
        <div v-if="phase !== 'idle'" class="run">
          <div class="run-head">
            <span class="run-title">{{ runTitle }}</span>
            <span class="run-badge" :class="phase">{{ phaseLabel }}</span>
            <!-- T-073：执行中可停（后端在安全边界停，已产出内容不丢） -->
            <button v-if="busy" class="stop-btn" :disabled="stopping" @click="stop" :title="stopping ? '已请求停止，正在等待后端停下' : '停止本次执行'">
              <UIcon name="x" :size="12" /> {{ stopping ? '停止中…' : '停止' }}
            </button>
            <button v-else-if="phase === 'cancelled'" class="stop-btn" @click="retry" title="从断点继续">
              <UIcon name="play" :size="12" /> 继续
            </button>
          </div>
          <p v-if="phase === 'cancelled'" class="run-note">已中断：已产出的内容都保留，点「继续」可从断点续跑。</p>

          <div v-if="busy && !steps.length" class="run-hint">
            <span class="spin" /> 正在规划执行步骤…
          </div>

          <ol v-if="steps.length" class="run-steps">
            <li v-for="s in steps" :key="s.id" class="run-step" :class="s.status">
              <span class="dot" />
              <span class="st">{{ s.title }}</span>
              <span class="sd">{{ STEP_LABEL[s.status] }}</span>
            </li>
          </ol>

          <!-- T-071：系统提示（重试等） -->
          <p v-for="(n, i) in notices" :key="i" class="run-note">{{ n }}</p>

          <!-- T-070：模型自主发起的工具调用 -->
          <div v-if="toolRuns.length" class="run-tools">
            <div class="rt-t">工具调用（{{ toolRuns.length }}）</div>
            <div v-for="t in toolRuns" :key="t.id" class="rt-item" :class="t.status">
              <button class="rt-h" :aria-expanded="t.open" @click="t.open = !t.open">
                <UIcon name="zap" :size="12" />
                <span class="rt-n">{{ t.name }}</span>
                <span class="rt-a">{{ t.args }}</span>
                <span class="rt-s">{{ t.status === 'running' ? '执行中' : t.status === 'ok' ? '成功' : '失败' }}</span>
                <!-- T-074：耗时与执行模式 -->
                <span v-if="t.elapsed != null" class="rt-ms" :title="t.mode === 'exclusive' ? '独占执行（不与其他工具并发）' : '并发执行'">{{ t.elapsed }}ms</span>
                <UIcon name="chevron-down" :size="11" />
              </button>
              <pre v-if="t.open" class="rt-o">{{ t.output || t.error || '（暂无输出）' }}</pre>
            </div>
          </div>

          <pre v-if="output" class="run-out">{{ output }}</pre>

          <div v-if="artifacts.length" class="run-arts">
            <div class="ra-t">产物（{{ artifacts.length }}）</div>
            <div v-for="a in artifacts" :key="a.id" class="ra-item">
              <UIcon name="book" :size="12" />
              <span class="ra-n">{{ a.name }}</span>
              <button
                class="ra-save" :disabled="savingArtifact === a.id"
                @click="saveArtifact(a)"
              >{{ savingArtifact === a.id ? '保存中…' : '保存到我的文件' }}</button>
            </div>
            <p v-if="artMsg" class="ra-msg">{{ artMsg }}</p>
          </div>

          <div v-if="phase === 'error'" class="run-err">
            <span class="er-msg">{{ errMsg }}</span>
            <button class="ap-btn primary" @click="retry">重试</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed; inset: 0; background: rgba(15, 17, 21, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 50;
  padding: 24px;
}
.modal {
  width: 520px; max-width: 100%; max-height: 86vh; overflow: auto;
  position: relative; padding: 0;
}
.modal-x { position: absolute; top: 12px; right: 12px; z-index: 2; color: #fff; background: rgba(0,0,0,0.18); }
.d-head { padding: 26px 22px 18px; color: #fff; }
.d-cat { display: inline-block; font-size: 11px; background: rgba(255,255,255,0.22); padding: 2px 8px; border-radius: 6px; }
.d-title { font-size: 19px; font-weight: 700; margin-top: 10px; }
.d-body { padding: 18px 22px 22px; }
.d-loading { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--t2); }
.d-desc { font-size: 13.5px; line-height: 1.7; color: var(--t1); margin: 0; }
.d-prompt { margin-top: 14px; border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: var(--line-2); }
.dp-h { font-size: 11.5px; color: var(--t3); margin-bottom: 6px; }
.dp-t { margin: 0; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: var(--t1); }
.apply-btn {
  margin-top: 16px; width: 100%; height: 38px; border-radius: 9px;
  background: var(--violet); color: #fff; font-size: 13.5px; font-weight: 600;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.apply-btn:disabled { background: var(--violet-soft); cursor: default; }
.d-offline { margin: 8px 0 0; font-size: 11.5px; color: var(--orange); }

/* 执行面板（与 NewTaskView 同款样式） */
.run { margin-top: 16px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 10px; }
.run-head { display: flex; align-items: center; gap: 10px; }
.run-title { flex: 1; font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-badge { flex: none; height: 22px; padding: 0 9px; border-radius: 6px; font-size: 11.5px; background: var(--line-2); color: var(--t2); display: inline-flex; align-items: center; }
.run-badge.streaming, .run-badge.creating { background: var(--violet-bg); color: var(--violet); }
.run-badge.waiting { background: var(--orange-bg); color: var(--orange); }
.run-badge.done { background: var(--ok-bg); color: #0cb277; }
.run-badge.error { background: var(--err-bg); color: var(--err); }
.run-badge.cancelled { background: var(--orange-bg); color: var(--orange); }
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
.run-out { margin: 12px 0 0; max-height: 200px; overflow: auto; background: var(--line-2); border-radius: 8px; padding: 10px 12px; font-size: 12.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
.run-approve { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: #fff8ee; font-size: 12.5px; }
.run-approve .ap-msg { flex: 1; }
.ap-btn { height: 26px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); font-size: 12.5px; }
.ap-btn.primary { background: var(--violet); color: #fff; border-color: transparent; }
.run-arts { margin-top: 12px; border-top: 1px solid var(--line-2); padding-top: 10px; }
.ra-t { font-size: 11.5px; color: var(--t3); margin-bottom: 6px; }
.ra-item { display: flex; align-items: center; gap: 6px; font-size: 12.5px; padding: 3px 0; }
.ra-n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ra-save {
  flex: none; height: 22px; padding: 0 8px; border-radius: 6px; font-size: 11px;
  border: 1px solid var(--line); background: var(--panel); color: var(--t2);
}
.ra-save:hover:not(:disabled) { color: var(--violet); border-color: var(--violet); }
.ra-save:disabled { opacity: 0.5; cursor: default; }
.ra-msg { margin: 6px 0 0; font-size: 11.5px; color: var(--t3); }
.run-err { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: var(--err-bg); font-size: 12.5px; color: var(--err); }
.run-err .er-msg { flex: 1; }
</style>
