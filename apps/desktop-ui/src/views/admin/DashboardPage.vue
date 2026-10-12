<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import UIcon from '@/components/UIcon.vue';
import { bridgeAvailable, onBackend } from '@/api/backend';
import { fetchUsage, type UsageSummary } from '@/api/usage';
import { useAccountStore } from '@/stores/account';
import { useI18nStore } from '@/stores/i18n';

const i18nStore = useI18nStore();

/**
 * S-17：仪表盘接**真数据**（`GET /api/usage`）。
 *
 * 以前这一页整屏都是编的：热力图是固定种子的伪随机、"第 54 天"、对话次数 4、
 * "@ Agent"、"@ Doubao-Seed-Code" 全是写死常量。看着热闹，一个数字都对不上真账
 * —— 用户照着它判断"我用了多少"必然被误导。
 *
 * 现在每个数字都来自本地任务库：活跃天数按最早任务算、热力图按每日真实任务数着色、
 * 模型偏好取统计里调用最多的那个。拿不到数据就显示"未连接后端/暂无记录"，
 * 绝不用随机数补位（随机补位比空白更坏：空白用户知道没数据，随机用户以为有）。
 */
const account = useAccountStore();
const usage = ref<UsageSummary | null>(null);
const loading = ref(false);
const error = ref('');

