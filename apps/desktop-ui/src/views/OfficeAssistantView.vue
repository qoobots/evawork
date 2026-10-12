<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import UIcon from '@/components/UIcon.vue';
import { commTools } from '@/data/mock';
import { bridgeAvailable } from '@/api/backend';
import { fetchIntegrations, bindIntegration, type Integration } from '@/api/integrations';
import { useI18nStore } from '@/stores/i18n';

const i18n = useI18nStore();

/** 通讯工具品牌色块（无外部图片，CSS 画） */
const brandBg: Record<string, string> = {
  feishu: 'linear-gradient(135deg, #00d6b9, #0aa0ff)',
  wechat: 'linear-gradient(135deg, #2aae67, #07c160)',
  'wechat-work': 'linear-gradient(135deg, #4d80f0, #2a5cd8)',
  dingtalk: 'linear-gradient(135deg, #3296fa, #1a6fd8)',
};

/* ---------- T-034：绑不绑得了由后端说了算，不摆假按钮 ---------- */
const online = computed(() => bridgeAvailable());
const providers = ref<Integration[]>([]);
const detail = ref<Integration | null>(null);
const binding = ref(false);
const bindMsg = ref('');

async function load() {
  if (!bridgeAvailable()) return;
  try {
    providers.value = (await fetchIntegrations()).items || [];
  } catch {
    providers.value = [];
  }
}

onMounted(load);

/** 后端若更新了绑定能力，以前端拿到的最新数据为准。 */
function stateOf(icon: string) {
  const hit = providers.value.find((p) => p.icon === icon || p.id === icon);
  return hit ?? null;
}

async function doBind(p: Integration) {
  binding.value = true;
  bindMsg.value = '';
  try {
    await bindIntegration(p.id);
    bindMsg.value = '绑定成功';
  } catch (e) {
    // 501 = 未接入；把后端给的原因原样显示，别包装成"网络错误"
    bindMsg.value = (e as Error).message || '绑定失败';
  } finally {
    binding.value = false;
  }
}
</script>

