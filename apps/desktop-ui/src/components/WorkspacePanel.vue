<script setup lang="ts">
/**
 * T-089：工作区面板（文件树 + 预览）。
 *
 * 定位：**只读审阅**——看 agent 在工作区里到底动了哪些文件、内容是什么。
 * 不做编辑（要改请让它改，或去「我的文件」），这样也不必在这里再走一遍写文件的流程。
 */
import { computed, ref, watch } from 'vue';
import UIcon from './UIcon.vue';
import FileTree from './FileTree.vue';
import TerminalPanel from './TerminalPanel.vue';
import { useEscape } from '@/composables/useEscape';
import { bridgeAvailable } from '@/api/backend';
import { fetchFileContent, fetchFileRoots, fetchWorkspace, setWorkspaceRoot, type FilePreview, type TreeEntry } from '@/api/files';
import hljs from 'highlight.js/lib/common';

const open = defineModel<boolean>('open', { default: false });

const roots = ref<{ files: string; workspace: string } | null>(null);
const rootErr = ref('');
const which = ref<'workspace' | 'files' | 'terminal'>('workspace');
const root = computed(() => (which.value === 'files' ? roots.value?.files : roots.value?.workspace) || '');
const wsLocked = ref(false); // 部署层用环境变量钉死时禁止更换
const wsBusy = ref(false);

/** 更换工作区文件夹：Electron 走系统目录对话框，纯 web 预览退回手动输入。 */
async function changeWorkspace() {
  if (wsBusy.value || wsLocked.value) return;
  let folder = '';
  const g = window as unknown as { evawork?: { pickFolder?: () => Promise<string> } };
  if (g.evawork?.pickFolder) {
    folder = await g.evawork.pickFolder();
  } else {
    folder = window.prompt('输入要用作工作区的文件夹绝对路径', root.value) || '';
  }
  if (!folder) return;
  wsBusy.value = true;
  try {
    const r = await setWorkspaceRoot(folder);
    rootErr.value = '';
    pickErr.value = r.note || '已切换工作区';
    await loadRoots();
    preview.value = null; // 目录换了，旧预览不再有意义
  } catch (e) {
    pickErr.value = (e as Error).message || '切换失败';
  } finally {
    wsBusy.value = false;
  }
}

const preview = ref<FilePreview | null>(null);
const loading = ref(false);
const pickErr = ref('');

useEscape(() => (open.value = false));

async function loadRoots() {
  if (!bridgeAvailable()) {
    rootErr.value = '未连接后端';
    return;
  }
  try {
    roots.value = await fetchFileRoots();
    rootErr.value = '';
  } catch (e) {
    rootErr.value = (e as Error).message || '工作区路径获取失败';
  }
  try {
    wsLocked.value = (await fetchWorkspace()).locked;
  } catch {
    wsLocked.value = false; // 拿不到锁定状态就按可换处理，点了后端还会再拦一次
  }
}

async function pick(entry: TreeEntry) {
  if (entry.kind !== 'file') return;
  loading.value = true;
  pickErr.value = '';
  preview.value = null;
  try {
    preview.value = await fetchFileContent(entry.rel, root.value);
  } catch (e) {
    pickErr.value = (e as Error).message || '读取失败';
  } finally {
    loading.value = false;
  }
}

