<script setup lang="ts">
/**
 * T-089：改动审阅（unified diff）。
 *
 * 为什么前端算而不是后端给好：后端只负责如实给出"改动前/改动后"两份原文，
 * 怎么呈现是展示层的事；而且原文可能很大，diff 只需行级结果，没必要让后端多算一遍。
 *
 * 诚实边界：只做**行级** unified diff（够看"改了哪几行"），不做字符级高亮——
 * 字符级在长行上可读性反而更差。
 */
import { computed } from 'vue';
import { diffLines } from 'diff';

const props = withDefaults(
  defineProps<{
    before?: string;
    after?: string;
    name?: string;
    /** 超过就只显示前 N 行（真要细看请打开文件） */
    max?: number;
  }>(),
  { before: '', after: '', name: '', max: 400 },
);

interface Row {
  kind: 'add' | 'del' | 'same';
  text: string;
}

const MAX_ROWS = props.max;

const rows = computed<Row[]>(() => {
  const parts = diffLines(props.before || '', props.after || '');
  const out: Row[] = [];
  for (const p of parts) {
    // diff 库按块给；去掉尾部空行再切，避免末尾多出一个空行噪声
    const lines = p.value.replace(/\n$/, '').split('\n');
    for (const text of lines) {
      if (p.added) out.push({ kind: 'add', text });
      else if (p.removed) out.push({ kind: 'del', text });
      else out.push({ kind: 'same', text });
    }
  }
  return out;
});

const stats = computed(() => {
  let add = 0;
  let del = 0;
  for (const r of rows.value) {
    if (r.kind === 'add') add++;
    else if (r.kind === 'del') del++;
  }
  return { add, del };
});

const shown = computed(() => rows.value.slice(0, MAX_ROWS));
const omitted = computed(() => Math.max(0, rows.value.length - shown.value.length));
const isNew = computed(() => !(props.before || '').length && !!props.after);
</script>

<template>
  <div class="dv">
    <div class="dv-head">
      <span v-if="name" class="dv-name">{{ name }}</span>
      <span v-if="isNew" class="dv-tag new">新建文件</span>
      <span v-else class="dv-stat">
        <span class="add">+{{ stats.add }}</span>
        <span class="del">-{{ stats.del }}</span>
      </span>
      <span class="dv-hint">行级 diff</span>
    </div>
    <div class="dv-body">
      <div v-for="(r, i) in shown" :key="i" class="dv-row" :class="r.kind">
        <span class="dv-sign">{{ r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' ' }}</span>
        <span class="dv-text">{{ r.text || ' ' }}</span>
      </div>
    </div>
    <p v-if="omitted" class="dv-more">… 另有 {{ omitted }} 行未显示（改动过大，建议直接打开文件查看）</p>
  </div>
</template>

<style scoped>
.dv { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-top: 8px; }
.dv-head {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; background: var(--line-2); font-size: 11.5px; color: var(--t2);
}
.dv-name { font-weight: 600; color: var(--t1); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dv-tag.new { background: var(--ok-bg); color: var(--ok); padding: 1px 6px; border-radius: 4px; }
.dv-stat { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dv-stat .add { color: var(--ok); margin-right: 6px; }
.dv-stat .del { color: var(--err); }
.dv-hint { margin-left: auto; color: var(--t3); }
.dv-body { max-height: 320px; overflow: auto; background: var(--panel); }
.dv-row {
  display: flex; gap: 8px; padding: 0 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; line-height: 1.65; white-space: pre-wrap; word-break: break-all;
}
.dv-row.add { background: rgba(12, 178, 119, 0.10); }
.dv-row.del { background: rgba(229, 72, 77, 0.10); }
.dv-sign { flex: none; width: 8px; color: var(--t3); user-select: none; }
.dv-row.add .dv-sign { color: var(--ok); }
.dv-row.del .dv-sign { color: var(--err); }
.dv-text { flex: 1; }
.dv-more { margin: 0; padding: 6px 10px; font-size: 11px; color: var(--t3); border-top: 1px solid var(--line); }
</style>
