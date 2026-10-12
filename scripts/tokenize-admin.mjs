#!/usr/bin/env node
// 管理控制台（深色）写死色值 → 令牌化（T-053 技术债修复）。
// 把 views/admin 下所有 .vue 中的写死色值（含 <style>/<script>/内联 style）替换为 var(--ac-*)。
// 令牌定义见 src/styles/app.css 的 .admin-console 块，值与原色一致，零视觉回归。
// 注意：#24d07a44（8 位）必须先于 #24d07a 处理，避免前缀破坏。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminDir = path.resolve(__dirname, '../apps/desktop-ui/src/views/admin');

// key = 原字面量（小写/原始），value = 令牌引用
const MAP = [
  ['#24d07a44', 'var(--ac-focus)'],
  ['#24d07a', 'var(--ac-green)'],
  ['#0c0d0e', 'var(--ac-app-bg)'],
  ['#e6e8e9', 'var(--ac-text)'],
  ['#1d1f21', 'var(--ac-nav-border)'],
  ['#a6abaf', 'var(--ac-text-muted-strong)'],
  ['#fff', 'var(--ac-white)'],
  ['#17181a', 'var(--ac-hover)'],
  ['#1d1f22', 'var(--ac-active)'],
  ['#062b16', 'var(--ac-green-fg)'],
  ['#9ec3f5', 'var(--ac-avatar-1)'],
  ['#6f8ef2', 'var(--ac-avatar-2)'],
  ['#8b9094', 'var(--ac-text-muted)'],
  ['#e0a94a', 'var(--ac-orange)'],
  ['#141517', 'var(--ac-panel)'],
  ['#212325', 'var(--ac-border)'],
  ['#2c2f32', 'var(--ac-surface)'],
  ['#1b1d1f', 'var(--ac-surface-2)'],
  ['#232527', 'var(--ac-surface-3)'],
  ['#2a1a1a', 'var(--ac-error-bg)'],
  ['#e0716e', 'var(--ac-error)'],
  ['#3a5bf0', 'var(--ac-blue)'],
  ['#e8e9ea', 'var(--ac-btn-light)'],
  ['#111', 'var(--ac-btn-light-fg)'],
  ['#6d7175', 'var(--ac-text-muted-2)'],
  ['#1f3a2b', 'var(--ac-green-disabled-bg)'],
  ['#5c7a68', 'var(--ac-green-disabled-fg)'],
  ['#1e2022', 'var(--ac-border-2)'],
  ['#ff7b72', 'var(--ac-danger-hover)'],
  ['#6f7478', 'var(--ac-text-muted-3)'],
  ['#24262a', 'var(--ac-icon-border)'],
  ['#7fd8a5', 'var(--ac-green-soft)'],
  ['#2f3235', 'var(--ac-toggle-off)'],
  ['#24292e', 'var(--ac-brand-github)'],
  ['#1f1f21', 'var(--ac-brand-notion)'],
  ['#a259ff', 'var(--ac-brand-figma)'],
  ['#5e6ad2', 'var(--ac-brand-linear)'],
  ['#4a154b', 'var(--ac-brand-slack)'],
  ['#cc2936', 'var(--ac-brand-zotero)'],
  ['#5c6064', 'var(--ac-text-faint)'],
  ['#1e2124', 'var(--ac-heat-0)'],
  ['#1f5c3d', 'var(--ac-heat-1)'],
  ['#2a9a5c', 'var(--ac-heat-2)'],
  ['#c5c9cc', 'var(--ac-text-soft)'],
  ['#3b3f44', 'var(--ac-bar-fill)'],
  ['#1b2b20', 'var(--ac-green-bg-soft)'],
  ['#101112', 'var(--ac-surface-4)'],
  ['#383c40', 'var(--ac-hover-2)'],
  ['#3a2020', 'var(--ac-danger-bg)'],
  ['#3ee08f', 'var(--ac-green-bright-2)'],
  ['rgba(255, 255, 255, 0.08)', 'var(--ac-icon-ring)'],
];

function tokenize(content) {
  let total = 0;
  for (const [from, to] of MAP) {
    if (!content.includes(from)) continue;
    const count = content.split(from).length - 1;
    if (count > 0) {
      content = content.split(from).join(to);
      total += count;
    }
  }
  return { content, total };
}

const files = fs.readdirSync(adminDir).filter((f) => f.endsWith('.vue'));
let grand = 0;
for (const f of files) {
  const fp = path.join(adminDir, f);
  const raw = fs.readFileSync(fp, 'utf8');
  const { content, total } = tokenize(raw);
  if (total > 0) {
    fs.writeFileSync(fp, content, 'utf8');
    console.log(`  ${f}: ${total} 处替换`);
    grand += total;
  } else {
    console.log(`  ${f}: 无写死色值`);
  }
}
console.log(`合计替换 ${grand} 处`);
