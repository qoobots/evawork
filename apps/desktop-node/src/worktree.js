/**
 * S-22：工作树（**真的** `git worktree`）。
 *
 * 后端废弃后这页会退回"三个控件全是摆设"的状态（阈值写死、占用表写死暂无数据）。
 * 放主进程的理由很直接：git 就在本机，主进程本来就有工作区路径和进程执行能力，
 * 为一个只会调 `git` 的功能去维持一个常驻服务不划算。
 *
 * 两条硬约束：
 *  1. **只在工作区内动 git**：仓库根由 `git rev-parse --show-toplevel` 从工作区求得，
 *     建出来的工作树固定落在 `<repo>/.evawork/worktrees/` —— 不去碰仓库外的地方。
 *  2. **主工作树永远不删**：删它会把用户整个仓库连带抹掉，这一步错了无法挽回。
 *     按 `main` 标记拦，并且路径等于仓库根也拦一次（双保险）。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_THRESHOLD = 5 * 1024 * 1024 * 1024; // 5GB
const MAX_FILES = 20000; // 量体积时的文件数上限；超了就标 truncated

let cfgFile = '';
let getWorkspace = () => '';

function init({ dir, getWorkspace: gw }) {
  cfgFile = path.join(dir, 'worktree.json');
  getWorkspace = gw || (() => '');
}

function readCfg() {
  try {
    const v = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeCfg(patch) {
  const next = { ...readCfg(), ...(patch || {}) };
  try {
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify(next));
  } catch {
    /* 存不下就用默认值，功能不受影响 */
  }
  return next;
}

function run(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: String((stderr || '').trim() || (err.message || '')) });
      else resolve({ ok: true, out: String(stdout || '') });
    });
  });
}

/** 量目录体积。文件数到上限就停（标 truncated，界面知道这不是精确值）。 */
function measure(dir) {
  let bytes = 0;
  let count = 0;
  let truncated = false;
  let mtime = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      const full = path.join(d, e.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // 不跟随符号链接：可能绕出工作区
      count += 1;
      if (count > MAX_FILES) {
        truncated = true;
        return;
      }
      if (st.isDirectory()) {
        walk(full);
      } else {
        bytes += st.size;
        if (st.mtimeMs > mtime) mtime = st.mtimeMs;
      }
    }
  };
  walk(dir);
  return { bytes, truncated, mtime: Math.floor(mtime / 1000) };
}

/** `git worktree list --porcelain` → 条目列表。 */
function parseList(out, repo) {
  const items = [];
  let cur = null;
  for (const line of String(out || '').split(/\r?\n/)) {
    if (!line.trim()) {
      if (cur) items.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length).trim(), head: '', branch: '', detached: false, main: false };
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim();
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    } else if (cur && line === 'detached') {
      cur.detached = true;
    } else if (cur && (line === 'bare' || line === 'locked' || line.startsWith('prunable'))) {
      /* 忽略：locked/prunable 不影响列举 */
    }
  }
  if (cur) items.push(cur);
  const repoNorm = path.resolve(String(repo || '')).toLowerCase();
  return items.map((it) => ({ ...it, main: path.resolve(it.path).toLowerCase() === repoNorm }));
}

async function state() {
  const ws = String(getWorkspace() || '').trim();
  const cfg = readCfg();
  const thresholdBytes = Number(cfg.thresholdBytes) || DEFAULT_THRESHOLD;
  const keepBranch = Boolean(cfg.keepBranch);
  const base = { supported: false, reason: '', repo: '', items: [], totalBytes: 0, thresholdBytes, keepBranch };

  if (!ws) return { ...base, reason: '还没有设置工作区' };
  const repoRes = await run(['rev-parse', '--show-toplevel'], ws);
  if (!repoRes.ok) {
    return { ...base, reason: /not a git repository/i.test(repoRes.error) ? '当前工作区不是 git 仓库' : `git 不可用：${repoRes.error}` };
  }
  const repo = path.resolve(repoRes.out.trim());
  const listRes = await run(['worktree', 'list', '--porcelain'], repo);
  if (!listRes.ok) return { ...base, repo, reason: `读不了工作树列表：${listRes.error}` };

  const raw = parseList(listRes.out, repo);
  const items = raw.map((it) => {
    const m = measure(it.path);
    return {
      path: it.path,
      name: path.basename(it.path),
      branch: it.branch,
      head: it.head,
      detached: it.detached,
      main: it.main,
      sizeBytes: m.bytes,
      truncated: m.truncated,
      mtime: m.mtime,
    };
  });
  // 占用只算非主工作树（主工作树就是用户仓库本身，算进去没意义）
  const totalBytes = items.filter((i) => !i.main).reduce((a, b) => a + b.sizeBytes, 0);
  return { supported: true, reason: '', repo, items, totalBytes, thresholdBytes, keepBranch };
}

