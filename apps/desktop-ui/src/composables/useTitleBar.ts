import { nextTick, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { hasCustomTitleBar, setTitleBarTheme } from '@/api/backend';
import { useThemeStore } from '@/stores/theme';

/**
 * T-120：让窗口栏的颜色跟内容一致。
 *
 * 去掉原生标题栏后，顶部那一条其实就是应用自己的内容（背景 --bg），只剩系统画的三个窗口
 * 按钮是外部元素——它们默认取系统色，在深色界面里会横出一条亮带。所以每次主题变化、每次
 * 路由变化都读一次**真实的计算值**上报给主进程。
 *
 * 为什么读 computed style 而不是直接写死令牌值：亮/暗两套令牌是不同的值，而且管理控制台
 * 用的是另一套常驻深色令牌（挂 `.admin-console` 上），写死就等于埋一处"改了主题忘了改这里"。
 */
export function useTitleBarTheme(): void {
  const theme = useThemeStore();
  const route = useRoute();

  const report = async () => {
    if (!hasCustomTitleBar()) return;
    // 等 DOM 更新完再读：主题是先改 <html data-theme> 再触发这里的
    await nextTick();
    const root = getComputedStyle(document.documentElement);
    const consoleEl = document.querySelector('.admin-console');
    const bg = (consoleEl ? getComputedStyle(consoleEl).getPropertyValue('--ac-app-bg') : root.getPropertyValue('--bg')).trim();
    const fg = (consoleEl ? getComputedStyle(consoleEl).getPropertyValue('--ac-text') : root.getPropertyValue('--t1')).trim();
    // 读不到就保持主进程当前的兜底色，别把空串传下去（setTitleBarOverlay 会直接抛）
    if (!bg || !fg) return;
    setTitleBarTheme({ color: bg, symbolColor: fg });
  };

  onMounted(report);
  watch(() => theme.resolved, report);
  watch(() => route.path, report);
}
