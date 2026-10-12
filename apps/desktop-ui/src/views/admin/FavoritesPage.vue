<script setup lang="ts">
/* S-06：收藏盒此前是一张静态空卡片——后端 `GET/POST /api/templates/favorites`
   一直都在，页面却没接，于是"收藏了但在收藏盒里看不见"。
   这里接真数据：列表来自 `/api/templates?fav=1`（带标题/分类/描述），
   取消收藏走 `POST /api/templates/favorites`，两边同一份库。 */
import { computed, onMounted, ref } from 'vue';
import UIcon from '@/components/UIcon.vue';
import { bridgeAvailable } from '@/api/backend';
import { fetchTemplates, setFavorite, type TemplateItem } from '@/api/templates';
import { useI18nStore } from '@/stores/i18n';

const i18nStore = useI18nStore();

const online = computed(() => bridgeAvailable());
const items = ref<TemplateItem[]>([]);
const loading = ref(false);
const error = ref('');
const busy = ref('');

async function load() {
  if (!online.value) return;
  loading.value = true;
  error.value = '';
  try {
    const d = await fetchTemplates({ fav: true });
    items.value = d.items ?? [];
  } catch (e) {
    error.value = (e as Error).message;
    items.value = [];
  } finally {
    loading.value = false;
  }
}

async function remove(t: TemplateItem) {
  if (busy.value) return;
  busy.value = t.title;
  try {
    await setFavorite(t.title, false);
    items.value = items.value.filter((x) => x.title !== t.title);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = '';
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="pg">
    <h1>{{ i18nStore.t('收藏盒') }}</h1>
    <p class="sub">{{ i18nStore.t('你收藏的内容都会保存在这里') }}</p>

    <div v-if="!online" class="empty-p">
      <div class="empty-ic">☆</div>
      <div>{{ i18nStore.t('未连接后端') }}</div>
      <div class="dim">{{ i18nStore.t('连上后端后这里显示你收藏的模板') }}</div>
    </div>
    <div v-else-if="loading" class="empty-p"><div class="dim">{{ i18nStore.t('读取收藏中…') }}</div></div>
    <div v-else-if="error" class="empty-p">
      <div>{{ error }}</div>
      <button class="btn" style="margin-top: 10px" @click="load">{{ i18nStore.t('重试') }}</button>
    </div>
    <div v-else-if="!items.length" class="empty-p">
      <div class="empty-ic">☆</div>
      <div>{{ i18nStore.t('暂无收藏') }}</div>
      <div class="dim">{{ i18nStore.t('在模板库里收藏的内容会显示在这里') }}</div>
    </div>
    <div v-else class="fav-grid">
      <div v-for="t in items" :key="t.title" class="fav card">
        <div class="fav-ic" :style="{ background: `hsl(${t.hue} / 16%)`, color: `hsl(${t.hue})` }">
          <UIcon name="sparkle" :size="13" />
        </div>
        <div class="fav-body">
          <div class="fav-t">{{ t.title }}</div>
          <div class="dim">{{ t.cat }}</div>
          <div class="dim fav-d">{{ t.desc }}</div>
        </div>
        <button class="icon-btn" :title="i18nStore.t('取消收藏')" :disabled="busy === t.title" @click="remove(t)">
          <UIcon name="star" :size="13" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pg h1 { font-size: 22px; }
.sub { color: var(--ac-text-muted); font-size: 12.5px; margin-top: 6px; }
.empty-p { display: flex; flex-direction: column; align-items: center; padding: 90px 0; gap: 8px; font-size: 13.5px; }
.empty-ic { width: 46px; height: 46px; border-radius: 12px; background: var(--ac-panel); border: 1px solid var(--ac-border); color: var(--ac-text-faint); display: flex; align-items: center; justify-content: center; font-size: 20px; }
.dim { color: var(--ac-text-muted); font-size: 12px; }
.fav-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; margin-top: 14px; }
.fav { display: flex; align-items: flex-start; gap: 10px; padding: 12px; }
.fav-ic { width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; flex: none; }
.fav-body { min-width: 0; flex: 1; }
.fav-t { font-size: 13.5px; font-weight: 600; }
.fav-d { margin-top: 4px; line-height: 1.5; }
</style>
