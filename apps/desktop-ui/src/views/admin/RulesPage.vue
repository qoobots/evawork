<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import UIcon from '@/components/UIcon.vue';
import UAsync from '@/components/UAsync.vue';
import { bridgeAvailable } from '@/api/backend';
import { fetchConsole, saveConsole } from '@/api/console';
import { useAsyncData } from '@/composables/useAsyncData';
import { useI18nStore } from '@/stores/i18n';

const i18nStore = useI18nStore();

interface Rule {
  id: string;
  content: string;
  created_at?: number;
}

const online = computed(() => bridgeAvailable());
const localRules = ref<Rule[]>([]);

const {
  data: rules,
  loading,
  error,
  reload,
  run,
} = useAsyncData<Rule[]>(() =>
  online.value ? fetchConsole<Rule>('rules') : Promise.resolve(localRules.value),
);

onMounted(() => void run());

const current = computed<Rule[]>(() =>
  online.value ? (rules.value ?? []) : localRules.value,
);

const editing = ref(false);
const text = ref('');

function newRule(content: string): Rule {
  return { id: `r-${Date.now()}`, content, created_at: Math.floor(Date.now() / 1000) };
}

async function add() {
  const content = text.value.trim();
  if (!content) return;
  const next = [...current.value, newRule(content)];
  if (online.value) {
    try {
      await saveConsole('rules', next);
    } finally {
      void reload();
    }
  } else {
    localRules.value = next;
  }
  text.value = '';
  editing.value = false;
}

async function removeRule(id: string) {
  const next = current.value.filter((r) => r.id !== id);
  if (online.value) {
    try {
      await saveConsole('rules', next);
    } finally {
      void reload();
    }
  } else {
    localRules.value = next;
  }
}
</script>

<template>
  <div class="pg">
    <h1>{{ i18nStore.t('规则') }}</h1>
    <div class="panel">
      <div class="head-row">
        <div>
          <b>{{ i18nStore.t('规则') }}</b>
          <div class="dim">{{ i18nStore.t('创建并管理规则，在聊天过程中遵循这些规则。了解更多') }}</div>
        </div>
        <button class="btn-a" @click="editing = true"><UIcon name="plus" :size="12" /> {{ i18nStore.t('创建') }}</button>
      </div>

      <div v-if="!online" class="offline-tip">
        {{ i18nStore.t('未连接后端：规则仅在本机内存生效，刷新即失效。') }}
      </div>

      <div v-if="editing" class="editor">
        <textarea v-model="text" :placeholder="i18nStore.t('风格要求、回答语言......')" />
        <div class="ops">
          <button class="btn-ghost" @click="editing = false">{{ i18nStore.t('取消') }}</button>
          <button class="btn-light" @click="add">{{ i18nStore.t('保存') }}</button>
        </div>
      </div>

      <UAsync :loading="loading" :error="error" :hint="i18nStore.t('正在加载规则…')" @retry="reload">
        <div class="rule-list">
          <div v-for="r in current" :key="r.id" class="rule">
            <div class="rule-body">{{ r.content }}</div>
            <button class="del" :title="i18nStore.t('删除')" @click="removeRule(r.id)">
              <UIcon name="x" :size="13" />
            </button>
          </div>
          <div v-if="!current.length" class="empty">{{ i18nStore.t('暂无规则') }}</div>
        </div>
      </UAsync>
    </div>
  </div>
</template>

<style scoped>
.pg h1 { font-size: 22px; margin-bottom: 16px; }
.panel { background: var(--ac-panel); border: 1px solid var(--ac-border); border-radius: 12px; padding: 16px 18px; }
.head-row { display: flex; justify-content: space-between; align-items: flex-start; }
.head-row b { font-size: 13.5px; }
.dim { color: var(--ac-text-muted); font-size: 11.5px; margin-top: 4px; }
.btn-a { height: 28px; padding: 0 12px; border-radius: 7px; background: var(--ac-surface); color: var(--ac-text); font-size: 12px; display: inline-flex; align-items: center; gap: 5px; }
.editor { margin-top: 14px; }
textarea {
  width: 100%; min-height: 110px; resize: vertical;
  background: var(--ac-surface-2); border: 1px solid var(--ac-border); border-radius: 10px;
  color: var(--ac-text); padding: 12px; font-size: 12.5px; outline: none;
}
textarea:focus { border-color: var(--ac-focus); }
.ops { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.btn-ghost { height: 28px; padding: 0 14px; border-radius: 7px; color: var(--ac-text-muted); font-size: 12px; }
.btn-light { height: 28px; padding: 0 16px; border-radius: 7px; background: var(--ac-btn-light); color: var(--ac-btn-light-fg); font-size: 12px; }
.rule-list { margin-top: 14px; border-top: 1px solid var(--ac-border); }
.rule { display: flex; align-items: flex-start; gap: 10px; padding: 12px 2px; border-bottom: 1px solid var(--ac-border-2); }
.rule:last-child { border-bottom: none; }
.rule-body { flex: 1; min-width: 0; font-size: 12.5px; color: var(--ac-text); white-space: pre-wrap; line-height: 1.6; }
.del { color: var(--ac-text-muted); padding: 2px; }
.del:hover { color: var(--ac-danger-hover); }
.empty { padding: 24px 0; text-align: center; color: var(--ac-text-muted); font-size: 12px; }
.offline-tip {
  margin-top: 12px; padding: 8px 12px; border-radius: 8px;
  background: var(--ac-surface-2); color: var(--ac-text-muted); font-size: 11.5px;
}
</style>