<template>
  <div class="page office">
    <div class="page-head">
      <div>
        <h1 class="page-title">{{ i18n.t('page.office.title') }}</h1>
        <div class="page-sub">{{ i18n.t('page.office.sub') }}</div>
      </div>
    </div>

    <!-- Hero 横幅 -->
    <div class="hero">
      <div class="hero-copy">
        <h2>从对话开始，<br />把工作交给 EvaWork</h2>
        <p>在通讯工具里 @EvaWork，消息会自动转为任务；无需切换应用，可同步爬站间、随时查看查看结果。</p>
      </div>
      <div class="hero-art">
        <div class="orbit o1" /><div class="orbit o2" /><div class="orbit o3" />
        <div class="hero-chip">
          <UIcon name="chat" :size="14" /> EvaWork
        </div>
      </div>
    </div>

    <div class="section-t">连接你的通讯工具，即可开始使用</div>

    <div class="tool-list">
      <div v-for="t in commTools" :key="t.name" class="row-card">
        <span class="tool-ic" :style="{ background: brandBg[t.icon] }">
          <UIcon :name="t.icon === 'wechat-work' ? 'chat' : t.icon === 'dingtalk' ? 'cloud' : 'chat'" :size="18" />
        </span>
        <div class="tool-info">
          <div class="tool-name">{{ t.name }}</div>
          <div class="tool-desc" :class="{ soon: t.status === 'soon' }">
            {{ stateOf(t.icon)?.reason ?? t.desc }}
          </div>
        </div>
        <button v-if="t.status === 'bind'" class="btn" @click="detail = stateOf(t.icon)">去绑定</button>
        <span v-else class="soon-tag">即将上线</span>
      </div>
    </div>

    <!-- 绑定说明：能绑就绑，不能绑就说明缺什么 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal card">
        <button class="modal-x icon-btn" aria-label="关闭" @click="detail = null"><UIcon name="x" :size="15" /></button>
        <div class="bd-head">
          <div class="bd-title">绑定「{{ detail.name }}」</div>
          <p class="bd-sub">{{ detail.reason }}</p>
        </div>
        <div class="bd-body">
          <div v-if="detail.needs?.length" class="bd-needs">
            <div class="bd-t">接入需要</div>
            <ul>
              <li v-for="n in detail.needs" :key="n">{{ n }}</li>
            </ul>
          </div>
          <button
            class="apply-btn" :disabled="binding || !online"
            :title="online ? '' : '未连接后端'"
            @click="doBind(detail)"
          >{{ binding ? '处理中…' : detail.oauth_ready ? '开始授权' : '尝试绑定' }}</button>
          <p v-if="bindMsg" class="bd-msg">{{ bindMsg }}</p>
          <p v-if="!online" class="bd-note">未连接后端：无法读取绑定能力。</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hero {
  margin-top: 22px; border-radius: 16px; min-height: 220px;
  background: linear-gradient(105deg, #3f6fe0 0%, #5b8bef 55%, #7aa4f5 100%);
  color: #fff; display: flex; align-items: center; justify-content: space-between;
  padding: 34px 44px; overflow: hidden; position: relative;
}
.hero-copy h2 { font-size: 26px; line-height: 1.4; }
.hero-copy p { margin-top: 12px; font-size: 12.5px; opacity: 0.85; max-width: 340px; line-height: 1.7; }
.hero-art { position: relative; width: 340px; height: 160px; }
.orbit { position: absolute; border-radius: 50%; border: 1px solid rgba(255,255,255,0.35); }
.o1 { width: 150px; height: 150px; right: 90px; top: 10px; }
.o2 { width: 110px; height: 110px; right: 30px; top: 30px; border-style: dashed; }
.o3 { width: 70px; height: 70px; right: 160px; top: 60px; background: rgba(255,255,255,0.12); border: none; }
.hero-chip {
  position: absolute; right: 60px; top: 22px;
  display: inline-flex; align-items: center; gap: 6px;
  background: #fff; color: var(--t1); border-radius: 999px; padding: 6px 14px; font-size: 12.5px; font-weight: 600;
}
.section-t { font-size: 14px; font-weight: 600; margin: 26px 0 14px; }
.tool-ic { width: 40px; height: 40px; border-radius: 10px; color: #fff; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.tool-info { flex: 1; }
.tool-name { font-size: 14px; font-weight: 600; }
.tool-desc { font-size: 12px; color: var(--t2); margin-top: 3px; }
.tool-desc.soon { color: var(--t3); }
.soon-tag { font-size: 12px; color: var(--t3); }

/* T-034：绑定说明弹层 */
.modal-mask {
  position: fixed; inset: 0; background: rgba(15, 17, 21, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 50; padding: 24px;
}
.modal { width: 460px; max-width: 100%; max-height: 86vh; overflow: auto; position: relative; padding: 0; }
.modal-x { position: absolute; top: 12px; right: 12px; z-index: 2; }
.bd-head { padding: 20px 22px 14px; background: var(--line-2); border-bottom: 1px solid var(--line); }
.bd-title { font-size: 15px; font-weight: 700; }
.bd-sub { margin: 6px 0 0; font-size: 12px; color: var(--t2); line-height: 1.6; }
.bd-body { padding: 16px 22px 22px; }
.bd-needs { border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: var(--line-2); }
.bd-t { font-size: 11.5px; color: var(--t3); margin-bottom: 6px; }
.bd-needs ul { margin: 0; padding-left: 18px; font-size: 12px; color: var(--t1); line-height: 1.8; }
.apply-btn {
  margin-top: 16px; width: 100%; height: 38px; border-radius: 9px;
  background: var(--violet); color: #fff; font-size: 13.5px; font-weight: 600;
  display: inline-flex; align-items: center; justify-content: center;
}
.apply-btn:disabled { background: var(--violet-soft); cursor: default; }
.bd-msg { margin: 10px 0 0; font-size: 12px; color: var(--err); white-space: pre-wrap; line-height: 1.6; }
.bd-note { margin: 10px 0 0; font-size: 11.5px; color: var(--t3); }
</style>
