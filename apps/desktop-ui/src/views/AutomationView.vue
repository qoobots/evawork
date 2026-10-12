<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import UIcon from '@/components/UIcon.vue';
import UToggle from '@/components/UToggle.vue';
import UAsync from '@/components/UAsync.vue';
import { automationConfigs, automationTemplates } from '@/data/mock';
import { bridgeAvailable } from '@/api/backend';
import {
  createAutomation,
  fetchAutomations,
  fetchAutomationRuns,
  patchAutomation,
  previewCron,
  removeAutomation,
  triggerAutomationTick,
  type AutomationItem,
  type AutomationRun,
  type CronPreview,
} from '@/api/automations';
import { useAsyncData } from '@/composables/useAsyncData';

const tab = ref<'done' | 'history' | 'tpl'>('done');
const online = computed(() => bridgeAvailable());
const bannerOn = ref(true); // 顶部提示条开关（本地状态）

// 离线兜底：沿用 mock，开关只在本机内存生效
const localToggles = ref<boolean[]>(automationConfigs.map((c) => c.on));
const offlineItems = computed<AutomationItem[]>(() =>
  automationConfigs.map((c, i) => ({
    id: `local-${i}`,
    title: c.title,
    product: c.product,
    schedule: c.schedule,
    interval_min: 1440,
    cron: '',
    enabled: localToggles.value[i],
    last_run: 0,
    next_run: 0,
    created_at: 0,
  })),
);

const {
  data: configs,
  loading: cfgLoading,
  error: cfgError,
  reload: reloadCfg,
  run: runCfg,
} = useAsyncData<AutomationItem[]>(() =>
  online.value ? fetchAutomations() : Promise.resolve(offlineItems.value),
);

const {
  data: runs,
  loading: runLoading,
  error: runError,
  reload: reloadRuns,
  run: runRuns,
} = useAsyncData<AutomationRun[]>(() =>
  online.value ? fetchAutomationRuns() : Promise.resolve([] as AutomationRun[]),
);

onMounted(() => {
  void runCfg();
  void runRuns();
});

// 新建：两种排期方式——cron（精确到分钟）与间隔分钟（简单）
const creating = ref(false);
const newTitle = ref('');
const newInterval = ref(60);
const newCron = ref('');
const useCron = ref(false);
const preview = ref<CronPreview | null>(null);
const createErr = ref('');

let previewTimer: ReturnType<typeof setTimeout> | null = null;

/** 边写边预览：存之前就看见"会什么时候跑"，别等存完才发现永不触发。 */
watch([newCron, useCron], () => {
  preview.value = null;
  createErr.value = '';
  if (!useCron.value || !newCron.value.trim()) return;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      preview.value = await previewCron(newCron.value.trim());
    } catch (e) {
      createErr.value = (e as Error).message || '预览失败';
    }
  }, 300);
});

async function submitCreate() {
  const title = newTitle.value.trim();
  if (!title) return;
  const cron = useCron.value ? newCron.value.trim() : '';
  if (useCron.value && !cron) return;
  createErr.value = '';
  try {
    await createAutomation(
      cron ? { title, cron } : { title, interval_min: Number(newInterval.value) || 60 },
    );
    newTitle.value = '';
    newCron.value = '';
    preview.value = null;
    creating.value = false;
  } catch (e) {
    // 表达式不合法 / 永不触发：后端把原因放在 detail，原样给用户看
    createErr.value = (e as Error).message || '创建失败';
  } finally {
    void reloadCfg();
  }
}

async function toggle(item: AutomationItem, on: boolean) {
  if (!online.value) {
    const i = Number(String(item.id).replace('local-', ''));
    if (!Number.isNaN(i)) localToggles.value[i] = on;
    return;
  }
  try {
    await patchAutomation(item.id, { enabled: on });
  } finally {
    void reloadCfg();
  }
}

async function remove(item: AutomationItem) {
  if (!online.value) return;
  try {
    await removeAutomation(item.id);
  } finally {
    void reloadCfg();
  }
}

