<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UIcon from '@/components/UIcon.vue';
import { designSystems, graphicIcons } from '@/data/mock';
import { bridgeAvailable } from '@/api/backend';
import {
  duplicateDesignSystem,
  fetchDesignSystem,
  updateDesignSystem,
  type DesignDTO,
  type TokenPatch,
} from '@/api/design';

const route = useRoute();
const router = useRouter();

/* ---------- T-033：优先用后端真实资产，拿不到才回退 mock ---------- */
const remote = ref<DesignDTO | null>(null);
const online = computed(() => bridgeAvailable());
// 必须在 loadRemote / watch(immediate) 之前声明：否则 setup 阶段 immediate 回调会 TDZ 访问未初始化的 errMsg
const errMsg = ref('');

async function loadRemote(id: string) {
  remote.value = null;
  errMsg.value = '';
  if (!online.value) return;
  try {
    remote.value = await fetchDesignSystem(id);
  } catch {
    // 后端拿不到（或不存在）就回退 mock，界面不会白屏；下面会说明来源
  }
}

watch(
  () => route.params.id,
  (id) => void loadRemote(String(id ?? '')),
  { immediate: true },
);

const local = computed(() => designSystems.find((d) => d.id === route.params.id) ?? designSystems[0]);
const ds = computed(() => {
  const r = remote.value;
  if (!r) return local.value;
  return {
    id: r.id,
    name: r.name,
    hue: r.hue,
    scales: [],
    tokens: r.tokens,
    fonts: r.fonts ?? [],
    skillDesc: r.origin ? `基于「${r.origin}」的副本设计规范` : '自定义设计规范，可直接在主题页改色保存',
  };
});

/** 只有副本/自定义（source=user）可以改色——内置资产只读。 */
const editable = computed(() => remote.value?.source === 'user');
const draft = ref<Record<string, string>>({});
const saving = ref(false);
const savedMsg = ref('');

function keyOf(group: string, token: string) {
  return `${group}/${token}`;
}

function originalHex(group: string, token: string) {
  const g = ds.value.tokens?.find((x) => x.name === group);
  return g?.items.find((i) => i.name === token)?.hex ?? '#000000';
}

function hexOf2(group: string, token: string) {
  return draft.value[keyOf(group, token)] ?? originalHex(group, token);
}

function setHex(group: string, token: string, hex: string) {
  draft.value = { ...draft.value, [keyOf(group, token)]: hex };
}

const dirtyCount = computed(
  () =>
    Object.entries(draft.value).filter(([k, v]) => {
      const [group, token] = k.split('/');
      return v.toLowerCase() !== originalHex(group, token).toLowerCase();
    }).length,
);

async function saveTokens() {
  if (!remote.value || !dirtyCount.value || saving.value) return;
  saving.value = true;
  errMsg.value = '';
  try {
    const patches: TokenPatch[] = Object.entries(draft.value).map(([k, hex]) => {
      const [group, token] = k.split('/');
      return { group, token, hex };
    });
    remote.value = await updateDesignSystem(remote.value.id, patches);
    draft.value = {};
    savedMsg.value = '已保存';
    setTimeout(() => (savedMsg.value = ''), 2000);
  } catch (e) {
    errMsg.value = (e as Error).message || '保存失败';
  } finally {
    saving.value = false;
  }
}

async function duplicateHere() {
  if (!online.value) {
    errMsg.value = '未连接后端，创建副本不会真的执行';
    return;
  }
  errMsg.value = '';
  try {
    const copy = await duplicateDesignSystem(String(route.params.id));
    router.push(`/design/${encodeURIComponent(copy.id)}`);
  } catch (e) {
    errMsg.value = (e as Error).message || '创建副本失败';
  }
}

const tab = ref<'theme' | 'comp' | 'icons' | 'guide'>('theme');
const tabs = [
  { k: 'theme', label: '主题' },
  { k: 'comp', label: '组件' },
  { k: 'icons', label: '图形' },
  { k: 'guide', label: '设计规范' },
] as const;

