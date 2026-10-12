/**
 * 本地集合存储：给控制台配置、设计系统、模板、自动化这些**本机数据**用。
 *
 * 为什么抽成一个通用存储而不是每个模块各写一份：它们本质完全一样——
 * 「一个命名的集合，元素是带 id 的 JSON」。后端废弃后这些都要落到本机，
 * 每个都写一遍文件读写 + 目录创建 + 坏 JSON 兜底，只会把同一份 bug 复制五遍。
 *
 * 刻意的取舍：
 *  1. **一个集合一个文件**（`store/<name>.json`），整读整写。数据规模是
 *     桌面单用户的配置量级，没必要上增量/索引——加了只是提前付复杂度。
 *  2. **坏 JSON 当空集合**，不让一个坏文件带崩整个界面；旧文件不备份，
 *     因为写入是先解析后整体覆盖，写坏的概率远低于"外部改坏了"。
 *  3. 集合名只允许 `[A-Za-z0-9_-]`，它会被拼进路径。
 */
const fs = require('fs');
const path = require('path');

let dir = '';

function init(baseDir) {
  dir = path.join(baseDir, 'store');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来时读写会如实失败 */
  }
}

function safeName(name) {
  const n = String(name || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(n)) throw new Error(`集合名不合法：${n}`);
  return n;
}

function fileOf(name) {
  return path.join(dir, `${safeName(name)}.json`);
}

function readAll(name) {
  try {
    const v = JSON.parse(fs.readFileSync(fileOf(name), 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeAll(name, items) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fileOf(name), JSON.stringify(items));
}

/** 列出整个集合。 */
function list(name) {
  return { ok: true, items: readAll(name) };
}

/** 取一条；没有返回 null（由调用方决定是报错还是当新建）。 */
function get(name, id) {
  const item = readAll(name).find((x) => x && x.id === id) || null;
  return { ok: true, item };
}

/** 写入一条：有 id 就整体替换，没有就新建（并补 id）。 */
function put(name, item) {
  const body = item && typeof item === 'object' ? item : {};
  const items = readAll(name);
  let id = String(body.id || '').trim();
  if (!id) {
    id = `${safeName(name)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    body.id = id;
  }
  const i = items.findIndex((x) => x && x.id === id);
  if (i >= 0) items[i] = { ...items[i], ...body, id };
  else items.push({ ...body, id });
  writeAll(name, items);
  return { ok: true, item: items[i >= 0 ? i : items.length - 1] };
}

/** 删一条；不存在如实说没删成（静默成功会让人以为删了其实还在）。 */
function remove(name, id) {
  const items = readAll(name);
  const next = items.filter((x) => !x || x.id !== id);
  if (next.length === items.length) return { ok: false, reason: '条目不存在' };
  writeAll(name, next);
  return { ok: true };
}

/** 整份替换（控制台那类"一个 key 一份配置"的用法）。 */
function replaceAll(name, items) {
  const arr = Array.isArray(items) ? items : [];
  writeAll(name, arr);
  return { ok: true, items: arr };
}

module.exports = { init, list, get, put, remove, replaceAll };