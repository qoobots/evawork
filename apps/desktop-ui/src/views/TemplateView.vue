<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import UIcon from '@/components/UIcon.vue';
import UAsync from '@/components/UAsync.vue';
import TemplateDetailModal from '@/components/TemplateDetailModal.vue';
import { templateCats, templates } from '@/data/mock';
import { bridgeAvailable } from '@/api/backend';
import {
  fetchFavorites,
  fetchTemplateMeta,
  fetchTemplates,
  setFavorite,
  type TemplateItem,
  type TemplateMeta,
} from '@/api/templates';
import { useAsyncData } from '@/composables/useAsyncData';

const tab = ref<'pick' | 'fav'>('pick');
const cat = ref('全部');
const keyword = ref('');
const faved = ref<string[]>([]); // 收藏的模板标题
const favTick = ref(0); // 收藏变更后触发列表刷新

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

// 分类元数据
const { data: meta, run: runMeta } = useAsyncData<TemplateMeta>(() =>
  online.value
    ? fetchTemplateMeta()
    : Promise.resolve({ cats: templateCats, counts: { templates: templates.length } }),
);

// 收藏列表（后端持久化）
const { data: favData, run: runFav } = useAsyncData<{ items: string[] }>(() =>
  online.value ? fetchFavorites() : Promise.resolve({ items: [] as string[] }),
);
watch(favData, (d) => {
  if (d) faved.value = d.items;
});

// 模板列表
const listParams = computed(() => ({
  tab: tab.value,
  cat: cat.value,
  q: kw.value,
  fav: favTick.value,
}));
const {
  data: tplData,
  loading: tplLoading,
  error: tplError,
  reload: reloadTemplates,
  run: runTemplates,
} = useAsyncData<TemplateItem[]>(() => {
  if (online.value) {
    return fetchTemplates({
      cat: cat.value,
      q: kw.value.trim(),
      fav: tab.value === 'fav',
    }).then((r) => r.items);
  }
  // 离线兜底：本地过滤
  const k = kw.value.trim().toLowerCase();
  return Promise.resolve(
    templates.filter((t) => {
      if (tab.value === 'fav' && !faved.value.includes(t.title)) return false;
      if (cat.value !== '全部' && t.cat !== cat.value) return false;
      return !k || t.title.toLowerCase().includes(k);
    }) as TemplateItem[],
  );
}, [listParams]);

onMounted(() => {
  void runMeta();
  void runFav();
  void runTemplates();
});

async function toggleFav(title: string) {
  const next = !faved.value.includes(title);
  if (online.value) {
    try {
      const r = await setFavorite(title, next);
      faved.value = r.items;
    } catch {
      /* 失败时保持原状态，由界面提示 */
    }
  } else {
    const s = new Set(faved.value);
    if (next) s.add(title);
    else s.delete(title);
    faved.value = [...s];
  }
  favTick.value++; // 收藏 Tab 需要重拉列表
}

// T-032：点击卡片打开详情/应用弹层
const detailTpl = ref<TemplateItem | null>(null);
function openDetail(t: TemplateItem) {
  detailTpl.value = t;
}
</script>

