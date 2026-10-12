<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import UIcon from '@/components/UIcon.vue';
import UAsync from '@/components/UAsync.vue';
import { bridgeAvailable } from '@/api/backend';
import {
  createMCPServer,
  deleteMCPServer,
  discoverMCPTools,
  fetchMCPServers,
  patchMCPServer,
  type MCPTool,
  type MCPServer,
} from '@/api/plugins';
import { useAsyncData } from '@/composables/useAsyncData';
import { useI18nStore } from '@/stores/i18n';

const i18nStore = useI18nStore();

/* T-031：MCP 管理页真正对接后端 /api/mcp/servers —— 这里的增删启停会真实注册/握手到 MCP 桥，
   而不是把元数据塞进 console 键。无后端时退化为内存里的临时列表（刷新即失效，明确告知）。 */
const online = computed(() => bridgeAvailable());
const localServers = ref<MCPServer[]>([]);
const actErr = ref('');
const busyId = ref('');
const toolsOf = ref<Record<string, MCPTool[]>>({});

const {
  data: servers,
  loading,
  error,
  reload,
  run,
} = useAsyncData<MCPServer[]>(() =>
  online.value ? fetchMCPServers() : Promise.resolve(localServers.value),
);

onMounted(() => void run());

const keyword = ref('');
const adding = ref(false);
/** T-093：三种传输。stdio 填命令，http/sse 填地址。 */
const TRANSPORTS = [
  { value: 'stdio', label: 'stdio（本地进程）', ph: '启动命令（如 npx -y @modelcontextprotocol/server-filesystem）' },
  { value: 'http', label: 'http（Streamable）', ph: '服务地址（如 http://127.0.0.1:8000/mcp）' },
  { value: 'sse', label: 'sse（旧版双通道）', ph: '服务地址（如 https://xxx.example.com/sse）' },
] as const;
const draft = ref({ name: '', transport: 'stdio' as 'stdio' | 'http' | 'sse', target: '', args: '' });
const transportTip = computed(
  () => TRANSPORTS.find((t) => t.value === draft.value.transport)?.ph ?? '',
);
const needsUrl = computed(() => draft.value.transport !== 'stdio');

const list = computed<MCPServer[]>(() => servers.value ?? []);
const filtered = computed<MCPServer[]>(() => {
  const k = keyword.value.trim().toLowerCase();
  if (!k) return list.value;
  return list.value.filter((s) => (s.name + (s.command || '') + (s.url || '')).toLowerCase().includes(k));
});

/** 一行描述："连的是谁"——stdio 看命令，http/sse 看地址。 */
function connLabel(s: MCPServer) {
  if (s.transport === 'stdio') {
    return s.command + ((s.args || []).length ? ` ${s.args.join(' ')}` : '');
  }
  return `${s.transport || 'http'} · ${s.url || i18nStore.t('（未填地址）')}`;
}

async function add() {
  const name = draft.value.name.trim();
  const target = draft.value.target.trim();
  if (!name || !target) return;
  actErr.value = '';
  const transport = draft.value.transport;
  try {
    if (online.value) {
      await createMCPServer(
        transport === 'stdio'
          ? { name, transport, command: target, args: draft.value.args.trim().split(/\s+/).filter(Boolean) }
          : { name, transport, url: target },
      );
      await reload();
    } else {
      localServers.value = [
        ...localServers.value,
        {
          id: name,
          name,
          command: transport === 'stdio' ? target : '',
          args: transport === 'stdio' ? draft.value.args.trim().split(/\s+/).filter(Boolean) : [],
          url: transport === 'stdio' ? '' : target,
          transport,
          source: 'user',
          enabled: true,
        },
      ];
    }
    draft.value = { name: '', transport: 'stdio', target: '', args: '' };
    adding.value = false;
  } catch (e) {
    // 后端握手失败（如命令不存在/连不上）会把真实原因放在 detail，原样展示
    actErr.value = (e as Error).message || i18nStore.t('添加失败');
  }
}

