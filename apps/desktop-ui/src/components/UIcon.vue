<script setup lang="ts">
import { computed } from 'vue';
import { ICONS } from './icons';

const props = defineProps<{ name: string; size?: number }>();

/**
 * T-117：必须是 computed。
 *
 * 原来这里是一次性求值的普通常量 —— 组件实例被复用（同位置换 `:name`）时 prop 变了
 * 但 path 不变，界面上的图标永远停在首次挂载那个：折叠箭头不翻转、管理模式的
 * check/sliders 也不切换。图标组件读 prop 却不跟着 prop 走，是它自己的错。
 */
const path = computed(() => ICONS[props.name] ?? '');
</script>

<template>
  <svg
    :width="size ?? 16"
    :height="size ?? 16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    v-html="path"
  />
</template>
