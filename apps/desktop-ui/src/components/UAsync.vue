<script setup lang="ts">
/**
 * 统一的加载 / 错误 / 重试容器（T-050 基建）。
 * 用法：<UAsync :loading="x.loading" :error="x.error" @retry="x.reload"> 内容 </UAsync>
 */
defineProps<{
  loading?: boolean;
  error?: string;
  hint?: string;
}>();

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="uasync">
    <div v-if="error" class="ua-box ua-err">
      <span class="ua-msg">{{ error }}</span>
      <button class="ua-btn" @click="emit('retry')">重试</button>
    </div>
    <div v-else-if="loading" class="ua-box ua-load">
      <span class="ua-spin" /> {{ hint || '加载中…' }}
    </div>
    <slot v-else />
  </div>
</template>

<style scoped>
.ua-box {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 16px; border-radius: 10px; font-size: 12.5px;
}
.ua-load { background: var(--line-2); color: var(--t2); }
.ua-err { background: var(--err-bg); color: var(--err); }
.ua-msg { flex: 1; }
.ua-btn {
  flex: none; height: 24px; padding: 0 12px; border-radius: 6px;
  border: 1px solid currentColor; background: transparent; color: inherit; font-size: 12px;
}
.ua-spin {
  width: 12px; height: 12px; border-radius: 50%; flex: none;
  border: 2px solid var(--line); border-top-color: var(--violet);
  animation: ua-spin 0.7s linear infinite;
}
@keyframes ua-spin { to { transform: rotate(360deg); } }
</style>
