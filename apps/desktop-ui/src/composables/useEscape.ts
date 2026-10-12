import { onMounted, onUnmounted } from 'vue';

/**
 * Esc 关闭浮层（T-053 键盘可达）。
 *
 * 弹层只给"点遮罩关闭"是不够的：键盘用户既没有鼠标也没有焦点路径，
 * 于是被困在弹层里。全局监听在挂载期间生效，卸载时自动摘掉。
 */
export function useEscape(close: () => void) {
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' || e.key === 'Esc') close();
  }
  onMounted(() => window.addEventListener('keydown', onKey));
  onUnmounted(() => window.removeEventListener('keydown', onKey));
}
