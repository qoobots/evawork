<script setup lang="ts">
/**
 * `disabled` 用于**诚实标注尚未实现的开关**（配合 `data-coming` 使用）：
 * 点了没反应的开关比没有开关更糟——用户会以为生效了。禁用时既不 emit 也不改外观状态，
 * `title` 里说明原因。
 */
const props = defineProps<{ modelValue: boolean; label?: string; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();
function onClick() {
  if (props.disabled) return;
  emit('update:modelValue', !props.modelValue);
}
</script>

<template>
  <button
    type="button"
    class="switch"
    :class="{ on: modelValue, off: disabled }"
    role="switch"
    :aria-checked="modelValue"
    :aria-disabled="disabled || undefined"
    :aria-label="label ?? '切换'"
    @click="onClick"
  />
</template>

<style scoped>
/* 禁用态要一眼看出"点了也不会变"：变淡 + 禁用光标（样式放组件内，避免动公共样式表） */
.switch.off {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
