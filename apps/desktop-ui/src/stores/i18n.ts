import { defineStore } from 'pinia';
import { translate, type Locale } from '@/i18n';

const KEY = 'evawork.locale';

/**
 * 语言（T-052）：切换会**真的改变界面文案**（导航 / 菜单 / 页头 / 通用按钮），
 * 选择记在 localStorage，并同步 `<html lang>`（对读屏与拼写检查都有意义）。
 */
export const useI18nStore = defineStore('i18n', {
  state: () => ({
    locale: 'zh' as Locale,
  }),
  actions: {
    init() {
      const saved = (typeof localStorage !== 'undefined' && localStorage.getItem(KEY)) || '';
      this.locale = saved === 'en' ? 'en' : 'zh';
      this.apply();
    },
    apply() {
      if (typeof document !== 'undefined') document.documentElement.lang = this.locale;
    },
    set(locale: Locale) {
      this.locale = locale;
      this.apply();
      if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, locale);
    },
    /** 取不到键时回退到传入的中文原文，界面不会出现空白或 `undefined`。 */
    t(key: string, fallback = ''): string {
      return translate(this.locale, key, fallback);
    },
  },
});
