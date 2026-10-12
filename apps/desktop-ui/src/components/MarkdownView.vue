<script setup lang="ts">
/**
 * T-089：回答正文的 Markdown / Mermaid / 代码高亮渲染。
 *
 * 三个不容妥协的点：
 * - **不开 HTML**：模型输出里可能夹带 HTML/脚本，渲染在 Electron 里等同本机权限，
 *   `html:false` 让原始 HTML 一律转义（宁可少点样式，不能开一个 XSS 口子）。
 * - **流式不逐帧重排**：一个 token 渲染一次整篇会把主线程打满，
 *   正文变化时按 120ms 节流重算，流式末尾再补渲一次。
 * - **Mermaid 懒加载**：它体积不小，只在正文里真出现 ```mermaid 时才动态引入，
 *   且失败时保留源码 + 报错原因，而不是渲染成一片空白。
 */
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';

const props = withDefaults(defineProps<{ source: string; streaming?: boolean; breaks?: boolean }>(), {
  streaming: false,
  breaks: false,
});

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 代码高亮：无语言标注时按自动识别；识别不出就退回转义纯文本，绝不把源码当 HTML 吞进去 */
function highlight(code: string, lang: string): string {
  let body = esc(code);
  let label = lang || '';
  if (lang && hljs.getLanguage(lang)) {
    try {
      body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      body = esc(code);
    }
  } else if (!lang) {
    try {
      const auto = hljs.highlightAuto(code);
      body = auto.value;
      label = auto.language || '';
    } catch {
      body = esc(code);
    }
  }
  const tag = label ? ` data-lang="${esc(label)}"` : '';
  return `<pre class="md-code"${tag}><code class="hljs">${body}</code></pre>`;
}

// 外链一律新窗口打开 + 切断 window 引用（渲染器里没有 shell 权限，别把用户带到 phishing 页还留着关系）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const baseLinkOpen = (tokens: any, idx: number, opts: any, _env: any, self: any) => self.renderToken(tokens, idx, opts);

/**
 * T-104：渲染器按 `breaks` 分两个实例缓存（重建 MarkdownIt 不便宜，而 `breaks` 每次使用都是常量）。
 *
 * 对话正文要 `breaks: true`：模型爱用单个换行分行，软换行会把两行并成一行。
 * 旧代码是用容器 `white-space: pre-wrap` 兜这件事的，但那会连 markdown-it 输出里**块级标签之间的换行符**
 * 一起当成真换行 —— 每个 `<p>`/`<li>`/`</ul>` 后面都多出一个空行，看起来就是"双倍行距"。
 * 语义该由渲染器给（`<br>` 是单个行距），而不是让容器把 HTML 源码的缩进换行也渲染出来。
 *
 * 文档预览保持 `breaks: false`：仓库里的 `.md` 多是 80 列硬折行，硬换行会把一整句话拆断。
 */
const renderers = new Map<boolean, InstanceType<typeof MarkdownIt>>();

function rendererFor(breaks: boolean): InstanceType<typeof MarkdownIt> {
  const hit = renderers.get(breaks);
  if (hit) return hit;
  const md = new MarkdownIt({
    html: false, // 见文件头：正文里的原始 HTML 一律转义
    linkify: true,
    breaks,
    highlight,
  });
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    // attrGet 的类型是 string | number | null，先归一成字符串再判协议
    const href = String(tokens[idx].attrGet('href') ?? '');
    if (/^https?:/i.test(href)) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noreferrer noopener');
    }
    return baseLinkOpen(tokens, idx, opts, env, self);
  };
  renderers.set(breaks, md);
  return md;
}

const html = ref('');
const mermaidBlocks = shallowRef<string[]>([]);
let timer: number | undefined;
let seq = 0;

function render() {
  const src = props.source || '';
  try {
    html.value = rendererFor(props.breaks).render(src);
  } catch (e) {
    // 渲染库炸了也不能让正文消失：退回纯文本（转义后）并把原因说清楚
    html.value = `<pre class="md-plain">${esc(src)}\n\n（Markdown 渲染失败：${esc((e as Error).message)}）</pre>`;
  }
  mermaidBlocks.value = collectMermaid(src);
}

