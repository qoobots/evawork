<script setup lang="ts">
/**
 * T-089：PTY 终端（xterm.js + 后端真 ConPTY 会话）。
 *
 * 与「执行过程」里那个 `terminal` 工具不是一回事：那个是**伪持久化会话**（cd 能记住，
 * 但没有窗口尺寸、没有交互型程序），这里是真 PTY——vim/ssh/python 交互这类程序能正常用。
 *
 * 三个必须做对的地方：
 * - **连接状态要说真话**：连不上/被沙箱拒绝/会话退出都得显示原因，不能给一块黑屏假装还在跑；
 * - **尺寸要同步**：xterm 的 cols/rows 变了要告诉后端（不然换行全乱），用 FitAddon 自适应；
 * - **断开即释放**：关闭面板/卸载时关 ws，后端随之终止进程，不留孤儿。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import UIcon from './UIcon.vue';
import { backendURL } from '@/api/backend';

const props = withDefaults(defineProps<{ mode?: string; open?: boolean }>(), { mode: 'manual', open: true });

const host = ref<HTMLDivElement>();
const state = ref<'idle' | 'connecting' | 'live' | 'closed' | 'error'>('idle');
const note = ref('');
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
let sid = `pty-${Math.random().toString(36).slice(2, 8)}`;
const lines = ref(0);

function wsURL(): string {
  const base = backendURL();
  if (!base) return '';
  return `${base.replace(/^http/, 'ws')}/api/pty/${sid}?mode=${encodeURIComponent(props.mode)}`;
}

function mountTerm() {
  if (term || !host.value) return;
  term = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12.5,
    theme: {
      background: getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() || '#14161a',
      foreground: getComputedStyle(document.documentElement).getPropertyValue('--t1').trim() || '#d8dae0',
    },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host.value);
  fit.fit();
  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'in', data }));
    }
  });
  term.onResize(({ cols, rows }) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });
}

function connect() {
  const url = wsURL();
  if (!url) {
    state.value = 'error';
    note.value = '未连接后端（Electron 未注入地址）';
    return;
  }
  mountTerm();
  state.value = 'connecting';
  note.value = '';
  ws = new WebSocket(url);

  ws.onopen = () => {
    state.value = 'live';
    // 尺寸要在会话建立后同步一次：后端启动用的是默认 120×30
    if (term) ws?.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data as string) as { type: string; data?: string; message?: string; cwd?: string };
      if (msg.type === 'out' && msg.data) {
        term?.write(msg.data);
        lines.value++;
      } else if (msg.type === 'ready') {
        note.value = msg.cwd ? `会话已就绪：${msg.cwd}` : '会话已就绪';
      } else if (msg.type === 'exit') {
        state.value = 'closed';
        note.value = '进程已退出（重新连接会新建一个会话）';
      } else if (msg.type === 'error') {
        state.value = 'error';
        note.value = msg.message || '终端启动失败';
      }
    } catch {
      // 非 JSON 帧：当作原始输出，别把内容吞掉
      term?.write(String(ev.data));
    }
  };
  ws.onerror = () => {
    state.value = 'error';
    note.value = '终端连接失败（后端未启用 WebSocket 或地址不可达）';
  };
  ws.onclose = () => {
    if (state.value === 'live' || state.value === 'connecting') {
      state.value = 'closed';
      note.value = note.value || '连接已断开';
    }
  };
}

function disconnect() {
  if (ws) {
    try {
      ws.close();
    } catch {
      /* 已关闭就算了 */
    }
    ws = null;
  }
}

function reconnect() {
  disconnect();
  sid = `pty-${Math.random().toString(36).slice(2, 8)}`;
  term?.reset();
  lines.value = 0;
  connect();
}

function onResize() {
  try {
    fit?.fit();
  } catch {
    /* 未挂载时忽略 */
  }
}

onMounted(() => {
  if (props.open) connect();
  window.addEventListener('resize', onResize);
});
watch(
  () => props.open,
  (v) => {
    if (v && !ws) {
      // 重新打开时先量一次尺寸（挂载期间容器可能还没布局完）
      requestAnimationFrame(() => {
        mountTerm();
        onResize();
        connect();
      });
    }
  },
);
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  disconnect();
  term?.dispose();
  term = null;
});

const badge = computed(() => {
  return (
    {
      idle: '未连接',
      connecting: '连接中',
      live: '运行中',
      closed: '已结束',
      error: '不可用',
    } as Record<string, string>
  )[state.value];
});
</script>

<template>
  <div class="tp">
    <div class="tp-head">
      <span class="tp-title"><UIcon name="code" :size="13" /> 终端</span>
      <span class="tp-badge" :class="state">{{ badge }}</span>
      <span class="tp-note" :title="note">{{ note }}</span>
      <button class="tp-btn" title="新建会话" @click="reconnect"><UIcon name="refresh" :size="12" /></button>
    </div>
    <div ref="host" class="tp-body" />
    <p v-if="state === 'error'" class="tp-hint">
      终端不可用：{{ note }}。
    </p>
  </div>
</template>

<style scoped>
.tp { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.tp-head { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--line-2); }
.tp-title { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; font-weight: 600; }
.tp-badge { height: 20px; padding: 0 8px; border-radius: 5px; font-size: 11px; background: var(--line-2); color: var(--t2); display: inline-flex; align-items: center; }
.tp-badge.live { background: var(--ok-bg); color: var(--ok); }
.tp-badge.error { background: var(--err-bg); color: var(--err); }
.tp-badge.closed { background: var(--orange-bg); color: var(--orange); }
.tp-note { flex: 1; font-size: 11px; color: var(--t3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-btn { color: var(--t2); padding: 4px; border-radius: 5px; display: inline-flex; }
.tp-btn:hover { background: var(--line-2); color: var(--t1); }
.tp-body { flex: 1; min-height: 220px; overflow: hidden; padding: 6px; }
.tp-body :deep(.xterm) { height: 100%; }
.tp-hint { margin: 6px 8px 0; font-size: 11.5px; color: var(--t3); line-height: 1.6; }
</style>
