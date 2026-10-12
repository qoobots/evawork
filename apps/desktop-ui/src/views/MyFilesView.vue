<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import UIcon from '@/components/UIcon.vue';
import UAsync from '@/components/UAsync.vue';
import { fileTypes } from '@/data/mock';
import { bridgeAvailable } from '@/api/backend';
import {
  fetchFileContent,
  fetchFiles,
  writeFileContent,
  type FileItem,
  type FilePreview,
  type FileScan,
} from '@/api/files';
import { useAsyncData } from '@/composables/useAsyncData';
import { useEscape } from '@/composables/useEscape';
import { useI18nStore } from '@/stores/i18n';

const i18n = useI18nStore();

const tab = ref('local');
const type = ref('全部');
const asGrid = ref(true);
const keyword = ref('');

const online = computed(() => bridgeAvailable());

// 搜索防抖
const kw = ref('');
let kwTimer: ReturnType<typeof setTimeout> | undefined;
watch(keyword, (v) => {
  if (kwTimer) clearTimeout(kwTimer);
  kwTimer = setTimeout(() => {
    kw.value = v;
  }, 300);
});

const params = computed(() => ({ tab: tab.value, type: type.value, q: kw.value }));
const {
  data,
  loading,
  error,
  reload,
  run,
} = useAsyncData<FileScan>(() => {
  // 云端 / 飞书 未接入；本地也仅在连上后端时扫描
  if (!online.value || tab.value !== 'local') {
    return Promise.resolve({
      root: '',
      items: [],
      total: 0,
      truncated: false,
      skipped: 0,
      types: fileTypes,
    });
  }
  return fetchFiles({ q: kw.value.trim(), type: type.value });
}, [params]);

onMounted(() => void run());

const items = computed(() => data.value?.items ?? []);
const types = computed(() => data.value?.types ?? fileTypes);
const isPlaceholder = computed(() => tab.value === 'cloud' || tab.value === 'feishu');

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(t: number) {
  return new Date(t * 1000).toLocaleString('zh-CN', { hour12: false });
}

/* ---------- T-035：打开文件 → 预览 / 编辑保存 ---------- */
const preview = ref<FilePreview | null>(null);
const previewLoading = ref(false);
const previewErr = ref('');
const draft = ref('');
const saving = ref(false);
const savedMsg = ref('');

const canSave = computed(
  () => preview.value?.kind === 'text' && draft.value !== (preview.value.content ?? ''),
);

async function openFile(f: FileItem) {
  // 先占位再加载，弹层不会闪；失败也留在弹层里说明原因
  preview.value = null;
  previewErr.value = '';
  savedMsg.value = '';
  draft.value = '';
  previewLoading.value = true;
  try {
    const p = await fetchFileContent(f.path);
    preview.value = p;
    draft.value = p.content ?? '';
  } catch (e) {
    previewErr.value = (e as Error).message || '打开失败';
    preview.value = {
      kind: 'binary',
      name: f.name,
      path: f.path,
      ext: f.ext,
      type: f.type,
      size: f.size,
      mtime: f.mtime,
      truncated: false,
      content: '',
    };
  } finally {
    previewLoading.value = false;
  }
}

function closePreview() {
  preview.value = null;
  previewErr.value = '';
  draft.value = '';
}

// T-053：Esc 关闭文件预览
useEscape(() => {
  if (preview.value) closePreview();
});

async function saveDraft() {
  if (!preview.value || !canSave.value || saving.value) return;
  saving.value = true;
  previewErr.value = '';
  try {
    const res = await writeFileContent(preview.value.path, draft.value);
    preview.value = { ...preview.value, content: draft.value, size: res.size };
    savedMsg.value = '已保存到本地文件';
    setTimeout(() => (savedMsg.value = ''), 2000);
    await reload();
  } catch (e) {
    previewErr.value = (e as Error).message || '保存失败';
  } finally {
    saving.value = false;
  }
}

</script>