async function removeMcp(id: string) {
  actErr.value = '';
  if (online.value) {
    try {
      await deleteMCPServer(id);
    } finally {
      void reload();
    }
  } else {
    localServers.value = localServers.value.filter((s) => s.id !== id);
  }
}

async function toggle(id: string, enabled: boolean) {
  if (!online.value) return;
  busyId.value = id;
  actErr.value = '';
  try {
    await patchMCPServer(id, { enabled });
    await reload();
  } catch (e) {
    actErr.value = (e as Error).message || i18nStore.t('操作失败');
  } finally {
    busyId.value = '';
  }
}

async function discover(id: string) {
  busyId.value = id;
  actErr.value = '';
  try {
    const r = await discoverMCPTools(id);
    toolsOf.value = { ...toolsOf.value, [id]: r.tools || [] };
  } catch (e) {
    toolsOf.value = { ...toolsOf.value, [id]: [] };
    actErr.value = (e as Error).message || i18nStore.t('发现工具失败');
  } finally {
    busyId.value = '';
  }
}
</script>

<template>
  <div class="pg">
    <h1>MCP</h1>
    <div class="hint">{{ i18nStore.t('已添加的 MCP Server 会作为工具提供给 AI，按需要手动启用。') }}</div>

    <div class="panel">
      <div class="p-head">
        <div class="search">
          <UIcon name="search" :size="13" />
          <input v-model="keyword" :placeholder="i18nStore.t('搜索 MCP Server')" />
        </div>
        <button class="btn-a" @click="adding = !adding"><UIcon name="plus" :size="12" /> {{ i18nStore.t('添加 Server') }}</button>
      </div>

      <div v-if="adding" class="add-row">
        <input v-model="draft.name" class="ipt" :placeholder="i18nStore.t('名称（如 filesystem）')" />
        <select v-model="draft.transport" class="ipt sel">
          <option v-for="t in TRANSPORTS" :key="t.value" :value="t.value">{{ i18nStore.t(t.label) }}</option>
        </select>
        <input v-model="draft.target" class="ipt" :placeholder="i18nStore.t(transportTip)" />
        <input v-if="!needsUrl" v-model="draft.args" class="ipt" :placeholder="i18nStore.t('参数（空格分隔，可选）')" />
        <button class="btn-a" :disabled="!draft.name.trim() || !draft.target.trim()" @click="add">{{ i18nStore.t('保存') }}</button>
        <button class="btn-ghost" @click="adding = false">{{ i18nStore.t('取消') }}</button>
      </div>
      <div v-if="adding" class="crontab-tip">
        {{ needsUrl
          ? i18nStore.t('http / sse 走网络服务：地址须以 http(s):// 开头，保存时会真的握手列工具（连不上就不会入库）。')
          : i18nStore.t('stdio 走本地进程：保存时会真的启动一次握手列工具（命令不存在就不会入库）。') }}
      </div>

      <div v-if="!online" class="offline-tip">
        {{ i18nStore.t('未连接后端：添加仅在本机内存生效，不会真正注册到 MCP 桥，刷新即失效。') }}
      </div>
      <p v-if="actErr" class="offline-tip" style="color: var(--ac-danger, #e5484d)">{{ actErr }}</p>

      <UAsync :loading="loading" :error="error" :hint="i18nStore.t('正在加载 MCP Server…')" @retry="reload">
        <div class="rows">
          <div v-for="s in filtered" :key="s.id" class="row">
            <div class="ic"><UIcon name="box" :size="16" /></div>
            <div class="meta">
              <div class="nm">{{ s.name }}</div>
              <div class="ds">{{ connLabel(s) }}</div>
              <div v-if="toolsOf[s.id]?.length" class="tools">
                <span v-for="t in toolsOf[s.id]" :key="t.name" class="tool">{{ t.name }}</span>
              </div>
            </div>
            <span class="state" :class="{ off: !s.enabled }">{{ s.enabled ? i18nStore.t('已连接') : i18nStore.t('已停用') }}</span>
            <button class="del" :disabled="busyId === s.id" :title="i18nStore.t('发现工具')" @click="discover(s.id)">{{ i18nStore.t('工具') }}</button>
            <button class="del" :disabled="busyId === s.id" :title="s.enabled ? i18nStore.t('停用') : i18nStore.t('启用')" @click="toggle(s.id, !s.enabled)">
              {{ s.enabled ? i18nStore.t('停用') : i18nStore.t('启用') }}
            </button>
            <button class="del" :title="i18nStore.t('移除')" @click="removeMcp(s.id)"><UIcon name="x" :size="13" /></button>
          </div>
          <div v-if="!filtered.length" class="empty">{{ i18nStore.t('没有匹配的 MCP Server') }}</div>
        </div>
      </UAsync>
    </div>
  </div>