async function runNow() {
  await triggerAutomationTick();
  void reloadRuns();
}

function fmtTime(ts: number) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <div class="page auto">
    <div class="page-head">
      <div>
        <h1 class="page-title">自动化</h1>
        <div class="page-sub">配置和管理自动化任务，让 EvaWork 按计划执行工作流。</div>
      </div>
      <div style="display: flex; gap: 10px">
        <button class="btn" @click="creating = !creating">手动新建</button>
        <button class="btn btn-dark" data-coming aria-disabled="true" title="在对话中创建功能开发中，敬请期待"><UIcon name="chat" :size="13" /> 在对话中创建</button>
      </div>
    </div>

    <div class="seg" style="margin-top: 22px">
      <button class="seg-item" :class="{ active: tab === 'done' }" @click="tab = 'done'">已配置</button>
      <button class="seg-item" :class="{ active: tab === 'history' }" @click="tab = 'history'">执行历史</button>
      <button class="seg-item" :class="{ active: tab === 'tpl' }" @click="tab = 'tpl'">任务模板</button>
    </div>

    <!-- 已配置 -->
    <template v-if="tab === 'done'">
      <div v-if="creating" class="create-row card">
        <input v-model="newTitle" class="input" placeholder="任务标题，如：每日 AI 简报" />
        <select v-model="useCron" class="input cron-mode">
          <option :value="false">间隔分钟</option>
          <option :value="true">cron 表达式</option>
        </select>
        <template v-if="useCron">
          <input v-model="newCron" class="input cron-ipt" placeholder="分 时 日 月 周，如 0 9 * * 1 = 每周一 09:00" />
        </template>
        <template v-else>
          <span class="muted small">间隔</span>
          <input v-model.number="newInterval" class="input" type="number" min="1" style="width: 88px" />
          <span class="muted small">分钟</span>
        </template>
        <button class="btn btn-dark" @click="submitCreate">保存</button>
        <button class="btn" @click="creating = false">取消</button>
      </div>
      <div v-if="creating && useCron" class="cron-preview">
        <template v-if="preview?.ok">
          <span class="tag tag-blue">{{ preview.describe }}</span>
          <span class="muted small">
            接下来：{{ (preview.next ?? []).map(fmtTime).join(' · ') }}
          </span>
        </template>
        <span v-else-if="preview && !preview.ok" class="err small">{{ preview.detail }}</span>
        <span v-else class="muted small">支持 5 段 cron（`*/15 * * * *`= 每 15 分钟，日与周同时给定取并集）</span>
      </div>
      <p v-if="createErr" class="err small" style="margin-top: 8px">{{ createErr }}</p>
      <div v-if="!online" class="offline-tip">
        未连接后端：以下为示例配置，开关仅在本机内存生效，刷新即失效。
      </div>

      <UAsync :loading="cfgLoading" :error="cfgError" hint="正在加载自动化配置…" @retry="reloadCfg">
        <div class="banner card">
          <span class="b-dot" />
          本地任务在行【商品舆情周报】时运行
          <button class="btn-plain" style="margin-left: auto">暂存周报提醒</button>
          <UToggle v-model="bannerOn" label="切换顶部提示条" />
        </div>
        <div v-for="c in (configs ?? [])" :key="c.id" class="row-card">
          <UIcon name="cloud" :size="16" class="muted" />
          <div class="cfg-info">
            <span class="cfg-title">{{ c.title }}</span>
            <span class="tag tag-blue">{{ c.product }}</span>
            <span v-if="c.cron" class="tag tag-cron" :title="`cron: ${c.cron}`">{{ c.cron }}</span>
          </div>
          <span class="cfg-schedule muted small">
            {{ c.schedule }}
            <template v-if="c.error"><br /><span class="err">{{ c.error }}</span></template>
            <template v-else-if="c.enabled"><br />下次 {{ fmtTime(c.next_run) }}</template>
          </span>
          <div class="cfg-ops">
            <button class="icon-btn" aria-label="更多操作"><UIcon name="dots" :size="14" /></button>
            <button class="icon-btn" aria-label="设置自动化"><UIcon name="gear" :size="14" /></button>
            <UToggle :model-value="c.enabled" :label="`启用或停用『${c.title}』自动化`" @update:model-value="(v: boolean) => toggle(c, v)" />
            <button class="icon-btn" aria-label="删除自动化" @click="remove(c)"><UIcon name="x" :size="14" /></button>
          </div>
        </div>
      </UAsync>
    </template>

    <!-- 执行历史 -->
    <template v-else-if="tab === 'history'">
      <UAsync :loading="runLoading" :error="runError" hint="正在加载执行历史…" @retry="reloadRuns">
        <div v-if="!(runs ?? []).length" class="empty">
          <div class="empty-icon"><UIcon name="clock" :size="20" /></div>
          <div>暂无执行历史</div>
          <div class="small" style="color: var(--t3)">配置自动化任务后，执行记录会显示在这里</div>
        </div>
        <template v-else>
          <div class="hist-head">
            <button class="btn" @click="runNow"><UIcon name="zap" :size="13" /> 立即执行一次</button>
          </div>
          <div v-for="r in runs" :key="r.id" class="row-card">
            <UIcon name="clock" :size="16" class="muted" />
            <div class="cfg-info">
              <span class="cfg-title">{{ r.title }}</span>
              <span class="tag" :class="r.status === 'success' ? 'tag-blue' : 'tag-gray'">
                {{ r.status }}
              </span>
              <span v-if="r.message" class="muted small">{{ r.message }}</span>
            </div>
            <span class="cfg-schedule muted small">{{ fmtTime(r.started_at) }}</span>
            <span class="muted small">task: {{ r.task_id }}</span>
          </div>
        </template>
      </UAsync>
    </template>

    <!-- 任务模板 -->
    <template v-else>
      <div class="grid3 tpl-grid">
        <div v-for="t in automationTemplates" :key="t.title" class="tpl-card card">
          <div class="tpl-icon"><span class="ti-dots"><i /><i /><i /></span></div>
          <div class="tpl-title">{{ t.title }}</div>
          <div class="tpl-desc">{{ t.desc }}</div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.banner { display: flex; align-items: center; gap: 10px; padding: 12px 16px; margin: 20px 0 12px; font-size: 13px; background: #eef0fd; border-color: #dcdcf7; }
.b-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--violet); }
.cfg-info { display: flex; align-items: center; gap: 8px; flex: 1; }
.cfg-title { font-size: 13.5px; font-weight: 600; }
.cfg-ops { display: flex; align-items: center; gap: 6px; }
.tpl-grid { margin-top: 20px; }
.tpl-card { padding: 18px; }
.tpl-icon { width: 46px; height: 46px; border-radius: 10px; background: var(--line-2); display: flex; align-items: center; justify-content: center; }
.ti-dots { display: flex; gap: 3px; }
.ti-dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--t3); }
.ti-dots i:first-child { background: var(--green); }
.tpl-title { font-size: 14px; font-weight: 600; margin-top: 14px; }
.tpl-desc { font-size: 12px; color: var(--t2); margin-top: 6px; line-height: 1.6; }

/* 新建行 / 离线提示 / 执行历史表头 */
.create-row {
  display: flex; align-items: center; gap: 10px;
  margin-top: 18px; padding: 12px 14px;
}
.create-row .input { flex: 1; min-width: 0; }
.create-row .cron-mode { flex: none; width: 130px; }
.create-row .cron-ipt { font-family: ui-monospace, Menlo, Consolas, monospace; }
/* cron 预览：把"多久跑一次、下次几点"直接摆在输入框下面 */
.cron-preview { margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tag-cron {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  color: var(--t2, #6b7280); background: var(--line-2, #f3f4f6);
}
.err { color: var(--ac-danger, #e5484d); }
.offline-tip {
  margin-top: 14px; padding: 8px 12px; border-radius: 8px;
  background: var(--line-2); color: var(--t2); font-size: 12px;
}
.hist-head { margin-top: 18px; display: flex; gap: 8px; }
</style>
