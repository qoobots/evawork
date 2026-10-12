<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { bridgeAvailable } from '@/api/backend';
import { fetchUsage, type UsageSummary } from '@/api/usage';
import { useI18nStore } from '@/stores/i18n';

const i18nStore = useI18nStore();

const online = computed(() => bridgeAvailable());

const days = ref(7);
const ranges = [
  { k: 1, label: '今天' },
  { k: 7, label: '7 天' },
  { k: 30, label: '30 天' },
];

const usage = ref<UsageSummary | null>(null);
const loading = ref(false);
const err = ref('');

async function load() {
  if (!online.value) {
    err.value = '';
    usage.value = null;
    return;
  }
  loading.value = true;
  err.value = '';
  try {
    usage.value = await fetchUsage(days.value);
  } catch (e) {
    err.value = (e as Error).message || i18nStore.t('用量加载失败');
    usage.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(days, load);

const maxCount = computed(() =>
  Math.max(1, ...((usage.value?.series || []).map((p) => p.count) as number[])),
);

function barHeight(n: number) {
  return `${Math.max(4, Math.round((n / maxCount.value) * 100))}%`;
}

</script>

<template>
  <div class="pg">
    <h1>{{ i18nStore.t('用量管理') }}</h1>
    <p class="sub">{{ i18nStore.t('企业内部员工使用：本页只记录使用量，不涉及积分、套餐与计费。') }}</p>

    <p v-if="!online" class="notice">
      {{ i18nStore.t('未连接后端：用量无法统计。接入后端后，下方数字全部来自本地任务库的真实统计。') }}
    </p>
    <p v-else-if="err" class="notice err">{{ err }}</p>

    <div class="panel">
      <div class="split">
        <div class="box">
          <small>{{ i18nStore.t('估算 token ') }}<i>{{ i18nStore.t('字符数/4') }}</i></small>
          <b>{{ usage ? usage.tokens.approx : '—' }}</b>
          <span v-if="usage?.tokens.estimated" class="tag-est">{{ i18nStore.t('估算值，非模型回传') }}</span>
        </div>
        <div class="box">
          <small>{{ i18nStore.t('任务数 / 产物数 ') }}<i>{{ days === 1 ? i18nStore.t('今天') : i18nStore.t('近 ') + days + i18nStore.t(' 天') }}</i></small>
          <b>{{ usage ? `${usage.tasks.total} / ${usage.artifacts}` : '—' }}</b>
          <span class="tag-est">{{ i18nStore.t('真实统计') }}</span>
        </div>
      </div>
    </div>

    <h2>{{ i18nStore.t('任务量趋势') }}</h2>
    <div class="panel">
      <div v-if="loading" class="dim">{{ i18nStore.t('正在统计…') }}</div>
      <div v-else-if="usage?.series?.length" class="chart">
        <div v-for="p in usage.series" :key="p.date" class="bar-wrap" :title="`${p.date}：${p.count}${i18nStore.t(' 个任务')}`">
          <div class="bar" :style="{ height: barHeight(p.count) }" />
          <span class="bar-x">{{ p.date.slice(5) }}</span>
        </div>
      </div>
      <div v-else class="dim">{{ i18nStore.t('该时间范围内没有任务') }}</div>
    </div>

    <div class="tabs-a">
      <b>{{ i18nStore.t('用量明细') }}</b>
      <div class="spacer" />
      <span class="seg-a">
        <i v-for="r in ranges" :key="r.k" :class="{ on2: days === r.k }" @click="days = r.k">{{ i18nStore.t(r.label) }}</i>
      </span>
    </div>
    <div class="panel" style="padding: 0">
      <table>
        <thead><tr><th>{{ i18nStore.t('时间') }}</th><th>{{ i18nStore.t('使用记录') }}</th><th>{{ i18nStore.t('模型名称') }}</th><th>{{ i18nStore.t('产品端') }}</th><th>{{ i18nStore.t('估算 token') }}</th></tr></thead>
        <tbody>
          <tr v-if="!usage?.usage_records?.length">
            <td colspan="5" class="empty-td">{{ i18nStore.t('暂无用量记录') }}</td>
          </tr>
          <tr v-for="(r, i) in (usage?.usage_records ?? [])" :key="i">
            <td>{{ r.time }}</td><td>{{ r.record }}</td>
            <td><span class="tag-a">{{ r.model }}</span></td><td>{{ r.product }}</td><td>{{ r.cost }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="foot-note">
      {{ i18nStore.t('说明：模型未回传 usage，token 为按文本量估算的量级参考；任务数、产物数与趋势为真实统计。') }}
    </p>
  </div>
</template>

<style scoped>
.pg h1 { font-size: 22px; }
.sub { color: var(--ac-text-muted); font-size: 12.5px; margin-top: 6px; }
.panel { background: var(--ac-panel); border: 1px solid var(--ac-border); border-radius: 12px; padding: 16px 18px; margin-top: 16px; }
.dim { color: var(--ac-text-muted); font-size: 12px; }
.split { display: flex; gap: 12px; margin-top: 16px; }
.box { flex: 1; background: var(--ac-surface-2); border-radius: 10px; padding: 12px 14px; }
.box small { color: var(--ac-text-muted); font-size: 11px; display: block; }
.box small i { float: right; font-style: normal; color: var(--ac-text-muted); }
.box b { font-size: 16px; display: block; margin-top: 6px; }
.tag-est { display: inline-block; margin-top: 6px; font-size: 10px; color: var(--ac-text-muted); background: var(--ac-surface-3); border-radius: 4px; padding: 1px 6px; }

.notice { margin-top: 14px; padding: 10px 14px; border-radius: 8px; background: var(--ac-surface-2); color: var(--ac-text-muted); font-size: 12px; }
.notice.err { background: var(--ac-error-bg); color: var(--ac-error); }

h2 { font-size: 14px; margin: 24px 0 10px; }
.chart { display: flex; align-items: flex-end; gap: 6px; height: 120px; }
.bar-wrap { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; }
.bar { width: 100%; max-width: 26px; background: var(--ac-blue); border-radius: 4px 4px 0 0; transition: height 0.2s ease; }
.bar-x { font-size: 9px; color: var(--ac-text-muted); margin-top: 4px; }

.tabs-a { display: flex; align-items: center; gap: 12px; margin: 22px 0 4px; font-size: 12.5px; color: var(--ac-text-muted); }
.spacer { flex: 1; }
.seg-a { display: inline-flex; background: var(--ac-surface-2); border-radius: 8px; padding: 3px; gap: 2px; }
.seg-a i { font-style: normal; font-size: 11.5px; padding: 3px 10px; border-radius: 6px; color: var(--ac-text-muted); cursor: pointer; }
.seg-a i.on2 { background: var(--ac-surface); color: var(--ac-white); }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; padding: 10px 14px; color: var(--ac-text-muted); font-weight: 500; border-bottom: 1px solid var(--ac-border); }
td { padding: 11px 14px; border-bottom: 1px solid var(--ac-surface-2); white-space: pre-line; }
.empty-td { text-align: center; color: var(--ac-text-muted); padding: 26px 0; }
.tag-a { background: var(--ac-surface); border-radius: 5px; padding: 2px 8px; font-size: 11px; }
.foot-note { margin-top: 12px; font-size:11.5px; color:var(--ac-text-muted); line-height:1.6; }
</style>
