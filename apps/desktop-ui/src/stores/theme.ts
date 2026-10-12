import { defineStore } from 'pinia';

export type ThemeMode = 'light' | 'dark' | 'system';

const KEY = 'evawork.theme';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

/**
 * 主题（T-051）：令牌化之后，切主题只是换 `<html data-theme>` 上的一组变量。
 *
 * - `system` 跟随系统，并**持续监听**系统偏好变化（不是只在启动时读一次）；
 * - 选择记在 localStorage，无后端也能记住；
 * - 所有组件只准用 `var(--*)`，不再写死色值，否则暗色下会出现"半截变暗"。
 */
export const useThemeStore = defineStore('theme', {
  state: () => ({
    mode: 'light' as ThemeMode,
    resolved: 'light' as 'light' | 'dark',
  }),
  actions: {
    init() {
      const saved = (typeof localStorage !== 'undefined' && localStorage.getItem(KEY)) || '';
      this.mode = (['light', 'dark', 'system'] as ThemeMode[]).includes(saved as ThemeMode)
        ? (saved as ThemeMode)
        : 'light';
      this.apply();

      // 跟随系统：系统改了主题，这边也得跟着改
      if (typeof window !== 'undefined' && window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
          if (this.mode === 'system') this.apply();
        });
      }
    },
    apply() {
      this.resolved = this.mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : this.mode;
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-theme', this.resolved);
      }
    },
    set(mode: ThemeMode) {
      this.mode = mode;
      this.apply();
      if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, mode);
    },
    toggle() {
      this.set(this.resolved === 'dark' ? 'light' : 'dark');
    },
  },
});
