<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import UIcon from '@/components/UIcon.vue';
import { designSystems as mockSystems } from '@/data/mock';
import { bridgeAvailable, onBackend } from '@/api/backend';
import {
  createDesignSystem,
  deleteDesignSystem,
  duplicateDesignSystem,
  fetchDesignSystems,
  type DesignDTO,
} from '@/api/design';
import { useEscape } from '@/composables/useEscape';
import { useI18nStore } from '@/stores/i18n';

const router = useRouter();
const i18n = useI18nStore();
const online = computed(() => bridgeAvailable());

/* ---------- T-010 + T-033：内置（只读）与自定义（可编辑）分开渲染 ---------- */
const builtin = ref<DesignDTO[]>([]);
const custom = ref<DesignDTO[]>([]);
const err = ref('');
const busyId = ref('');

async function load() {
  if (!online.value) return;
  try {
    const items = await fetchDesignSystems();
    builtin.value = items.filter((i) => i.source !== 'user');
    custom.value = items.filter((i) => i.source === 'user');
    err.value = '';
  } catch (e) {
    err.value = (e as Error).message || '设计资产加载失败';
  }
}

onMounted(load);
onBackend(load);

/** 内置区：有真实资产用真实资产，没有就用 mock 顶上（界面永不全白，但会标注来源）。 */
const builtinList = computed(() =>
  builtin.value.length
    ? builtin.value
    : mockSystems.map((m) => ({
        id: m.id,
        name: m.name,
        hue: m.hue,
        tokens: m.tokens ?? [],
        fonts: m.fonts,
        source: 'builtin' as const,
        origin: '',
      })),
);

async function duplicate(d: DesignDTO) {
  busyId.value = d.id;
  err.value = '';
  try {
    const copy = await duplicateDesignSystem(d.id);
    await load();
    router.push(`/design/${copy.id}`);
  } catch (e) {
    err.value = `「${d.name}」创建副本失败：${(e as Error).message}`;
  } finally {
    busyId.value = '';
  }
}

async function remove(d: DesignDTO) {
  busyId.value = d.id;
  err.value = '';
  try {
    await deleteDesignSystem(d.id);
    await load();
  } catch (e) {
    err.value = `「${d.name}」删除失败：${(e as Error).message}`;
  } finally {
    busyId.value = '';
  }
}

/* ---------- 新建自定义设计系统 ---------- */
const creating = ref(false);
const newName = ref('');
const newBase = ref('');
const createBusy = ref(false);
const createErr = ref('');

function openCreate() {
  creating.value = true;
  newName.value = '';
  newBase.value = builtinList.value[0]?.id ?? '';
  createErr.value = '';
}

// T-053：Esc 关闭新建弹层
useEscape(() => {
  creating.value = false;
});

async function submitCreate() {
  if (!newName.value.trim() || createBusy.value) return;
  createBusy.value = true;
  createErr.value = '';
  try {
    await createDesignSystem(newName.value.trim(), newBase.value);
    creating.value = false;
    await load();
  } catch (e) {
    createErr.value = (e as Error).message || '创建失败';
  } finally {
    createBusy.value = false;
  }
}

function cardLink(d: DesignDTO) {
  return `/design/${encodeURIComponent(d.id)}`;
}
</script>