const iconSearch = ref('');
const filteredIcons = computed(() =>
  graphicIcons.filter((n) => n.toLowerCase().includes(iconSearch.value.toLowerCase())),
);

function hexOf(i: number) {
  return '#' + [1, 3, 5].map((k) => (parseInt(ds.value.hue.slice(k, k + 2), 16) * (0.4 + i * 0.08) | 0).toString(16).padStart(2, '0')).join('');
}
</script>

<template>
  <div class="dsd">
    <!-- 顶栏 -->
    <div class="dsd-bar">
      <button class="icon-btn" aria-label="返回设计系统" @click="router.push('/design')"><UIcon name="arrow-left" :size="15" /></button>
      <h1 class="dsd-name"><span class="ds-dot" :style="{ background: ds.hue }" />{{ ds.name }}</h1>
      <div class="seg" style="margin: 0 auto">
        <button v-for="t in tabs" :key="t.k" class="seg-item" :class="{ active: tab === t.k }" @click="tab = t.k">{{ t.label }}</button>
      </div>
      <!-- T-033：创建副本 → 真的生成一份可编辑的用户副本并跳过去 -->
      <button class="btn" @click="duplicateHere"><UIcon name="external" :size="12" /> 创建副本</button>
    </div>

    <p v-if="errMsg" class="bar-msg err"><UIcon name="info" :size="13" /> {{ errMsg }}</p>
    <p v-else-if="savedMsg" class="bar-msg ok"><UIcon name="check" :size="13" /> {{ savedMsg }}</p>
    <p v-else-if="!online" class="bar-msg">未连接后端：当前显示内置示例数据，改色与副本不会生效。</p>

    <div class="dsd-body" tabindex="0">
      <!-- 主题 -->
      <template v-if="tab === 'theme'">
        <template v-if="ds.scales.length">
          <div v-for="s in ds.scales" :key="s.name" class="scale-block card">
            <div class="scale-head" :style="{ background: s.base }">{{ s.name }}</div>
            <div class="scale-row">
              <div v-for="sw in s.swatches" :key="sw.name" class="swatch">
                <div class="sw-color" :style="{ background: sw.hex }" />
                <div class="sw-name">{{ sw.name }}</div>
                <div class="sw-hex">{{ sw.hex }}</div>
              </div>
            </div>
          </div>
        </template>
        <template v-else>
          <div v-if="editable" class="edit-bar card">
            <span class="eb-t">
              <UIcon name="pen" :size="12" /> 这套是可编辑{{ ds.name ? '的' : '' }}副本/自定义设计系统：点色块改色后保存，会写回本地用户目录 css.json
            </span>
            <button class="eb-btn" :disabled="!dirtyCount || saving" @click="saveTokens">
              {{ saving ? '保存中…' : dirtyCount ? `保存 ${dirtyCount} 处修改` : '无修改' }}
            </button>
          </div>
          <div v-else class="edit-bar card readonly">
            <span class="eb-t"><UIcon name="info" :size="12" /> 内置设计系统为只读；如需改色，请先「创建副本」。</span>
          </div>

          <div v-for="g in ds.tokens" :key="g.name" class="token-block card">
            <div class="token-title" :style="{ color: g.name === 'bg-brand' ? '#fff' : ds.hue, background: g.name === 'bg-brand' ? ds.hue : 'transparent' }">{{ g.name }}</div>
            <div class="token-row">
              <div v-for="it in g.items" :key="it.name" class="swatch">
                <label class="sw-color-wrap">
                  <div class="sw-color" :style="{ background: hexOf2(g.name, it.name) }" />
                  <input
                    v-if="editable" class="sw-pick" type="color" :value="hexOf2(g.name, it.name)"
                    :aria-label="`${g.name} / ${it.name}`"
                    @input="setHex(g.name, it.name, ($event.target as HTMLInputElement).value)"
                  />
                </label>
                <div class="sw-name">{{ it.name }}</div>
                <div class="sw-hex">{{ hexOf2(g.name, it.name) }}</div>
              </div>
            </div>
          </div>
        </template>

        <div class="font-row">
          <div v-for="f in ds.fonts" :key="f.name" class="font-card card">
            <div class="font-aa">Aa</div>
            <div class="font-name">{{ f.name }}</div>
            <div class="font-label">{{ f.label }}</div>
          </div>
        </div>
      </template>

      <!-- 组件 -->
      <template v-else-if="tab === 'comp'">
        <div class="comp-card card">
          <div class="comp-head"><UIcon name="sparkle" :size="12" style="color: var(--violet)" /> 示例页面 - Settings <UIcon name="x" :size="12" style="margin-left: auto" /></div>
          <div class="comp-preview">
            <!-- 内嵌 Agent Settings 迷你 mock -->
            <div class="mock-app">
              <div class="mock-side">
                <div class="mock-brand"><span class="mock-logo" :style="{ background: ds.hue }" /> EvaWork</div>
                <div class="mock-cap">MOCK</div>
                <div class="mock-nav">General</div>
                <div class="mock-nav on">Agents</div>
                <div class="mock-nav">MCP</div>
                <div class="mock-cap">DISPLAY</div>
                <div class="mock-nav">Rules</div>
                <div class="mock-nav">Framework</div>
              </div>
              <div class="mock-main">
                <div class="mock-h">Agent Settings</div>
                <div class="mock-sub">Configure builders, MCP tools and workspace rules.</div>
                <div class="mock-form">
                  <div><label>Workspace name</label><div class="mock-input">EvaWork Web</div></div>
                  <div><label>Default model</label><div class="mock-input">Auto</div></div>
                </div>
                <div class="mock-agents">
                  <div class="mock-agent"><span class="ma-ic">FI</span><div><b>Figma</b><small>Design context and component matching.</small></div><i class="tag tag-green">Active</i></div>
                  <div class="mock-agent"><span class="ma-ic">DA</span><div><b>Data Agent</b><small>Dashboards, reports and metric diagnostics.</small></div><i class="tag tag-gray">Ready</i></div>
                  <div class="mock-agent"><span class="ma-ic">BF</span><div><b>Bug Fixer</b><small>Focused repair flow for failing checks.</small></div><i class="tag tag-orange">Review</i></div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="comp-card card">
          <div class="comp-head"><UIcon name="sparkle" :size="12" style="color: var(--violet)" /> 示例页面 <UIcon name="x" :size="12" style="margin-left: auto" /></div>
          <div class="comp-preview dark-preview">
            <div class="phone-mock">
              <div class="pm-top">9:41 <span>5G</span></div>
              <div class="pm-pill">RELEASE TO REFRESH</div>
              <div class="pm-tabs"><span>Following</span><b>For You</b></div>
              <div class="pm-actions"><span><UIcon name="star" :size="12" /></span><span><UIcon name="chat" :size="12" /></span><span><UIcon name="send" :size="12" /></span></div>
              <div class="pm-caption">@framebylena <i>Follow</i><br />Shot this midnight transition in one take</div>
              <div class="pm-nav"><span>Home</span><span>Discover</span><b class="pm-plus">+</b><span>Inbox</span><span>Me</span></div>
            </div>
          </div>
        </div>
      </template>

      <!-- 图形 -->
      <template v-else-if="tab === 'icons'">
        <div class="search-box input" style="width: 240px; margin-bottom: 18px">
          <UIcon name="search" :size="13" style="color: var(--t3)" />
          <input v-model="iconSearch" placeholder="搜索" style="border: none; outline: none; width: 100%; font-size: 12.5px; background: none" />
        </div>
        <div class="icon-grid">
          <div v-for="(n, i) in filteredIcons" :key="n" class="icon-tile card">
            <UIcon :name="['grid', 'user', 'chat', 'send', 'video', 'plus', 'gear', 'doc', 'play', 'search', 'arrow-left', 'star'][i % 12]" :size="18" />
            <span>{{ n }}</span>
          </div>
        </div>
      </template>

      <!-- 设计规范 -->
      <template v-else>
        <div class="guide-hero" :style="{ background: `linear-gradient(120deg, ${ds.hue}, ${ds.hue2 ?? hexOf(4)})` }">
          <div>
            <h2>设计规范</h2>
            <p>为 EvaDesign 提供设计原则、布局原则、交互模式和产品规范。</p>
          </div>
        </div>
        <div class="guide-cards">
          <div class="guide-card card">
            <UIcon name="doc" :size="16" />
            <div><b>README</b><small>Design Library documentation</small></div>
          </div>
          <div class="guide-card card">
            <UIcon name="zap" :size="16" />
            <div><b>SKILL</b><small>{{ ds.skillDesc }}</small></div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.dsd { height: 100%; display: flex; flex-direction: column; }