/** 预览高亮：能识别语言就用语言，识别不出就自动猜；都不是就退纯文本（转义后）。 */
const highlighted = computed(() => {
  const p = preview.value;
  if (!p || p.kind !== 'text' || !p.content) return '';
  const lang = (p.ext || '').replace(/^\./, '');
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(p.content, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(p.content).value;
  } catch {
    return p.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
});

function sizeOf(n: number): string {
  if (!n) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

watch(open, (v) => {
  if (v && !roots.value) void loadRoots();
});
</script>

<template>
  <div v-if="open" class="wp-mask" @click="open = false">
    <aside class="wp" role="dialog" aria-label="工作区文件" @click.stop>
      <header class="wp-head">
        <span class="wp-title"><UIcon name="folder" :size="14" /> 工作区文件</span>
        <div class="wp-tabs">
          <button :class="{ on: which === 'workspace' }" @click="which = 'workspace'; preview = null">工作区</button>
          <button :class="{ on: which === 'files' }" @click="which = 'files'; preview = null">我的文件</button>
          <button :class="{ on: which === 'terminal' }" @click="which = 'terminal'">终端</button>
        </div>
        <button class="wp-x" aria-label="关闭" @click="open = false"><UIcon name="x" :size="14" /></button>
      </header>

      <p v-if="rootErr" class="wp-err">{{ rootErr }}</p>

      <div v-if="which === 'terminal'" class="wp-term">
        <TerminalPanel :open="open && which === 'terminal'" />
      </div>

      <div v-else class="wp-body">
        <div class="wp-tree">
          <FileTree v-if="root" :key="root" :root="root" @pick="pick" />
          <p v-else class="wp-tip">正在获取目录…</p>
          <!-- 工作区根目录展示 + 更换入口（「我的文件」页签不提供） -->
          <div v-if="which === 'workspace' && root" class="ws-root">
            <span class="ws-path" :title="root">{{ root }}</span>
            <button class="ws-btn" :disabled="wsLocked || wsBusy" :title="wsLocked ? '已被环境变量钉死，无法修改' : '更换工作区文件夹'" @click="changeWorkspace">
              {{ wsBusy ? '切换中…' : '更换文件夹' }}
            </button>
          </div>
        </div>

        <div class="wp-view">
          <template v-if="loading"><p class="wp-tip">读取中…</p></template>
          <template v-else-if="pickErr"><p class="wp-err">{{ pickErr }}</p></template>
          <template v-else-if="preview">
            <div class="wp-meta">
              <span class="wp-name">{{ preview.name }}</span>
              <span class="wp-size">{{ sizeOf(preview.size) }}</span>
            </div>
            <!-- eslint-disable-next-line vue/no-v-html -- 高亮输出（highlight.js 转义后的 HTML） -->
            <pre v-if="preview.kind === 'text'" class="wp-code"><code class="hljs" v-html="highlighted" /></pre>
            <img v-else-if="preview.kind === 'image' && preview.b64" class="wp-img" :src="`data:image/*;base64,${preview.b64}`" :alt="preview.name" />
            <p v-else class="wp-tip">{{ preview.note || '该文件不是可预览的文本/图片（仅元信息）' }}</p>
            <p v-if="preview.truncated" class="wp-tip">内容过长，已截断预览</p>
          </template>
          <p v-else class="wp-tip">点左侧文件查看内容</p>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.wp-mask { position: fixed; inset: 0; z-index: 60; background: rgba(15, 17, 21, 0.35); display: flex; justify-content: flex-end; }
.wp {
  width: min(880px, 92vw); height: 100%; background: var(--bg); border-left: 1px solid var(--line);
  display: flex; flex-direction: column; box-shadow: -8px 0 24px rgba(15, 17, 21, 0.12);
}
.wp-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--line-2); }
.wp-title { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
.wp-tabs { display: flex; gap: 4px; margin-left: 8px; }
.wp-tabs button { height: 24px; padding: 0 10px; border-radius: 6px; font-size: 12px; color: var(--t2); }
.wp-tabs button.on { background: var(--line-2); color: var(--t1); }
.wp-x { margin-left: auto; color: var(--t2); padding: 4px; border-radius: 6px; }
.wp-x:hover { background: var(--line-2); color: var(--t1); }
.wp-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 300px 1fr; }
.wp-term { flex: 1; min-height: 0; display: flex; }
.wp-tree { border-right: 1px solid var(--line-2); min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.ws-root { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--line-2); }
.ws-path { flex: 1; min-width: 0; font-size: 11px; color: var(--t3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.ws-btn { flex: none; height: 22px; padding: 0 8px; border-radius: 6px; font-size: 11.5px; color: var(--t2); border: 1px solid var(--line-2); }
.ws-btn:hover:not(:disabled) { color: var(--t1); background: var(--line-2); }
.ws-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.wp-view { min-height: 0; overflow: auto; padding: 10px 12px; }
.wp-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.wp-name { font-size: 12.5px; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.wp-size { font-size: 11px; color: var(--t3); }
.wp-code {
  margin: 0; padding: 12px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  font-size: 12.5px; line-height: 1.7; overflow-x: auto;
}
.wp-img { max-width: 100%; border-radius: 8px; border: 1px solid var(--line); }
.wp-tip { margin: 12px 8px; font-size: 12px; color: var(--t3); }
.wp-err { margin: 10px 14px; font-size: 12px; color: var(--err); }
</style>
