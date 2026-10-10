<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import UIcon from '@/components/UIcon.vue';
import { useI18nStore } from '@/stores/i18n';

const route = useRoute();
const i18n = useI18nStore();

/* T-128：设置与管理控制台合并成一个界面。
   上一组是"设置"（本机偏好，改这台电脑 / EVA 怎么干活）；
   下一组是"管理"（账号与服务资产，接真后端）。分组头就是这条分界。
   导航标签走 i18n（中文作键，en 字典补翻译，zh 自动回退）；用 computed 包一层，
   这样切语言时导航会跟着重算。 */
const groups = computed(() => [
  {
    title: i18n.t('设置'),
    items: [
      { k: 'general', label: i18n.t('通用'), icon: 'gear', to: '/admin/general' },
      { k: 'privacy', label: i18n.t('隐私模式'), icon: 'shield', to: '/admin/privacy' },
      { k: 'chat', label: i18n.t('对话流'), icon: 'chat', to: '/admin/chat' },
      { k: 'model', label: i18n.t('模型'), icon: 'sparkle', to: '/admin/model' },
      { k: 'browser', label: i18n.t('浏览器'), icon: 'web', to: '/admin/browser' },
      { k: 'computer', label: i18n.t('电脑控制'), icon: 'monitor', to: '/admin/computer' },
      { k: 'worktree', label: i18n.t('工作树'), icon: 'folder', to: '/admin/worktree' },
      { k: 'context', label: i18n.t('上下文与记忆'), icon: 'book', to: '/admin/context' },
      { k: 'agent', label: i18n.t('智能体'), icon: 'sparkle', to: '/admin/agent' },
      { k: 'mobile', label: i18n.t('EVA 移动端'), icon: 'phone', to: '/admin/mobile' },
      { k: 'beta', label: i18n.t('Beta'), icon: 'sliders', to: '/admin/beta' },
      { k: 'about', label: i18n.t('关于 EvaWork'), icon: 'info', to: '/admin/about' },
    ],
  },
  {
    title: i18n.t('管理'),
    items: [
      { k: 'account', label: i18n.t('账号设置'), icon: 'user', to: '/admin/account' },
      { k: 'usage', label: i18n.t('用量管理'), icon: 'chart', to: '/admin/usage' },
      { k: 'mcp', label: i18n.t('MCP'), icon: 'gear', to: '/admin/mcp' },
      { k: 'rules', label: i18n.t('规则'), icon: 'book', to: '/admin/rules' },
      { k: 'commands', label: i18n.t('命令'), icon: 'zap', to: '/admin/commands' },
      { k: 'integrations', label: i18n.t('外部应用授权'), icon: 'link', to: '/admin/integrations' },
      { k: 'cloud-env', label: i18n.t('云端运行环境'), icon: 'cloud', to: '/admin/cloud-env' },
      { k: 'dashboard', label: i18n.t('仪表盘'), icon: 'monitor', to: '/admin/dashboard' },
      { k: 'favorites', label: i18n.t('收藏盒'), icon: 'box', to: '/admin/favorites' },
    ],
  },
]);
</script>

<template>
  <div class="admin admin-console">
    <aside class="a-nav">
      <div class="a-logo">EVA</div>
      <!-- 返回主界面：管理控制台是独立深色壳，没有主壳侧栏兜底，不给出口用户就困在 /admin 里 -->
      <router-link to="/" class="a-item a-back">
        <UIcon name="arrow-left" :size="14" /><span>{{ i18n.t('返回主界面') }}</span>
      </router-link>
      <div class="a-divider" />
      <template v-for="(g, gi) in groups" :key="gi">
        <div class="a-group">{{ g.title }}</div>
        <div v-if="gi > 0" class="a-divider" />
        <router-link v-for="n in g.items" :key="n.k" :to="n.to" class="a-item" :class="{ active: route.path === n.to }">
          <UIcon :name="n.icon" :size="14" /><span>{{ n.label }}</span>
        </router-link>
      </template>
    </aside>

    <div class="a-main">
      <header class="a-top">
        <span class="spacer" />
        <button class="a-dl" data-coming aria-disabled="true" :title="i18n.t('下载客户端功能开发中，敬请期待')" disabled><UIcon name="download" :size="12" /> {{ i18n.t('下载 EvaCode') }}</button>
        <div class="a-avatar">F</div>
      </header>
      <div class="a-body" tabindex="0">
        <router-view />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* T-100：去掉整页 user-select:none —— 管理页里的用量数字、配置值也得能选中复制。
   侧栏 `.a-nav` 是 <aside>，已由全局"外壳禁用"规则接管。 */
/* T-120：顶部让出窗口栏（原生标题栏已去掉，窗口按钮浮在右上角）。
   留白加在这里而不是外层容器：背景画到 padding 上，那条带才是控制台自己的深色，
   不会在深色面板上方横一条亮带。 */
.admin { display: flex; height: 100vh; padding-top: var(--titlebar-h); background: var(--ac-app-bg); color: var(--ac-text); }
/* T-128：并进设置后导航项变多，侧栏自己滚，不能把"关于"挤出屏幕 */
.a-nav { width: 190px; flex: none; padding: 14px 10px; border-right: 1px solid var(--ac-nav-border); overflow: auto; }
.a-logo { font-weight: 800; letter-spacing: 1px; padding: 4px 10px 16px; font-size: 15px; }
.a-back { margin-bottom: 6px; }
.a-divider { border-top: 1px solid var(--ac-nav-border); margin: 10px 8px; }
/* T-128：分组头——"设置/管理"这条分界得看得见，否则 21 项平铺分不清哪组是哪组 */
.a-group {
  padding: 2px 10px 6px; font-size: 10.5px; font-weight: 700;
  letter-spacing: 0.6px; color: var(--ac-text-faint);
}
.a-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border-radius: 8px; font-size: 13px; color: var(--ac-text-muted-strong); margin-bottom: 2px;
}
.a-item:hover { color: var(--ac-white); background: var(--ac-hover); }
.a-item.active { color: var(--ac-white); background: var(--ac-active); }
.a-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.a-top { display: flex; align-items: center; gap: 12px; padding: 10px 20px; }
.spacer { flex: 1; }
.a-dl {
  display: inline-flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 14px; border-radius: 8px;
  background: var(--ac-green); color: var(--ac-green-fg); font-size: 12.5px; font-weight: 600;
}
.a-avatar {
  width: 30px; height: 30px; border-radius: 50%;
  background: linear-gradient(135deg, var(--ac-avatar-1), var(--ac-avatar-2)); color: var(--ac-white);
  display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700;
}
.a-body { flex: 1; overflow: auto; padding: 28px 44px; }
</style>
