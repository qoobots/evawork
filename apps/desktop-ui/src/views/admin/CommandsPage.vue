<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import UIcon from '@/components/UIcon.vue';
import UAsync from '@/components/UAsync.vue';
import { bridgeAvailable } from '@/api/backend';
import { fetchConsole, saveConsole } from '@/api/console';
import { useAsyncData } from '@/composables/useAsyncData';
import { useI18nStore } from '@/stores/i18n';

const i18nStore = useI18nStore();

interface Cmd {
  name: string;
  desc: string;
  builtin?: boolean;
}

// 内置命令固定存在，只持久化"自定义命令"
const BUILTIN: Cmd[] = [
  { name: 'review', desc: '对当前改动做一次完整代码评审', builtin: true },
  { name: 'commit', desc: '按 Conventional Commits 生成提交信息', builtin: true },
  { name: 'explain', desc: '解释选中代码片段的执行逻辑', builtin: true },
];
const LOCAL_DEFAULT: Cmd[] = [{ name: 'weekly', desc: '根据本周对话生成周报草稿' }];

const online = computed(() => bridgeAvailable());
const localCmds = ref<Cmd[]>([...LOCAL_DEFAULT]);

const {
  data: remoteCmds,
  loading,
  error,
  reload,
  run,
} = useAsyncData<Cmd[]>(() =>
  online.value ? fetchConsole<Cmd>('commands') : Promise.resolve(localCmds.value),
);

onMounted(() => void run());

const custom = computed<Cmd[]>(() =>
  online.value ? (remoteCmds.value ?? []) : localCmds.value,
);
const cmds = computed<Cmd[]>(() => [...BUILTIN, ...custom.value]);

const creating = ref(false);
const draft = ref({ name: '', desc: '' });

function nextList(name: string, desc: string, drop = false): Cmd[] {
  const rest = custom.value.filter((c) => c.name !== name);
  return drop ? rest : [...rest, { name, desc }];
}

async function save() {
  const name = draft.value.name.trim();
  if (!name) return;
  const next = nextList(name, draft.value.desc.trim());
  if (online.value) {
    try {
      await saveConsole('commands', next);
    } finally {
      void reload();
    }
  } else {
    localCmds.value = next;
  }
  draft.value = { name: '', desc: '' };
  creating.value = false;
}

async function remove(c: Cmd) {
  const next = nextList(c.name, '', true);
  if (online.value) {
    try {
      await saveConsole('commands', next);
    } finally {
      void reload();
    }
  } else {
    localCmds.value = next;
  }
}
</script>

<template>
  <div class="pg">
    <h1>{{ i18nStore.t('命令') }}</h1>
    <div class="panel">
      <div class="head-row">
        <div>
          <b>{{ i18nStore.t('自定义命令') }}</b>
          <div class="dim">{{ i18nStore.t('通过 /命令名 在对话中快速触发一段固定提示词。了解更多') }}</div>
        </div>
        <button class="btn-a" @click="creating = true"><UIcon name="plus" :size="12" /> {{ i18nStore.t('创建') }}</button>
      </div>

      <div v-if="creating" class="editor">
        <input v-model="draft.name" class="ipt" :placeholder="i18nStore.t('命令名，例如 weekly')" />
        <textarea v-model="draft.desc" :placeholder="i18nStore.t('命令内容：希望 AI 执行的步骤与输出格式')" />
        <div class="ops">
          <button class="btn-ghost" @click="creating = false">{{ i18nStore.t('取消') }}</button>
          <button class="btn-light" @click="save">{{ i18nStore.t('保存') }}</button>
        </div>
      </div>

      <div v-if="!online" class="offline-tip">
        {{ i18nStore.t('未连接后端：命令仅在本机内存生效，刷新即失效。') }}
      </div>

      <UAsync :loading="loading" :error="error" :hint="i18nStore.t('正在加载命令…')" @retry="reload">
        <div class="cmd-list">
          <div v-for="c in cmds" :key="c.name" class="cmd">
            <div class="cmd-main">
              <span class="slash">/{{ c.name }}</span>
              <span v-if="c.builtin" class="bi">{{ i18nStore.t('内置') }}</span>
              <div class="desc">{{ i18nStore.t(c.desc) }}</div>
            </div>
            <button v-if="!c.builtin" class="del" :title="i18nStore.t('删除')" @click="remove(c)">
              <UIcon name="x" :size="13" />
            </button>
          </div>
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
.btn-a {
  height: 28px; padding: 0 12px; border-radius: 7px; background: var(--ac-surface); color: var(--ac-text);
  font-size: 12px; display: inline-flex; align-items: center; gap: 5px;
}
.editor { margin-top: 14px; }
.ipt {
  width: 100%; height: 34px; background: var(--ac-surface-2); border: 1px solid var(--ac-border); border-radius: 9px;
  color: var(--ac-text); padding: 0 12px; font-size: 12.5px; outline: none; margin-bottom: 8px;
}
textarea {
  width: 100%; min-height: 90px; resize: vertical;
  background: var(--ac-surface-2); border: 1px solid var(--ac-border); border-radius: 10px;
  color: var(--ac-text); padding: 12px; font-size: 12.5px; outline: none;
}
textarea:focus, .ipt:focus { border-color: var(--ac-focus); }
.ops { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.btn-ghost { height: 28px; padding: 0 14px; border-radius: 7px; color: var(--ac-text-muted); font-size: 12px; }
.btn-light { height: 28px; padding: 0 16px; border-radius: 7px; background: var(--ac-btn-light); color: var(--ac-btn-light-fg); font-size: 12px; }
.cmd-list { margin-top: 14px; border-top: 1px solid var(--ac-border); }
.cmd { display: flex; align-items: flex-start; gap: 10px; padding: 12px 2px; border-bottom: 1px solid var(--ac-border-2); }
.cmd:last-child { border-bottom: none; }
.cmd-main { flex: 1; min-width: 0; }
.slash { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; color: var(--ac-green-soft); }
.bi { margin-left: 8px; font-size: 10.5px; color: var(--ac-text-muted); border: 1px solid var(--ac-toggle-off); border-radius: 5px; padding: 1px 5px; }
.desc { color: var(--ac-text-muted); font-size: 11.5px; margin-top: 4px; }
.del { color: var(--ac-text-muted-3); padding: 2px; }
.del:hover { color: var(--ac-danger-hover); }
.offline-tip {
  margin-top: 12px; padding: 8px 12px; border-radius: 8px;
  background: var(--ac-surface-2); color: var(--ac-text-muted); font-size: 11.5px;
}
</style>