/** 从源码里摘出 ```mermaid 代码块（渲染成图表需要源码，不是渲染后的 HTML）。 */
function collectMermaid(src: string): string[] {
  const out: string[] = [];
  const re = /```[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

watch(
  [() => props.source, () => props.breaks],
  () => {
    // 流式期间节流：正以每秒几十帧的速度增长，逐帧重排没有意义
    if (props.streaming) {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(render, 120);
      return;
    }
    render();
  },
  { immediate: true },
);
// 流结束（streaming 由 true → false）时补一次，确保最后一帧不是被节流吞掉的旧内容
watch(() => props.streaming, (v) => { if (!v) render(); });

// ---- Mermaid：懒加载 + 异步渲染成 SVG ----
const charts = ref<Record<number, string>>({});
const chartErr = ref<Record<number, string>>({});
let mermaidLib: any = null;

async function paintCharts() {
  const blocks = mermaidBlocks.value;
  if (!blocks.length) {
    charts.value = {};
    chartErr.value = {};
    return;
  }
  try {
    if (!mermaidLib) {
      const mod: any = await import('mermaid');
      mermaidLib = mod.default || mod;
      mermaidLib.initialize({
        startOnLoad: false,
        securityLevel: 'strict', // 严格模式：图表里的 HTML 标签与点击跳转一律不生效
        theme: 'default',
      });
    }
    const next: Record<number, string> = {};
    const errs: Record<number, string> = {};
    for (let i = 0; i < blocks.length; i++) {
      const code = blocks[i];
      if (!code.trim()) continue;
      try {
        const id = `mmd-${++seq}-${i}`;
        const out = await mermaidLib.render(id, code);
        next[i] = typeof out === 'string' ? out : out?.svg || '';
      } catch (e) {
        // 语法错误（流式输出到一半的图经常不合法）不该弹成整页错误：记下来，等下一段
        errs[i] = (e as Error).message || '图表渲染失败';
      }
    }
    charts.value = next;
    chartErr.value = errs;
  } catch (e) {
    chartErr.value = { 0: `Mermaid 加载失败：${(e as Error).message}` };
  }
}

watch(mermaidBlocks, () => { void paintCharts(); }, { immediate: true });
onBeforeUnmount(() => { if (timer) window.clearTimeout(timer); });
</script>

<template>
  <div class="md">
    <!-- eslint-disable-next-line vue/no-v-html -- 内容来自 markdown-it（html:false 已转义），非原始 HTML -->
    <div class="md-body" v-html="html" />
    <div v-for="(code, i) in mermaidBlocks" :key="'m' + i" class="md-chart">
      <!-- eslint-disable-next-line vue/no-v-html -- mermaid 输出受 securityLevel=strict 约束 -->
      <div v-if="charts[i]" class="md-chart-svg" v-html="charts[i]" />
      <div v-else-if="chartErr[i]" class="md-chart-err">
        <pre class="md-chart-src">{{ code }}</pre>
        <p class="md-chart-note">图表暂无法渲染：{{ chartErr[i] }}</p>
      </div>
      <div v-else class="md-chart-loading">图表渲染中…</div>
    </div>
  </div>
</template>

<style scoped>
.md { font-size: 13.5px; line-height: 1.75; }
/* 正文里的首个/末个元素不该带外边距（外层气泡已留白） */
.md-body :deep(> :first-child) { margin-top: 0; }
.md-body :deep(> :last-child) { margin-bottom: 0; }
.md-body :deep(p) { margin: 10px 0; }
.md-body :deep(h1) { font-size: 18px; margin: 18px 0 8px; }
.md-body :deep(h2) { font-size: 16px; margin: 16px 0 8px; }
.md-body :deep(h3) { font-size: 14.5px; margin: 14px 0 6px; }
.md-body :deep(h4), .md-body :deep(h5) { font-size: 14px; margin: 12px 0 6px; }
.md-body :deep(ul), .md-body :deep(ol) { margin: 8px 0; padding-left: 22px; }
.md-body :deep(li) { margin: 4px 0; }
/* 松散列表（项间有空行）会被 markdown-it 包成 <p>，段落外边距再叠一层会让条目间距翻倍 */
.md-body :deep(li > p) { margin: 4px 0; }
.md-body :deep(blockquote) {
  margin: 10px 0; padding: 6px 12px; border-left: 3px solid var(--line);
  color: var(--t2);
}
.md-body :deep(a) { color: var(--violet); text-decoration: underline; }
.md-body :deep(hr) { border: none; border-top: 1px solid var(--line); margin: 14px 0; }
.md-body :deep(table) { border-collapse: collapse; margin: 10px 0; display: block; overflow-x: auto; }
.md-body :deep(th), .md-body :deep(td) { border: 1px solid var(--line); padding: 6px 10px; font-size: 12.5px; }
.md-body :deep(th) { background: var(--line-2); font-weight: 600; }
.md-body :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px; background: var(--line-2); padding: 1px 5px; border-radius: 4px;
}
.md-body :deep(pre.md-code) {
  margin: 10px 0; padding: 12px 14px; background: var(--line-2); border-radius: 8px;
  overflow-x: auto; position: relative;
}
.md-body :deep(pre.md-code code) {
  background: none; padding: 0; font-size: 12.5px; line-height: 1.7; display: block;
}
/* 语言标签：只有识别到语言时才显示（data-lang="" 不会出现） */
.md-body :deep(pre.md-code[data-lang]::before) {
  content: attr(data-lang);
  position: absolute; top: 6px; right: 10px;
  font-size: 10.5px; color: var(--t3); letter-spacing: .3px;
}
.md-chart { margin: 12px 0; }
.md-chart-svg { overflow-x: auto; }
.md-chart-loading { font-size: 12px; color: var(--t3); }
.md-chart-err { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: var(--line-2); }
.md-chart-src { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; white-space: pre-wrap; }
.md-chart-note { margin: 8px 0 0; font-size: 11.5px; color: var(--err); }
</style>