<template>
  <div class="page ds">
    <div class="page-head">
      <div>
        <h1 class="page-title">{{ i18n.t('page.design.title') }}</h1>
        <div class="page-sub">{{ i18n.t('page.design.sub') }}</div>
      </div>
      <button class="btn btn-dark" :disabled="!online" :title="online ? '' : '未连接后端'" @click="openCreate">
        <UIcon name="plus" :size="13" /> 添加设计系统
      </button>
    </div>

    <p v-if="!online" class="tip">未连接后端：当前显示的是内置示例数据，创建副本与自定义均不可用。</p>
    <p v-if="err" class="tip err"><UIcon name="info" :size="13" /> {{ err }}</p>

    <div class="sec-t">内置</div>
    <div class="ds-grid">
      <router-link v-for="d in builtinList" :key="d.id" :to="cardLink(d)" class="ds-card card">
        <div class="ds-thumb" :style="{ background: '#f3f4f6' }">
          <div class="mini-bar" :style="{ background: d.hue }" />
          <div class="mini-side" />
          <div class="mini-body">
            <span class="mini-chip" :style="{ background: d.hue }" />
            <span class="mini-line" />
            <span class="mini-line short" />
          </div>
        </div>
        <div class="ds-meta">
          <span class="ds-name">
            <span class="ds-dot" :style="{ background: d.hue }" />{{ d.name }}
          </span>
          <button
            class="mini-btn" :disabled="!online || busyId === d.id"
            :title="online ? `创建「${d.name}」的副本` : '未连接后端'"
            @click.prevent.stop="duplicate(d)"
          >副本</button>
        </div>
      </router-link>
    </div>

    <div class="sec-t">自定义</div>
    <div v-if="custom.length" class="ds-grid">
      <router-link v-for="d in custom" :key="d.id" :to="cardLink(d)" class="ds-card card">
        <div class="ds-thumb" :style="{ background: '#f3f4f6' }">
          <div class="mini-bar" :style="{ background: d.hue }" />
          <div class="mini-side" />
          <div class="mini-body">
            <span class="mini-chip" :style="{ background: d.hue }" />
            <span class="mini-line" />
            <span class="mini-line short" />
          </div>
        </div>
        <div class="ds-meta">
          <span class="ds-name">
            <span class="ds-dot" :style="{ background: d.hue }" />{{ d.name }}
            <span class="tag-user">可编辑</span>
          </span>
          <button
            class="mini-btn danger" :disabled="busyId === d.id"
            @click.prevent.stop="remove(d)"
          >删除</button>
        </div>
      </router-link>
    </div>
    <div v-else class="empty custom-empty card">
      <div class="empty-icon"><UIcon name="palette" :size="20" /></div>
      <div class="empty-t">暂无自定义设计系统</div>
      <div class="empty-d">
        {{ online ? '点击右上角「添加设计系统」，或在内置卡片上点「副本」生成可编辑副本。' : '需要连接后端才能创建自定义设计系统。' }}
      </div>
    </div>

    <!-- 新建自定义 -->
    <div v-if="creating" class="modal-mask" @click.self="creating = false">
      <div class="modal card">
        <button class="modal-x icon-btn" @click="creating = false"><UIcon name="x" :size="15" /></button>
        <div class="cm-head">
          <div class="cm-title">添加设计系统</div>
          <p class="cm-sub">会在本地用户目录生成一份可编辑的 css.json，内置资产不会被改动。</p>
        </div>
        <div class="cm-body">
          <div class="fld">
            <span class="fld-t">名称</span>
            <input v-model="newName" class="cm-input" placeholder="例如：我的品牌风格" />
          </div>
          <div class="fld">
            <span class="fld-t">继承色板（可选）</span>
            <select v-model="newBase" class="cm-input">
              <option value="">不继承（用起始色板）</option>
              <option v-for="b in builtinList" :key="b.id" :value="b.id">{{ b.name }}</option>
            </select>
          </div>
          <p v-if="createErr" class="cm-err">{{ createErr }}</p>
          <button class="apply-btn" :disabled="!newName.trim() || createBusy" @click="submitCreate">
            {{ createBusy ? '创建中…' : '创建' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sec-t { font-size: 14px; font-weight: 600; margin: 26px 0 12px; }
.ds-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.ds-card { overflow: hidden; display: block; text-decoration: none; color: inherit; }
.ds-card:hover { border-color: var(--t3); }
.ds-thumb { height: 110px; position: relative; padding: 12px; }
.mini-bar { height: 16px; border-radius: 4px; opacity: 0.9; }
.mini-side { position: absolute; left: 12px; top: 36px; width: 22px; height: 60px; border-radius: 4px; background: rgba(0,0,0,0.08); }
.mini-body { position: absolute; left: 42px; right: 12px; top: 36px; bottom: 12px; display: flex; flex-direction: column; gap: 6px; }
.mini-chip { width: 34px; height: 16px; border-radius: 4px; opacity: 0.9; }
.mini-line { height: 8px; border-radius: 3px; background: rgba(0,0,0,0.1); }
.mini-line.short { width: 60%; }
.ds-meta { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; gap: 8px; }
.ds-name { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; min-width: 0; }
.ds-dot { width: 12px; height: 12px; border-radius: 4px; flex: none; }
.tag-user {
  flex: none; font-size: 10px; font-weight: 500; color: var(--ok);
  background: var(--ok-bg); border-radius: 4px; padding: 1px 5px;
}
.mini-btn {
  flex: none; height: 22px; padding: 0 8px; border-radius: 6px; font-size: 11px;
  border: 1px solid var(--line); background: var(--panel); color: var(--t2);
}
.mini-btn:hover:not(:disabled) { background: var(--line-2); color: var(--t1); }
.mini-btn:disabled { opacity: 0.5; cursor: default; }
.mini-btn.danger:hover:not(:disabled) { color: var(--err); }
.tip {
  display: flex; align-items: center; gap: 6px; margin-top: 14px; padding: 10px 12px;
  border-radius: 8px; background: var(--line-2); color: var(--t2); font-size: 12px;
}
.tip.err { background: var(--err-bg); color: var(--err); }
.custom-empty { margin-top: 2px; }
.empty-t { font-size: 13.5px; font-weight: 600; color: var(--t1); }
.empty-d { font-size: 12px; }

/* 新建弹层 */
.modal-mask {
  position: fixed; inset: 0; background: rgba(15, 17, 21, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 50; padding: 24px;
}
.modal { width: 460px; max-width: 100%; max-height: 86vh; overflow: auto; position: relative; padding: 0; }
.modal-x { position: absolute; top: 12px; right: 12px; z-index: 2; }
.cm-head { padding: 20px 22px 14px; background: var(--line-2); border-bottom: 1px solid var(--line); }
.cm-title { font-size: 15px; font-weight: 700; }
.cm-sub { margin: 6px 0 0; font-size: 11.5px; color: var(--t3); line-height: 1.6; }
.cm-body { padding: 16px 22px 22px; display: flex; flex-direction: column; gap: 12px; }
.fld { display: flex; flex-direction: column; gap: 6px; }
.fld-t { font-size: 11.5px; color: var(--t3); }
.cm-input {
  height: 34px; border: 1px solid var(--line); border-radius: 8px; padding: 0 10px;
  font-size: 12.5px; background: var(--panel); color: var(--t1);
}
.cm-err { margin: 0; font-size: 12px; color: var(--err); }
.apply-btn {
  height: 38px; border-radius: 9px; background: var(--violet); color: #fff;
  font-size: 13.5px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center;
}
.apply-btn:disabled { background: var(--violet-soft); cursor: default; }
</style>
