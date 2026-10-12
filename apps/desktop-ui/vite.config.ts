import { defineConfig, type Plugin, type HmrContext } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// 固定端口 1420：Electron 主进程与 scripts/dev.mjs 都连它。
const host = process.env.DEV_HOST || false;

// HMR 见文件末 sfcStyleFullReload：SFC 样式改了要整页重载，
// 否则新 scope-id 配不上旧 DOM，组件样式全丢（看似"样式崩溃"）。

// 返回类型必须写成 Plugin：否则 `apply` 被推成 string、ctx 也不匹配 vite 的 HmrContext，
// `vue-tsc` 会在 plugins 数组这里报 TS2769。
function sfcStyleFullReload(): Plugin {
  return {
    name: 'evawork-sfc-style-full-reload',
    apply: 'serve',
    handleHotUpdate(ctx: HmrContext) {
      if (!ctx.file.endsWith('.vue')) return;
      ctx.server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}

export default defineConfig({
  // 相对 base：打包后 UI 经 Electron `file://` 加载（resources/ui），绝对 '/assets' 会指向文件系统根导致 404。
  base: './',
  plugins: [vue(), sfcStyleFullReload()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/node_modules/**'] },
  },
  envPrefix: ['VITE_'],
  build: {
    // Electron 31 ≈ Chromium 126，目标放宽到 chrome120 兼顾体积与兼容
    target: 'chrome120',
    minify: 'esbuild',
    sourcemap: !!process.env.EVAWORK_DEV_DEBUG,
    chunkSizeWarningLimit: 500,
  },
});