<template>
  <div class="page files">
    <div class="page-head">
      <div>
        <h1 class="page-title">{{ i18n.t('page.files.title') }}</h1>
        <div class="page-sub">{{ i18n.t('page.files.sub') }}</div>
      </div>
    </div>

    <div class="tab-row">
      <div class="seg">
        <button class="seg-item" :class="{ active: tab === 'local' }" @click="tab = 'local'"><UIcon name="monitor" :size="12" /> 本地</button>
        <button class="seg-item" :class="{ active: tab === 'cloud' }" @click="tab = 'cloud'"><UIcon name="cloud" :size="12" /> 云端</button>
        <button class="seg-item" :class="{ active: tab === 'feishu' }" @click="tab = 'feishu'"><UIcon name="book" :size="12" /> 飞书</button>
      </div>
      <div class="spacer" />
      <div class="search-box input" style="width: 200px">
        <UIcon name="search" :size="13" style="color: var(--t3)" />
        <input v-model="keyword" placeholder="搜索文件..." style="border: none; outline: none; width: 100%; font-size: 12.5px; background: none" />
      </div>
    </div>

    <div class="chips-row">
      <button v-for="t in types" :key="t" class="chip" :class="{ active: type === t }" @click="type = t">{{ t }}</button>
    </div>

    <div class="chips-row" style="margin-top: 10px">
      <button class="icon-btn" aria-label="筛选文件"><UIcon name="filter" :size="14" /></button>
      <button class="icon-btn" :class="{ 'on-grid': asGrid }" aria-label="网格视图" :aria-pressed="asGrid" @click="asGrid = !asGrid"><UIcon name="grid" :size="14" /></button>
      <button class="icon-btn" :class="{ 'on-grid': !asGrid }" aria-label="列表视图" :aria-pressed="!asGrid"><UIcon name="list" :size="14" /></button>
    </div>

    <div v-if="!online" class="offline-tip">
      未连接后端：无法扫描本地文件。
    </div>

    <!-- 云端 / 飞书：占位，未接入 -->
    <div v-if="isPlaceholder" class="empty">
      <div class="empty-icon"><UIcon name="cloud" :size="20" /></div>
      <div class="empty-t">{{ tab === 'cloud' ? '云端' : '飞书' }}文件尚未接入</div>
      <div class="empty-d">当前仅支持扫描「本地」文件</div>
    </div>

    <UAsync v-else :loading="loading" :error="error" hint="正在扫描文件…" @retry="reload">
      <div v-if="!items.length" class="empty">
        <div class="empty-icon"><UIcon name="doc" :size="20" /></div>
        <div class="empty-t">还没有文件</div>
        <div class="empty-d">
          {{ data?.root ? `已扫描：${data.root}（未匹配到文件）` : '你创建的文件都会显示在这里' }}
        </div>
      </div>

      <!-- 网格视图 -->
      <div v-else-if="asGrid" class="f-grid">
        <div v-for="f in items" :key="f.path" class="f-card card" :title="`${f.path}（点击打开）`" @click="openFile(f)">
          <div class="f-ic"><UIcon name="doc" :size="18" /></div>
          <div class="f-name">{{ f.name }}</div>
          <div class="f-meta">{{ f.type }} · {{ fmtSize(f.size) }}</div>
          <div class="f-time">{{ fmtTime(f.mtime) }}</div>
        </div>
      </div>

      <!-- 列表视图 -->
      <div v-else class="f-list">
        <div v-for="f in items" :key="f.path" class="f-row clickable" :title="f.path" @click="openFile(f)">
          <UIcon name="doc" :size="14" class="muted" />
          <span class="f-name">{{ f.name }}</span>
          <span class="f-type">{{ f.type }}</span>
          <span class="f-size">{{ fmtSize(f.size) }}</span>
          <span class="f-time">{{ fmtTime(f.mtime) }}</span>
        </div>
      </div>

      <div v-if="data?.truncated" class="trunc-tip">
        文件较多，仅展示前 {{ items.length }} 个（共 {{ data.total }}），可用搜索缩小范围。
      </div>
    </UAsync>

    <!-- T-035：文件预览 / 编辑保存 -->
    <div v-if="preview" class="modal-mask" @click.self="closePreview">
      <div class="modal card">
        <button class="modal-x icon-btn" @click="closePreview"><UIcon name="x" :size="15" /></button>
        <div class="pv-head">
          <div class="pv-title">{{ preview.name }}</div>
          <p class="pv-sub">{{ fmtSize(preview.size) }} · {{ fmtTime(preview.mtime) }}</p>
          <p class="pv-path">{{ preview.path }}</p>
        </div>

        <div class="pv-body">
          <div v-if="previewLoading" class="pv-hint"><span class="spin" /> 正在读取文件…</div>
          <p v-else-if="previewErr" class="pv-err">{{ previewErr }}</p>

          <img v-else-if="preview.kind === 'image' && preview.b64" class="pv-img" :src="`data:image/*;base64,${preview.b64}`" :alt="preview.name" />

          <template v-else-if="preview.kind === 'text'">
            <p v-if="preview.truncated" class="pv-warn">文件较大，仅预览前 {{ Math.floor(512 * 1024 / 1024) }} KB。</p>
            <textarea v-model="draft" class="pv-text" spellcheck="false" />
            <div class="pv-foot">
              <span v-if="savedMsg" class="pv-ok">{{ savedMsg }}</span>
              <span v-else class="pv-note">改动后保存会写回本地文件（仅文本文件可写）</span>
              <button class="pv-btn" :disabled="!canSave || saving" @click="saveDraft">
                {{ saving ? '保存中…' : canSave ? '保存修改' : '无修改' }}
              </button>
            </div>
          </template>

          <p v-else class="pv-hint">{{ preview.note || '该文件类型暂不支持预览' }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tab-row { display: flex; align-items: center; margin-top: 20px; }
.spacer { flex: 1; }
.chips-row { display: flex; gap: 8px; align-items: center; }
.icon-btn.on-grid { background: var(--active-bg); color: var(--t1); }
.empty { margin-top: 40px; }
.empty-t { font-size: 14px; font-weight: 600; color: var(--t1); }
.empty-d { font-size: 12px; }

/* 文件网格 / 列表 */
.f-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 18px; }
.f-card { padding: 14px; cursor: pointer; }
.f-card:hover { border-color: var(--t3); }
.f-ic {
  width: 38px; height: 38px; border-radius: 9px; background: var(--line-2);
  display: flex; align-items: center; justify-content: center; color: var(--t2);
}
.f-name { font-size: 12.5px; font-weight: 500; margin-top: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.f-meta { font-size: 11.5px; color: var(--t2); margin-top: 4px; }
.f-time { font-size: 11px; color: var(--t3); margin-top: 2px; }
.f-list { margin-top: 18px; display: flex; flex-direction: column; }
.f-row {
  display: flex; align-items: center; gap: 12px; padding: 10px 4px;
  border-bottom: 1px solid var(--line-2); font-size: 12.5px;
}
.f-row .f-name { flex: 1; margin-top: 0; }
.f-type { width: 56px; color: var(--t2); }
.f-size { width: 84px; color: var(--t2); }
.f-time { width: 150px; color: var(--t3); font-size: 11.5px; }
.f-row.clickable { cursor: pointer; border-radius: 6px; }
.f-row.clickable:hover { background: var(--line-2); }
.offline-tip { margin-top: 14px; padding: 8px 12px; border-radius: 8px; background: var(--line-2); color: var(--t2); font-size: 12px; }
.trunc-tip { margin-top: 14px; font-size: 11.5px; color: var(--t3); }

/* T-035：预览 / 编辑弹层 */
.modal-mask {
  position: fixed; inset: 0; background: rgba(15, 17, 21, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 50; padding: 24px;
}
.modal { width: 640px; max-width: 100%; max-height: 88vh; overflow: auto; position: relative; padding: 0; }
.modal-x { position: absolute; top: 12px; right: 12px; z-index: 2; }
.pv-head { padding: 18px 22px 12px; background: var(--line-2); border-bottom: 1px solid var(--line); }
.pv-title { font-size: 15px; font-weight: 700; padding-right: 28px; word-break: break-all; }
.pv-sub { margin: 6px 0 0; font-size: 11.5px; color: var(--t3); }
.pv-path { margin: 4px 0 0; font-size: 11px; color: var(--t3); word-break: break-all; }
.pv-body { padding: 16px 22px 22px; }
.pv-hint { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--t2); }
.pv-err { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--err-bg); color: var(--err); font-size: 12.5px; word-break: break-word; }
.pv-warn { margin: 0 0 8px; font-size: 11.5px; color: var(--orange); }
.pv-img { max-width: 100%; max-height: 320px; border-radius: 8px; border: 1px solid var(--line-2); display: block; margin: 0 auto; }
.pv-text {
  width: 100%; height: 280px; resize: vertical; padding: 10px 12px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--panel); color: var(--t1);
  font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.6;
}
.pv-foot { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.pv-note { flex: 1; font-size: 11.5px; color: var(--t3); }
.pv-ok { flex: 1; font-size: 11.5px; color: var(--ok); }
.pv-btn {
  flex: none; height: 30px; padding: 0 14px; border-radius: 8px; font-size: 12.5px;
  background: var(--violet); color: #fff;
}
.pv-btn:disabled { background: var(--violet-soft); cursor: default; }
.spin {
  width: 12px; height: 12px; border-radius: 50%; flex: none;
  border: 2px solid var(--line); border-top-color: var(--violet); animation: pv-spin 0.7s linear infinite;
}
@keyframes pv-spin { to { transform: rotate(360deg); } }
</style>