<template>
  <div class="page tpl">
    <div class="page-head">
      <div>
        <h1 class="page-title">模板库</h1>
        <div class="page-sub">你负责真正的工作，找张模板，一键开始。</div>
      </div>
    </div>

    <div class="tab-row">
      <div class="seg">
        <button class="seg-item" :class="{ active: tab === 'pick' }" @click="tab = 'pick'">精选</button>
        <button class="seg-item" :class="{ active: tab === 'fav' }" @click="tab = 'fav'">收藏</button>
      </div>
      <div class="spacer" />
      <div class="search-box input" style="width: 200px">
        <UIcon name="search" :size="13" style="color: var(--t3)" />
        <input v-model="keyword" placeholder="搜索模板" style="border: none; outline: none; width: 100%; font-size: 12.5px; background: none" />
      </div>
    </div>

    <div class="chips-row">
      <button v-for="c in (meta?.cats ?? templateCats)" :key="c" class="chip" :class="{ active: cat === c }" @click="cat = c">{{ c }}</button>
    </div>

    <UAsync :loading="tplLoading" :error="tplError" hint="正在加载模板…" @retry="reloadTemplates">
      <div v-if="!(tplData ?? []).length" class="empty">
        {{ tab === 'fav' ? '还没有收藏的模板' : '没有符合条件的模板' }}
      </div>

      <div class="masonry">
        <div v-for="(t, i) in (tplData ?? [])" :key="t.title" class="tpl-card card" :style="{ marginTop: i % 3 === 1 ? '18px' : '0' }" @click="openDetail(t)">
        <div class="tpl-preview" :style="{ background: `linear-gradient(150deg, ${t.hue}, ${t.hue}cc 60%, ${t.hue}99)` }">
          <div class="deco bars" v-if="t.deco === 'bars'"><span v-for="n in 5" :key="n" :style="{ height: 14 + n * 9 + 'px' }" /></div>
          <div class="deco radar" v-else-if="t.deco === 'radar'"><span /><span /><span /></div>
          <div class="deco chart" v-else-if="t.deco === 'chart'"><svg viewBox="0 0 100 40"><polyline points="0,35 20,25 40,30 60,12 80,18 100,5" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="2.5" /></svg></div>
          <div class="deco kpi" v-else-if="t.deco === 'kpi'"><span v-for="n in 3" :key="n" /></div>
          <div class="deco site" v-else-if="t.deco === 'site'"><span class="site-bar" /><span class="site-body" /></div>
          <div class="deco photo" v-else-if="t.deco === 'photo'"><span class="photo-circle" /></div>
          <div class="deco doc" v-else><span /><span /><span class="short" /></div>
        </div>
        <div class="tpl-meta">
          <span class="tag tag-blue"><UIcon name="code" :size="10" /> HTML</span>
          <span class="tpl-title">{{ t.title }}</span>
          <button class="icon-btn" aria-label="收藏模板" @click.stop="toggleFav(t.title)">
            <UIcon name="star" :size="14" :style="faved.includes(t.title) ? 'color:#f59e0b;fill:#f59e0b' : ''" />
          </button>
        </div>
        </div>
      </div>
    </UAsync>

    <TemplateDetailModal :template="detailTpl" @close="detailTpl = null" />
  </div>
</template>

<style scoped>
.tab-row { display: flex; align-items: center; margin-top: 20px; }
.spacer { flex: 1; }
.chips-row { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
.masonry { columns: 4; column-gap: 16px; margin-top: 20px; }
.tpl-card { break-inside: avoid; margin-bottom: 16px; overflow: hidden; }
.tpl-preview { height: 150px; position: relative; overflow: hidden; }
.deco { position: absolute; inset: auto 14px 14px 14px; display: flex; align-items: flex-end; gap: 6px; }
.deco.bars span { width: 14%; background: rgba(255,255,255,0.75); border-radius: 3px 3px 0 0; }
.deco.radar span { position: absolute; border: 1.5px solid rgba(255,255,255,0.7); border-radius: 50%; }
.deco.radar span:nth-child(1) { width: 40px; height: 40px; left: 30%; top: 30%; }
.deco.radar span:nth-child(2) { width: 70px; height: 70px; left: 22%; top: 15%; }
.deco.radar span:nth-child(3) { width: 100px; height: 100px; left: 12%; top: 0; }
.deco.chart { inset: 20px 14px 14px; }
.deco.chart svg { width: 100%; height: 100%; }
.deco.kpi span { flex: 1; height: 44px; background: rgba(255,255,255,0.8); border-radius: 6px; }
.deco.site { inset: 18px 20px 20px; flex-direction: column; gap: 6px; }
.site-bar { height: 10px; width: 60%; background: rgba(255,255,255,0.9); border-radius: 3px; }
.site-body { flex: 1; background: rgba(255,255,255,0.45); border-radius: 6px; }
.photo-circle { width: 74px; height: 74px; border-radius: 50%; background: rgba(255,255,255,0.75); margin: 0 auto; }
.deco.doc { flex-direction: column; gap: 7px; }
.deco.doc span { height: 8px; width: 90%; background: rgba(255,255,255,0.7); border-radius: 3px; }
.deco.doc span.short { width: 55%; }
.tpl-meta { display: flex; align-items: center; gap: 8px; padding: 12px 14px; }
.tpl-title { font-size: 12.5px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