async function load() {
  if (!bridgeAvailable()) {
    error.value = '';
    usage.value = null;
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    usage.value = await fetchUsage(365);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
// 称呼要用真账号名（没加载过就补一次），否则这里会永远显示"未登录"
onMounted(() => {
  if (!account.loaded) void account.load().catch(() => undefined);
  void load();
});
onBackend(() => void load());

/** 日期 → 当天任务数（后端 series 里含 0 的日子都补齐了） */
const countByDay = computed(() => {
  const m = new Map<string, number>();
  for (const p of usage.value?.series ?? []) m.set(p.date, p.count);
  return m;
});

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 最早有任务的那天 → 今天是第几天（没任务就是 0，界面据此说"还没有记录"） */
const activeDays = computed(() => {
  for (const p of usage.value?.series ?? []) {
    if (p.count > 0) {
      const start = new Date(`${p.date}T00:00:00`);
      const now = new Date();
      const diff = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
        Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000);
      return diff + 1;
    }
  }
  return 0;
});

/**
 * 热力图：53 周 × 7 天，最后一列是本周（未来几天留白，不画成"没活动"）。
 * -1 = 未来（透明）；其余按当天任务数分档。
 */
const WEEKS = 53;
const cells = computed(() => {
  const today = new Date();
  const dow = today.getDay(); // 0=周日 … 6=周六：格子的行号即星期
  const start = new Date(today);
  start.setDate(start.getDate() - (WEEKS - 1) * 7 - dow);
  const out: { level: number; date: string }[] = [];
  for (let i = 0; i < WEEKS * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = dayKey(d);
    if (d > today) {
      out.push({ level: -1, date: key });
      continue;
    }
    const c = countByDay.value.get(key) ?? 0;
    out.push({ level: c === 0 ? 0 : c === 1 ? 1 : c <= 3 ? 2 : 3, date: key });
  }
  return out;
});

/** 月份标签：每列（周）取该周第一天的月份，与上一个月不同才显示 */
const months = computed(() => {
  const labels: string[] = [];
  let last = '';
  for (let w = 0; w < WEEKS; w++) {
    const c = cells.value[w * 7];
    const m = c ? new Date(`${c.date}T00:00:00`).getMonth() : -1;
    const name = m < 0 ? '' : `${m + 1}${i18nStore.t('月')}`;
    labels.push(name && name !== last ? name : '');
    if (name) last = name;
  }
  return labels;
});

const color = (l: number) =>
  ['var(--ac-heat-0)', 'var(--ac-heat-1)', 'var(--ac-heat-2)', 'var(--ac-green)'][Math.max(0, l)];

/** 调用最多的模型（并列时取字典序靠前的那个，保证同一份数据每次显示一致） */
const topModel = computed(() => {
  const by = usage.value?.tasks?.by_model ?? {};
  const entries = Object.entries(by).filter(([k]) => k && k !== 'unknown');
  if (!entries.length) return '';
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries[0][0];
});

const totalTasks = computed(() => usage.value?.tasks?.total ?? 0);
const artifacts = computed(() => usage.value?.artifacts ?? 0);
const runs = computed(() => usage.value?.automation_runs?.total ?? 0);
</script>

<template>
  <div class="pg">
    <h1>Hello! {{ account.displayName }}</h1>
    <p class="sub">
      <template v-if="activeDays > 0">{{ i18nStore.t('这是你使用 EvaWork 的第 ') }}{{ activeDays }}{{ i18nStore.t(' 天') }}</template>
      <template v-else>{{ i18nStore.t('还没有任务记录：发一条任务，这里就开始有数') }}</template>
    </p>
    <div class="tags">
      <span class="tag-d"># {{ i18nStore.t('近一年 ') }}{{ totalTasks }}{{ i18nStore.t(' 个任务') }}</span>
      <span class="tag-d"># {{ artifacts }}{{ i18nStore.t(' 个产物') }}</span>
      <span class="tag-d"># {{ runs }}{{ i18nStore.t(' 次自动化运行') }}</span>
    </div>

    <div v-if="!bridgeAvailable()" class="empty">{{ i18nStore.t('未连接后端，无法读取用量数据。') }}</div>
    <div v-else-if="loading" class="empty">{{ i18nStore.t('正在读取用量…') }}</div>
    <div v-else-if="error" class="empty">{{ error }}</div>

    <div class="panel">
      <div class="ph">{{ i18nStore.t('EvaWork 活跃天数（每日任务数）') }}</div>
      <div class="months"><span v-for="(m, i) in months" :key="i">{{ m }}</span></div>
      <div class="heat">
        <span
          v-for="(c, i) in cells"
          :key="i"
          class="cell"
          :style="{ background: c.level < 0 ? 'transparent' : color(c.level) }"
          :title="c.level < 0 ? '' : `${c.date}：${countByDay.get(c.date) ?? 0}${i18nStore.t(' 个任务')}`"
        />
      </div>
      <div class="legend">
        Less
        <i class="cell" style="background:var(--ac-heat-0)" /><i class="cell" style="background:var(--ac-heat-1)" /><i class="cell" style="background:var(--ac-heat-2)" /><i class="cell" style="background:var(--ac-green)" />
        More
      </div>

      <div class="stats">
        <div class="stat">
          <div class="dim">{{ i18nStore.t('近一年任务数') }}</div>
          <div class="st-v">{{ totalTasks }}<br /><span class="unit">{{ i18nStore.t('个') }}</span></div>
        </div>
        <div class="stat">
          <div class="dim">{{ i18nStore.t('近一年产物数') }}</div>
          <div class="st-v">{{ artifacts }}<br /><span class="unit">{{ i18nStore.t('个') }}</span></div>
        </div>
        <div class="stat">
          <div class="dim">{{ i18nStore.t('token（估算）') }} <UIcon name="info" :size="10" :title="usage?.tokens?.method" /></div>
          <div class="st-v">{{ usage?.tokens?.approx ?? '—' }}</div>
          <div class="bar-wrap">
            <span class="bar-l"><UIcon name="chat" :size="10" /> {{ i18nStore.t('字符数 ') }}{{ usage?.tokens?.chars ?? 0 }}{{ i18nStore.t(' ÷ 4') }}</span>
          </div>
        </div>
        <div class="stat">
          <div class="dim">{{ i18nStore.t('自动化运行次数') }}</div>
          <div class="st-v">{{ runs }}<br /><span class="unit">{{ i18nStore.t('次') }}</span></div>
        </div>
      </div>
      <div class="note">{{ i18nStore.t('token 为估算值：本地模型不回传 usage，按「字符数 ÷ 4」粗估，仅供量级参考。') }}</div>
    </div>

    <div class="two">
      <div class="panel center">
        <div class="ph">{{ i18nStore.t('近期模型调用偏好') }}</div>
        <div class="big-ic round"><UIcon name="sparkle" :size="22" /></div>
        <div class="dim">{{ topModel || i18nStore.t('暂无模型调用记录') }}</div>
      </div>
      <div class="panel center">
        <div class="ph">{{ i18nStore.t('近期最佳拍档') }}</div>
        <div class="big-ic"><UIcon name="chat" :size="22" /></div>
        <div class="dim">@ {{ i18nStore.t('EvaWork 智能体') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pg h1 { font-size: 22px; }
.sub { color: var(--ac-text-muted); font-size: 12.5px; margin-top: 6px; }
.tags { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.tag-d { background: var(--ac-green-bg-soft); color: var(--ac-green); border-radius: 6px; padding: 3px 9px; font-size: 11px; }
.panel { background: var(--ac-panel); border: 1px solid var(--ac-border); border-radius: 12px; padding: 18px; margin-top: 18px; }
.center { text-align: center; }
.ph { font-size: 13px; display: flex; align-items: center; gap: 5px; }
.months { display: grid; grid-template-columns: repeat(53, 1fr); color: var(--ac-text-muted); font-size: 9px; margin-top: 16px; }
.heat { display: grid; grid-template-rows: repeat(7, 9px); grid-auto-flow: column; grid-auto-columns: 9px; gap: 2px; margin-top: 6px; overflow: hidden; }
.cell { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.legend { display: flex; align-items: center; gap: 4px; justify-content: flex-end; color: var(--ac-text-muted); font-size: 10px; margin-top: 10px; }
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; margin-top: 22px; border-top: 1px solid var(--ac-border); padding-top: 18px; }
.st-v { font-size: 20px; font-weight: 700; margin-top: 8px; }
.unit { font-size: 11px; font-weight: 400; color: var(--ac-text-muted); }
.dim { color: var(--ac-text-muted); font-size: 12px; display: flex; align-items: center; gap: 4px; }
.center .dim { justify-content: center; }
.bar-wrap { margin-top: 10px; }
.bar-l { font-size: 11px; color: var(--ac-text-soft); display: inline-flex; align-items: center; gap: 4px; }
.note { margin-top: 14px; font-size: 11px; color: var(--ac-text-muted); }
.empty { margin-top: 16px; font-size: 12px; color: var(--ac-text-muted); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.big-ic { width: 52px; height: 52px; border-radius: 14px; background: var(--ac-green-bg-soft); color: var(--ac-green); display: flex; align-items: center; justify-content: center; margin: 18px auto 10px; }
.big-ic.round { border-radius: 50%; background: var(--ac-surface-2); color: var(--ac-text); }
</style>
