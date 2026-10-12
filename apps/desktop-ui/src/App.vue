<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import SideNav from '@/components/SideNav.vue';
import MessagesModal from '@/components/MessagesModal.vue';
import { useUiStore } from '@/stores/ui';
import { hasCustomTitleBar } from '@/api/backend';
import { useTitleBarTheme } from '@/composables/useTitleBar';

const route = useRoute();
const ui = useUiStore();
const isAdmin = computed(() => route.path.startsWith('/admin'));

/* T-120：自定义标题栏（无边框窗口）。顶部不再单独占一行原生标题栏，内容第一行自己就是
   窗口栏，最小化/最大化/关闭由系统 overlay 画在右上角。 */
const customChrome = hasCustomTitleBar();
// 窗口按钮是系统画的，颜色得由这边按当前主题上报（见 composable 注释）
useTitleBarTheme();
</script>

<template>
  <!-- 管理账户是独立的深色控制台，不带主壳侧栏；仍用 <main> 提供 landmark（消 axe region/landmark-one-main） -->
  <main v-if="isAdmin" class="app-admin-main">
    <router-view />
  </main>
  <div v-else class="app-shell">
    <SideNav />
    <main class="app-main">
      <!-- T-120：顶部那 36px 由 .app-main 的 padding 让出来（见样式注释），
           滚动交给内层，内容才不会滚到窗口按钮底下 -->
      <div class="app-main-body"><router-view /></div>
    </main>

    <MessagesModal v-if="ui.messagesOpen" />
  </div>

  <!-- T-120：窗口栏拖拽带。原生标题栏没了，拖窗口靠这一条；
       左端跟着侧栏宽度走——侧栏那一列顶部要留给模式切换按钮（它们得能点，不能被拖拽层吃掉）。
       z-index 盖过弹层：弹层开着时顶部仍是窗口栏，拖窗口不该被"点遮罩关弹层"抢走。 -->
  <div
    v-if="customChrome"
    class="titlebar-drag"
    :class="{ 'left-flush': isAdmin }"
    :style="isAdmin ? undefined : { left: `${ui.navWidth}px` }"
  />
</template>

<style scoped>
.app-shell { display: flex; height: 100vh; }
/* T-120：主区顶部让出窗口栏的高度（内容不能钻到窗口按钮底下）。
   留白加在**外层**、滚动交给内层：直接给 overflow:auto 的容器加 padding-top，
   一滚动就被带走了（内容会从拖拽带下面穿过去）。 */
.app-main { flex: 1; min-width: 0; display: flex; flex-direction: column; padding-top: var(--titlebar-h); }
.app-main-body { flex: 1; min-height: 0; overflow: auto; }
.app-admin-main { display: block; height: 100vh; }
/* T-120：拖拽带本体。透明（底下就是应用自己的内容，颜色天然一致），只负责拖窗口 */
.titlebar-drag {
  position: fixed; top: 0; right: 0; height: var(--titlebar-h);
  z-index: 1000; -webkit-app-region: drag;
}
/* 管理控制台没有主壳侧栏，整条都归它 */
.titlebar-drag.left-flush { left: 0; }
</style>
