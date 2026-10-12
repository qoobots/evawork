<script setup lang="ts">
import UIcon from '@/components/UIcon.vue';
import { messages } from '@/data/mock';
import { useUiStore } from '@/stores/ui';
import { useRouter } from 'vue-router';

const ui = useUiStore();
const router = useRouter();

// 消息动作：有真实目标的接上跳转，其余关闭弹层（不再静默无反应）
function onAction(action: string) {
  ui.messagesOpen = false;
  if (action.includes('设置')) router.push('/admin/context');
  else if (action.includes('体验')) router.push('/office');
  else if (action.includes('详情')) router.push('/design');
}
</script>

<template>
  <div class="modal-mask" @click.self="ui.messagesOpen = false">
    <div class="modal msg-modal">
      <button class="icon-btn modal-close" @click="ui.messagesOpen = false"><UIcon name="x" :size="15" /></button>
      <div class="modal-title">消息</div>
      <div class="msg-list">
        <div v-for="m in messages" :key="m.title" class="msg-item">
          <div class="msg-top">
            <span class="msg-title">{{ m.title }}</span>
            <span class="msg-time">{{ m.time }}</span>
          </div>
          <p class="msg-body">{{ m.body }}</p>
          <button class="btn msg-btn" @click="onAction(m.action)">{{ m.action }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg-modal { width: 620px; padding: 28px; }
.msg-list { margin-top: 16px; display: flex; flex-direction: column; gap: 14px; }
.msg-item { border-bottom: 1px solid var(--line-2); padding-bottom: 16px; }
.msg-item:last-child { border-bottom: none; padding-bottom: 4px; }
.msg-top { display: flex; justify-content: space-between; gap: 16px; }
.msg-title { font-size: 13.5px; font-weight: 600; }
.msg-time { font-size: 12px; color: var(--t3); flex: none; }
.msg-body { margin-top: 6px; font-size: 12.5px; color: var(--t2); line-height: 1.7; }
.msg-btn { margin-top: 10px; height: 28px; font-size: 12px; }
</style>
