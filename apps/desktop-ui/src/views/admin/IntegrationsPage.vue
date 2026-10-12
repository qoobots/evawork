<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import UIcon from '@/components/UIcon.vue';
import UAsync from '@/components/UAsync.vue';
import { bridgeAvailable, onBackend } from '@/api/backend';
import { bindIntegration, fetchIntegrations, type Integration } from '@/api/integrations';
import { useI18nStore } from '@/stores/i18n';

const i18nStore = useI18nStore();

/**
 * S-07：外部应用授权——**不再摆假开关**。
 *
 * 以前这一页有六个写死的应用（GitHub / Notion / Figma / Linear / Slack / Zotero），
 * 开关只往 KV 写一个布尔，既没有授权流程也没有消费方；而后端 `/api/integrations`
 * 返回的是另一份名单（飞书 / 企业微信 / 钉钉），两边数据集根本对不上。
 *
 * 现在：列表、可绑状态、原因全部来自后端同一份数据：
 *   - `oauth_ready=false` → 按钮禁用并显示后端给的**真实原因**与所需材料；
 *   - 点「去绑定」真的发 `POST /api/integrations/{id}/bind`，后端返回 501 未实现时
 *     把原因原样显示出来，不说成"失败，请重试"。
 */
const online = computed(() => bridgeAvailable());

const items = ref<Integration[]>([]);
const loading = ref(false);
const error = ref('');
const bindingId = ref('');
const msg = ref('');
const msgTone = ref<'err' | 'ok'>('err');

/** 后端给的 icon 名在前端图标集里不一定有（飞书/企微/钉钉都缺），缺了就退回通用图标。 */
const KNOWN = new Set(['github', 'globe', 'cloud', 'chat', 'doc', 'key', 'zap', 'book', 'palette']);
function iconOf(it: Integration): string {
  return KNOWN.has(it.icon) ? it.icon : 'globe';
}
function statusText(it: Integration): string {
  if (it.oauth_ready) return '可绑定';
  return it.status === 'soon' ? '待排期' : '未接入';
}

async function load() {
  if (!online.value) {
    items.value = [];
    error.value = '';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    items.value = (await fetchIntegrations()).items ?? [];
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function bind(it: Integration) {
  if (!it.oauth_ready || bindingId.value) return;
  bindingId.value = it.id;
  msg.value = '';
  try {
    const r = await bindIntegration(it.id);
    msgTone.value = 'ok';
    msg.value = r.bound ? i18nStore.t('「') + it.name + i18nStore.t('」已绑定') : i18nStore.t('「') + it.name + i18nStore.t('」未返回绑定状态');
    await load();
  } catch (e) {
    // 后端明确说"还没实现"（501）时 detail 是原因，照原样显示
    msgTone.value = 'err';
    msg.value = (e as Error).message;
  } finally {
    bindingId.value = '';
  }
}

onMounted(() => void load());
onBackend(() => void load());
</script>

<template>
  <div class="pg">
    <h1>{{ i18nStore.t('外部应用授权') }}</h1>
    <div class="hint">
      {{ i18nStore.t('授权后，AI 可在你确认的范围内调用这些应用。所有凭据仅保存在本机。') }}
    </div>

    <div v-if="!online" class="offline-tip">
      {{ i18nStore.t('未连接后端：无法读取授权状态（此前这里会用内存里的假开关冒充"已连接"）。') }}
    </div>

    <UAsync :loading="loading" :error="error" :hint="i18nStore.t('正在加载授权状态…')" @retry="load">
      <div v-if="!items.length && !loading" class="empty">{{ i18nStore.t('后端未返回任何可授权应用。') }}</div>
      <div v-else class="grid">
        <div v-for="it in items" :key="it.id" class="app">
          <div class="ic"><UIcon :name="iconOf(it)" :size="18" /></div>
          <div class="meta">
            <div class="nm">
              {{ it.name }}
              <span class="tag" :class="{ soon: !it.oauth_ready }">{{ i18nStore.t(statusText(it)) }}</span>
            </div>
            <div class="ds">{{ it.reason || i18nStore.t('暂无说明') }}</div>
            <div v-if="it.needs?.length" class="sc">{{ i18nStore.t('接入所需：') }}{{ it.needs.join('、') }}</div>
          </div>
          <button
            class="btn-bind"
            :disabled="!it.oauth_ready || bindingId === it.id"
            :title="it.oauth_ready ? i18nStore.t('绑定「') + it.name + i18nStore.t('」') : it.reason || i18nStore.t('尚未接入')"
            @click="bind(it)"
          >
            {{ bindingId === it.id ? i18nStore.t('绑定中…') : i18nStore.t('去绑定') }}
          </button>
        </div>
      </div>
    </UAsync>

    <p v-if="msg" class="note" :class="msgTone">{{ msg }}</p>
  </div>
</template>

<style scoped>
.pg h1 { font-size: 22px; margin-bottom: 6px; }
.hint { color: var(--ac-text-muted); font-size: 12px; margin-bottom: 18px; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.app {
  display: flex; align-items: flex-start; gap: 12px;
  background: var(--ac-panel); border: 1px solid var(--ac-border); border-radius: 12px; padding: 14px;
}
.ic {
  width: 38px; height: 38px; border-radius: 9px; flex: none; color: var(--ac-white);
  display: flex; align-items: center; justify-content: center;
  background: var(--ac-surface-2); border: 1px solid var(--ac-icon-ring);
}
.meta { flex: 1; min-width: 0; }
.nm { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.tag {
  font-size: 10px; font-weight: 500; padding: 1px 6px; border-radius: 5px;
  background: var(--ac-green-bg-soft); color: var(--ac-green);
}
.tag.soon { background: var(--ac-surface-2); color: var(--ac-text-muted); }
.ds { color: var(--ac-text-muted); font-size: 11.5px; margin-top: 3px; line-height: 1.6; }
.sc { color: var(--ac-text-muted); font-size: 10.5px; margin-top: 5px; font-family: ui-monospace, Menlo, Consolas, monospace; }
.btn-bind {
  flex: none; height: 26px; padding: 0 10px; border-radius: 7px; font-size: 12px;
  background: var(--ac-surface); color: var(--ac-text); border: 1px solid var(--ac-border);
}
.btn-bind:disabled { opacity: 0.5; cursor: not-allowed; }
.empty, .note { margin-top: 14px; font-size: 12px; color: var(--ac-text-muted); }
.note.err { color: var(--ac-red, #d9534f); }
.note.ok { color: var(--ac-green); }
.offline-tip {
  margin-bottom: 14px; padding: 8px 12px; border-radius: 8px;
  background: var(--ac-panel); border: 1px solid var(--ac-border); color: var(--ac-text-muted); font-size: 11.5px;
}
</style>
