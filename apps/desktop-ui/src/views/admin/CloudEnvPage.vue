<script setup lang="ts">
import { onMounted, ref } from 'vue';
import UIcon from '@/components/UIcon.vue';
import { bridgeAvailable, onBackend } from '@/api/backend';
import { fetchFileRoots } from '@/api/files';
import { useI18nStore } from '@/stores/i18n';

const i18nStore = useI18nStore();

/**
 * S-16：云端运行环境——**决策结果：整节下线，不留 mock**。
 *
 * 以前这一页列的是 `data/mock` 里写死的"运行时版本"，配额也是三个写死的进度条
 * （并发 3/5、62.4/200 小时、4.1/20 GB）。本地版根本没有云端沙箱：任务就在
 * **你本机的工作区**里执行，那些数字没有任何东西在统计，属于纯误导。
 *
 * 现在如实说明执行位置，并把**真的**那个信息摆出来：当前工作区目录。
 * 真接入云环境时再按端点填回来，不用先拿 mock 占位置。
 */
const wsRoot = ref('');
const loading = ref(false);

async function load() {
  if (!bridgeAvailable()) {
    wsRoot.value = '';
    return;
  }
  loading.value = true;
  try {
    wsRoot.value = (await fetchFileRoots()).workspace || '';
  } catch {
    wsRoot.value = '';
  } finally {
    loading.value = false;
  }
}
onMounted(() => void load());
onBackend(() => void load());
</script>

<template>
  <div class="pg">
    <h1>{{ i18nStore.t('云端运行环境') }}</h1>
    <div class="hint">
      {{ i18nStore.t('本地版没有云端沙箱：任务在你') }}<b>{{ i18nStore.t('本机的沙箱工作区') }}</b>{{ i18nStore.t('内执行，不经过云端，也没有配额可统计。') }}
    </div>

    <div class="panel">
      <div class="p-head">
        <div>
          <b>{{ i18nStore.t('执行位置') }}</b>
          <div class="dim">{{ i18nStore.t('每个任务在自己的工作目录里跑，受工作区根目录约束。') }}</div>
        </div>
      </div>
      <div class="root">
        <UIcon name="folder" :size="14" />
        <span v-if="wsRoot">{{ wsRoot }}</span>
        <span v-else-if="loading">{{ i18nStore.t('读取中…') }}</span>
        <span v-else>{{ i18nStore.t('未连接后端，无法读取工作区路径') }}</span>
      </div>
      <div class="dim" style="margin-top: 8px">{{ i18nStore.t('路径可在「设置 → 通用 → 自定义产物存储路径」里更改。') }}</div>
    </div>

    <div class="panel">
      <b>{{ i18nStore.t('云端沙箱') }}</b>
      <div class="empty">
        {{ i18nStore.t('尚未提供：没有云端环境列表，也没有配额统计。') }}<br />
        {{ i18nStore.t('因此这里不显示任何"运行时版本 / 已用配额"——那些数字此前是写死的，对不上真账。') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.pg h1 { font-size: 22px; margin-bottom: 6px; }
.hint { color: var(--ac-text-muted); font-size: 12px; margin-bottom: 18px; }
.panel { background: var(--ac-panel); border: 1px solid var(--ac-border); border-radius: 12px; padding: 16px 18px; margin-bottom: 14px; }
.p-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
.p-head b, .panel > b { font-size: 13.5px; }
.dim { color: var(--ac-text-muted); font-size: 11.5px; margin-top: 4px; line-height: 1.6; }
.root {
  display: flex; align-items: center; gap: 8px; font-size: 12px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  background: var(--ac-surface-4); border: 1px solid var(--ac-border); border-radius: 8px; padding: 10px 12px;
  word-break: break-all;
}
.empty { color: var(--ac-text-muted); font-size: 11.5px; line-height: 1.7; margin-top: 10px; }
</style>
