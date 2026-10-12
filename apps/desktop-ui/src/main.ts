import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '@/styles/app.css';
import App from './App.vue';
import { router } from './router';
import { useThemeStore } from './stores/theme';
import { useI18nStore } from './stores/i18n';
import { useUiStore } from './stores/ui';
import { hasCustomTitleBar, onShortcut } from './api/backend';

const app = createApp(App);
app.use(createPinia());
// T-051：挂载前先把主题落到 <html data-theme>，避免首帧闪一下亮色
useThemeStore().init();
// T-052：语言同样先定好，避免首帧中文再跳英文
useI18nStore().init();
// T-120：自定义标题栏（无边框窗口）只在 Windows/Linux 开。给 <html> 挂个开关，
// 关掉时 CSS 里的 --titlebar-h 归零——那边还有原生标题栏，不该再白留一条 36px 空带。
// 放在挂载前：它决定首帧布局，晚一步会看到内容先下移一条带再跳回来。
document.documentElement.classList.toggle('custom-chrome', hasCustomTitleBar());
app.use(router);

// T-055：接住主进程全局快捷键——即便焦点在别的软件也能唤起
const ui = useUiStore();
onShortcut((msg) => {
  ui.meMenuOpen = false;
  if (msg.action === 'new-task') {
    router.push('/');
  }
});

app.mount('#app');