/** 建树前的体积闸门：占用已超阈值就拒绝，别把磁盘悄悄塞满。 */
async function create(branch, base = '') {
  const st = await state();
  if (!st.supported) throw new Error(st.reason || '工作树不可用');
  const b = String(branch || '').trim();
  if (!b) throw new Error('分支名必填');
  if (st.totalBytes >= st.thresholdBytes) {
    throw new Error(`工作树占用已达上限（${(st.totalBytes / 1024 / 1024 / 1024).toFixed(1)}GB / ${(st.thresholdBytes / 1024 / 1024 / 1024).toFixed(1)}GB），请先清理`);
  }
  const target = path.join(st.repo, '.evawork', 'worktrees', b.replace(/[\\/:*?"<>|]/g, '-'));
  if (fs.existsSync(target)) throw new Error(`这个分支的工作树已经存在：${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const args = ['worktree', 'add', target];
  if (String(base || '').trim()) args.push(String(base).trim());
  else args.push('-b', b);
  const r = await run(args, st.repo);
  if (!r.ok) throw new Error(r.error || '建工作树失败');
  const fresh = await state();
  const hit = fresh.items.find((i) => path.resolve(i.path) === path.resolve(target));
  return { ok: true, item: hit || { path: target, name: b, branch: b } };
}

async function remove(target, force = false) {
  const st = await state();
  if (!st.supported) throw new Error(st.reason || '工作树不可用');
  const want = path.resolve(String(target || ''));
  const hit = st.items.find((i) => path.resolve(i.path) === want);
  if (!hit) throw new Error('找不到这棵工作树');
  if (hit.main) throw new Error('主工作树不能删（那就是你的仓库本身）');
  if (path.resolve(want) === path.resolve(st.repo)) throw new Error('拒绝删除仓库目录');

  const args = ['worktree', 'remove', want];
  if (force) args.push('--force');
  const r = await run(args, st.repo);
  if (!r.ok) throw new Error(r.error || '删不掉（有未提交改动就用 force）');
  // 分支删不删按设置：未合并的分支 git 会自己拒绝，这里不强行 -D
  let branchDropped = false;
  if (!st.keepBranch && hit.branch) {
    const d = await run(['branch', '-d', hit.branch], st.repo);
    branchDropped = d.ok;
  }
  return { ok: true, branchDropped };
}

/** 批量清理：按 mtime 从旧到新删，保留最近 keep 棵。只清 `.evawork/worktrees` 下本应用建的。 */
async function prune(keep = 2) {
  const st = await state();
  if (!st.supported) throw new Error(st.reason || '工作树不可用');
  const root = path.join(st.repo, '.evawork', 'worktrees');
  const mine = st.items
    .filter((i) => !i.main && path.resolve(i.path).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep))
    .sort((a, b) => a.mtime - b.mtime);
  const removeCount = Math.max(mine.length - Math.max(Number(keep) || 0, 0), 0);
  const removed = [];
  const failed = [];
  for (const it of mine.slice(0, removeCount)) {
    const r = await remove(it.path, true).catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
    if (r.ok) removed.push(it.path);
    else failed.push({ path: it.path, reason: r.reason || '删不掉' });
  }
  return { ok: true, removed, failed, kept: mine.length - removed.length };
}

function saveCfg(patch) {
  const next = writeCfg(patch || {});
  return { ok: true, thresholdBytes: Number(next.thresholdBytes) || DEFAULT_THRESHOLD, keepBranch: Boolean(next.keepBranch) };
}

module.exports = { init, state, create, remove, prune, saveCfg };