.dsd-bar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
.dsd-name { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; }
.ds-dot { width: 14px; height: 14px; border-radius: 4px; }
.dsd-body { flex: 1; overflow: auto; padding: 24px 40px; }

/* T-033：状态条与编辑条 */
.bar-msg {
  display: flex; align-items: center; gap: 6px; margin: 0; padding: 10px 16px;
  font-size: 12px; color: var(--t2); background: var(--line-2);
}
.bar-msg.err { background: var(--err-bg); color: var(--err); }
.bar-msg.ok { background: var(--ok-bg); color: var(--ok); }
.edit-bar { display: flex; align-items: center; gap: 12px; padding: 12px 16px; margin-bottom: 16px; }
.edit-bar.readonly { background: var(--line-2); }
.eb-t { flex: 1; display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--t2); }
.eb-btn {
  flex: none; height: 30px; padding: 0 14px; border-radius: 8px; font-size: 12.5px;
  background: var(--violet); color: #fff;
}
.eb-btn:disabled { background: var(--violet-soft); cursor: default; }

.scale-block, .token-block { overflow: hidden; margin-bottom: 20px; }
.scale-head { color: #fff; font-weight: 700; padding: 18px 20px; font-size: 15px; }
.token-title { font-weight: 700; padding: 12px 20px 0; font-size: 14px; }
.scale-row, .token-row { display: flex; gap: 8px; padding: 14px 20px 18px; flex-wrap: wrap; }
.swatch { width: 86px; }
.sw-color-wrap { display: block; position: relative; cursor: default; }
.sw-color { height: 44px; border-radius: 8px; border: 1px solid var(--line-2); }
/* 原生取色器铺满色块但保持透明，点击即改色（可编辑时才渲染） */
.sw-pick {
  position: absolute; inset: 0; width: 100%; height: 100%;
  opacity: 0; cursor: pointer; border: none; padding: 0;
}
.sw-name { font-size: 10.5px; margin-top: 6px; color: var(--t1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sw-hex { font-size: 10px; color: var(--t3); }

.font-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 8px; }
.font-card { padding: 20px; }
.font-aa { font-size: 44px; font-weight: 600; }
.font-name { margin-top: 14px; font-size: 13px; font-weight: 600; }
.font-label { font-size: 11px; color: var(--t2); }

.comp-card { margin-bottom: 20px; overflow: hidden; }
.comp-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; font-size: 13px; font-weight: 600; color: var(--t2); border-bottom: 1px solid var(--line-2); }
.comp-preview { background: var(--active-bg); padding: 26px; display: flex; justify-content: center; }
.mock-app { display: flex; width: 100%; max-width: 760px; min-height: 380px; background: var(--panel); border-radius: 10px; overflow: hidden; box-shadow: var(--shadow); }
.mock-side { width: 150px; border-right: 1px solid var(--line-2); padding: 14px 10px; }
.mock-brand { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 12px; }
.mock-logo { width: 12px; height: 12px; border-radius: 4px; }
.mock-cap { font-size: 9px; color: var(--t3); margin: 12px 0 4px; letter-spacing: 0.5px; }
.mock-nav { font-size: 11px; padding: 5px 8px; border-radius: 5px; color: var(--t2); }
.mock-nav.on { background: #eceefc; color: var(--violet); font-weight: 600; }
.mock-main { flex: 1; padding: 20px 24px; }
.mock-h { font-size: 18px; font-weight: 800; }
.mock-sub { font-size: 10.5px; color: var(--t2); margin-top: 4px; }
.mock-form { display: flex; gap: 24px; margin-top: 16px; }
.mock-form label { font-size: 10px; font-weight: 700; display: block; margin-bottom: 4px; }
.mock-input { width: 150px; height: 24px; border: 1px solid var(--line); border-radius: 5px; font-size: 10.5px; padding: 0 7px; line-height: 22px; color: var(--t2); }
.mock-agents { margin-top: 18px; border: 1px solid var(--line-2); border-radius: 8px; }
.mock-agent { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--line-2); }
.mock-agent:last-child { border-bottom: none; }
.ma-ic { width: 22px; height: 22px; border-radius: 50%; background: var(--line-2); font-size: 8.5px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.mock-agent b { font-size: 11px; display: block; }
.mock-agent small { font-size: 9.5px; color: var(--t2); }
.mock-agent i { margin-left: auto; font-style: normal; }
.dark-preview { background: #101014; }
.phone-mock { width: 240px; height: 400px; background: #161618; border-radius: 26px; border: 4px solid #2c2c30; position: relative; color: #eee; padding: 14px; }
.pm-top { font-size: 10px; display: flex; justify-content: space-between; }
.pm-pill { text-align: center; font-size: 7px; letter-spacing: 1px; color: #888; border: 1px solid #333; border-radius: 999px; padding: 3px 8px; width: fit-content; margin: 10px auto; }
.pm-tabs { display: flex; gap: 12px; justify-content: center; font-size: 11px; color: #888; margin-top: 6px; }
.pm-tabs b { color: #fff; border-bottom: 2px solid #fff; padding-bottom: 2px; }
.pm-actions { position: absolute; right: 12px; top: 120px; display: flex; flex-direction: column; gap: 12px; }
.pm-actions span { width: 26px; height: 26px; border-radius: 50%; background: #2a2a2e; display: flex; align-items: center; justify-content: center; }
.pm-caption { position: absolute; left: 14px; bottom: 44px; font-size: 9px; line-height: 1.5; }
.pm-caption i { font-style: normal; background: #333; border-radius: 3px; padding: 0 4px; font-size: 8px; }
.pm-nav { position: absolute; bottom: 0; left: 0; right: 0; height: 34px; background: #1b1b1e; display: flex; align-items: center; justify-content: space-around; font-size: 8px; color: #999; }
.pm-plus { width: 24px; height: 16px; background: #fff; color: #000; border-radius: 5px; display: flex; align-items: center; justify-content: center; font-size: 12px; }

.icon-grid { display: grid; grid-template-columns: repeat(10, 1fr); gap: 10px; }
.icon-tile { display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 14px 4px 10px; }
.icon-tile span { font-size: 9.5px; color: var(--t2); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.guide-hero { border-radius: 14px; color: #fff; padding: 44px 40px; }
.guide-hero h2 { font-size: 24px; }
.guide-hero p { margin-top: 8px; font-size: 12.5px; opacity: 0.85; }
.guide-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px; }
.guide-card { display: flex; gap: 12px; padding: 18px; align-items: flex-start; }
.guide-card b { font-size: 13px; display: block; }
.guide-card small { font-size: 11.5px; color: var(--t2); }
</style>