</template>

<style scoped>
.pg h1 { font-size: 22px; margin-bottom: 6px; }
.hint { color: var(--ac-text-muted); font-size: 12px; margin-bottom: 18px; }
.panel { background: var(--ac-panel); border: 1px solid var(--ac-border); border-radius: 12px; padding: 16px 18px; }
.p-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.search {
  flex: 1; max-width: 320px; height: 32px; display: flex; align-items: center; gap: 7px;
  background: var(--ac-surface-2); border: 1px solid var(--ac-border); border-radius: 9px; padding: 0 11px; color: var(--ac-text-muted-3);
}
.search input { flex: 1; background: none; border: none; outline: none; color: var(--ac-text); font-size: 12.5px; }
.btn-a {
  height: 30px; padding: 0 12px; border-radius: 7px; background: var(--ac-surface); color: var(--ac-text);
  font-size: 12px; display: inline-flex; align-items: center; gap: 5px;
}
.rows { border-top: 1px solid var(--ac-border); }
.row { display: flex; align-items: center; gap: 11px; padding: 12px 2px; border-bottom: 1px solid var(--ac-border-2); }
.row:last-child { border-bottom: none; }
.ic {
  width: 34px; height: 34px; flex: none; border-radius: 9px; background: var(--ac-surface-2);
  border: 1px solid var(--ac-icon-border); display: flex; align-items: center; justify-content: center; color: var(--ac-text-muted-strong);
}
.meta { flex: 1; min-width: 0; }
.nm { font-size: 12.5px; }
.ds {
  color: var(--ac-text-muted); font-size: 11.5px; margin-top: 3px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.state { font-size: 11px; color: var(--ac-green-soft); }
.state.off { color: var(--ac-text-muted-3); }
.tools { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.tool {
  font-size: 10.5px; padding: 2px 7px; border-radius: 5px;
  background: var(--ac-surface-2); border: 1px solid var(--ac-border); color: var(--ac-text-muted-strong);
}
.more { color: var(--ac-text-muted-3); }
.empty { padding: 26px 0; text-align: center; color: var(--ac-text-muted-3); font-size: 12px; }
.add-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.add-row .ipt { flex: 1; min-width: 0; height: 32px; }
.add-row .sel { flex: none; width: 150px; }
.crontab-tip { margin: -6px 0 12px; color: var(--ac-text-muted-3); font-size: 11.5px; }
.ipt {
  background: var(--ac-surface-2); border: 1px solid var(--ac-border); border-radius: 9px;
  color: var(--ac-text); padding: 0 11px; font-size: 12.5px; outline: none;
}
.ipt:focus { border-color: var(--ac-focus); }
.btn-ghost { height: 30px; padding: 0 14px; border-radius: 7px; color: var(--ac-text-muted); font-size: 12px; }
.del { color: var(--ac-text-muted-3); padding: 2px; }
.del:hover { color: var(--ac-danger-hover); }
.offline-tip {
  margin-bottom: 12px; padding: 8px 12px; border-radius: 8px;
  background: var(--ac-surface-2); color: var(--ac-text-muted); font-size: 11.5px;
}
</style>
