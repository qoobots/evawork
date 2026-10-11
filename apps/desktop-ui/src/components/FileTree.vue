<script setup lang="ts">
/**
 * T-089：文件树（懒加载）。
 *
 * 两个刻意的取舍：
 * - **按层取，不一次扫到底**：一次灌整棵树既慢又会撞后端上限；
 *   展开哪个目录才取哪个目录（后端 `GET /api/files/tree` 只列一层）。
 * - **拿不到就如实说**：根不存在/越界/没后端都要给出原因，不能显示一棵空树假装"没有文件"。
 */
import { ref, watch } from 'vue';
import UIcon from './UIcon.vue';
import { fetchFileTree, type TreeEntry } from '@/api/files';

const props = defineProps<{ root: string }>();
const emit = defineEmits<{ (e: 'pick', entry: TreeEntry): void }>();

interface Node {
  entry: TreeEntry;
  open: boolean;
  loading: boolean;
  children: Node[];
  error: string;
}

const nodes = ref<Node[]>([]);
const err = ref('');
const loading = ref(false);

function wrap(e: TreeEntry): Node {
  return { entry: e, open: false, loading: false, children: [], error: '' };
}

async function load(path: string): Promise<Node[]> {
  const level = await fetchFileTree(path, props.root);
  return level.entries.map(wrap);
}

async function reload() {
  if (!props.root) {
    err.value = '未知的工作区路径';
    nodes.value = [];
    return;
  }
  loading.value = true;
  err.value = '';
  try {
    nodes.value = await load('');
  } catch (e) {
    err.value = (e as Error).message || '目录读取失败';
    nodes.value = [];
  } finally {
    loading.value = false;
  }
}

async function toggle(node: Node) {
  if (node.entry.kind !== 'dir') {
    emit('pick', node.entry);
    return;
  }
  if (node.open) {
    node.open = false;
    return;
  }
  node.open = true;
  if (node.children.length || node.loading) return;
  node.loading = true;
  node.error = '';
  try {
    node.children = await load(node.entry.rel);
  } catch (e) {
    node.error = (e as Error).message || '读取失败';
  } finally {
    node.loading = false;
  }
}

function iconOf(e: TreeEntry): string {
  if (e.kind === 'dir') return 'folder';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(e.ext)) return 'image';
  if (['md', 'txt', 'doc', 'docx', 'pdf'].includes(e.ext)) return 'book';
  if (['xls', 'xlsx', 'csv'].includes(e.ext)) return 'table';
  return 'doc';
}

function sizeOf(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

watch(() => props.root, () => void reload(), { immediate: true });
defineExpose({ reload });
</script>

<template>
  <div class="ft">
    <div class="ft-bar">
      <span class="ft-root" :title="root">{{ root || '（未选择根目录）' }}</span>
      <button class="ft-refresh" aria-label="刷新文件树" :disabled="loading" @click="reload">
        <UIcon name="refresh" :size="12" />
      </button>
    </div>

    <p v-if="loading && !nodes.length" class="ft-tip">正在读取…</p>
    <p v-else-if="err" class="ft-tip err">{{ err }}</p>
    <p v-else-if="!nodes.length" class="ft-tip">该目录下没有可显示的文件</p>

    <ul v-else class="ft-list">
      <li v-for="n in nodes" :key="n.entry.rel" class="ft-node">
        <button class="ft-row" :aria-expanded="n.entry.kind === 'dir' ? n.open : undefined" @click="toggle(n)">
          <UIcon v-if="n.entry.kind === 'dir'" :name="n.open ? 'chevron-down' : 'chevron-right'" :size="11" class="ft-arrow" />
          <span v-else class="ft-arrow" />
          <UIcon :name="iconOf(n.entry)" :size="12" class="ft-ic" />
          <span class="ft-name">{{ n.entry.name }}</span>
          <span v-if="n.entry.kind === 'file'" class="ft-size">{{ sizeOf(n.entry.size) }}</span>
        </button>
        <p v-if="n.error" class="ft-sub err">{{ n.error }}</p>
        <p v-else-if="n.loading" class="ft-sub">读取中…</p>
        <ul v-else-if="n.open && n.children.length" class="ft-list sub">
          <li v-for="c in n.children" :key="c.entry.rel" class="ft-node">
            <button class="ft-row" @click="toggle(c)">
              <UIcon v-if="c.entry.kind === 'dir'" :name="c.open ? 'chevron-down' : 'chevron-right'" :size="11" class="ft-arrow" />
              <span v-else class="ft-arrow" />
              <UIcon :name="iconOf(c.entry)" :size="12" class="ft-ic" />
              <span class="ft-name">{{ c.entry.name }}</span>
              <span v-if="c.entry.kind === 'file'" class="ft-size">{{ sizeOf(c.entry.size) }}</span>
            </button>
          </li>
        </ul>
        <p v-else-if="n.open && !n.children.length && !n.loading" class="ft-sub">（空目录）</p>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.ft { display: flex; flex-direction: column; min-height: 0; }
.ft-bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px 8px; border-bottom: 1px solid var(--line-2); }
.ft-root {
  flex: 1; font-size: 11px; color: var(--t3); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ft-refresh { color: var(--t2); display: inline-flex; padding: 3px; border-radius: 5px; }
.ft-refresh:hover { background: var(--line-2); color: var(--t1); }
.ft-tip { margin: 10px 8px; font-size: 11.5px; color: var(--t3); }
.ft-tip.err, .ft-sub.err { color: var(--err); }
.ft-list { list-style: none; margin: 0; padding: 4px 0; overflow: auto; }
.ft-list.sub { padding: 0 0 0 14px; }
.ft-row {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 8px;
  font-size: 12.5px; color: var(--t1); border-radius: 6px; text-align: left;
}
.ft-row:hover { background: var(--line-2); }
.ft-arrow { flex: none; width: 11px; color: var(--t3); }
.ft-ic { flex: none; color: var(--t2); }
.ft-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ft-size { flex: none; font-size: 10.5px; color: var(--t3); }
.ft-sub { margin: 2px 0 4px 26px; font-size: 11px; color: var(--t3); }
</style>
