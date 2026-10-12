/**
 * 我的文件 / 附件：主进程直接读写本地磁盘。
 *
 * 后端废弃后这些接口没有别的地方可去——它们是**纯文件操作**，
 * 而主进程本来就有工作区（userData/workspace.json）和完整的 fs。
 * 以前绕后端一圈，只是为了让"越界/体积"这些校验有个唯一的执行点；
 * 现在校验搬到这里（见 `resolveInside`），唯一性照样成立。
 *
 * 安全红线：渲染层传来的路径一律当作**不可信输入**。
 * 先 resolve 成绝对路径，再校验它落在允许的根内，绝不信原始字符串。
 * 少了这一步，`rel = "../../../Users/x/.ssh/id_rsa"` 就能读遍整台机器。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** 扫描时整棵跳过的目录：依赖/构建产物/版本库，扫它们既慢又没意义。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'out',
]);

const MAX_SCAN = 5000; // 扫描条目上限（超了就 truncated，界面知道还有）
const MAX_TEXT = 200 * 1024; // 文本预览上限（再大就截断）
const MAX_IMAGE = 8 * 1024 * 1024; // 图片预览上限（base64 会膨胀 1/3）

let getWorkspace = () => '';

function init(opts = {}) {
  getWorkspace = opts.getWorkspace || (() => '');
}

/** 「我的文件」根：与工作区默认同目录，用户没换工作区时两者一致。 */
function filesRoot() {
  const dir = path.join(app_home(), 'EvaWork');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来就只当作路径返回，读写时会如实失败 */
  }
  return dir;
}

function app_home() {
  return os.homedir();
}

/** 允许作为根的两个目录：工作区 + 我的文件。 */
function roots() {
  return { workspace: getWorkspace() || '', files: filesRoot() };
}

/**
 * 把 rel 解析成绝对路径，**并确认它仍在 root 内**。
 * 不在就抛错——这是本文件唯一的安全边界，所有读写都必须过它。
 */
function resolveInside(root, rel) {
  const base = path.resolve(String(root || ''));
  if (!base) throw new Error('缺少根目录');
  const target = path.resolve(base, String(rel || ''));
  const rel2 = path.relative(base, target);
  if (rel2 === '..' || rel2.startsWith(`..${path.sep}`) || path.isAbsolute(rel2)) {
    throw new Error('路径越界：只能在允许的根目录内访问');
  }
  return target;
}

/** 挑一个允许的根；root 为空就用「我的文件」。 */
function pickRoot(root) {
  const r = String(root || '').trim();
  if (r) {
    const { workspace, files } = roots();
    const resolved = path.resolve(r);
    // 显式给的 root 也必须是两个允许根之一，不能是任意目录
    if (workspace && path.resolve(workspace) === resolved) return resolved;
    if (path.resolve(files) === resolved) return resolved;
    throw new Error('不允许的目录：只能访问工作区或「我的文件」');
  }
  return filesRoot();
}

const EXT_TYPE = [
  [['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'], 'image'],
  [['md', 'txt', 'log', 'json', 'yaml', 'yml', 'toml', 'ini', 'csv'], 'doc'],
  [['pdf'], 'pdf'],
  [['doc', 'docx'], 'doc'],
  [['xls', 'xlsx'], 'sheet'],
  [['ppt', 'pptx'], 'slide'],
  [['zip', 'rar', '7z', 'tar', 'gz'], 'archive'],
  [['mp3', 'wav', 'mp4', 'mov', 'avi', 'mkv'], 'media'],
  [['js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'sh', 'css', 'html'], 'code'],
];

function typeOf(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  for (const [list, t] of EXT_TYPE) if (list.includes(e)) return t;
  return 'other';
}

function statItem(file, root) {
  const st = fs.statSync(file);
  const ext = path.extname(file);
  const rel = path.relative(root, file).split(path.sep).join('/');
  return {
    name: path.basename(file),
    path: file,
    rel,
    ext: ext.replace(/^\./, ''),
    type: typeOf(ext),
    size: st.isDirectory() ? 0 : st.size,
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

/** 递归扫描（深度优先，跳过 SKIP_DIRS，条目到上限就停）。 */
function scan({ root, q, type, limit } = {}) {
  const base = pickRoot(root);
  const max = Math.min(Math.max(Number(limit) || 500, 1), MAX_SCAN);
  const kw = String(q || '').trim().toLowerCase();
  const wantType = String(type || '').trim();
  const items = [];
  let truncated = false;
  let skipped = 0;

  const walk = (dir) => {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (items.length >= max) {
        truncated = true;
        return;
      }
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        skipped += 1;
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) {
          skipped += 1;
          continue;
        }
        walk(full);
        continue;
      }
      if (name.startsWith('.')) {
        skipped += 1;
        continue;
      }
      const it = statItem(full, base);
      if (kw && !`${it.name} ${it.rel}`.toLowerCase().includes(kw)) continue;
      if (wantType && wantType !== '全部' && it.type !== wantType) continue;
      items.push(it);
    }
  };
  walk(base);

  const types = [...new Set(items.map((i) => i.type))].sort();
  items.sort((a, b) => b.mtime - a.mtime);
  return { root: base, items, total: items.length, truncated, skipped, types };
}

/** 文件树的一层（懒加载展开）。目录在前、文件在后，各自按名字排。 */
function tree({ root, rel, limit } = {}) {
  const base = pickRoot(root);
  const dir = resolveInside(base, String(rel || ''));
  const max = Math.min(Math.max(Number(limit) || 500, 1), MAX_SCAN);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    throw new Error(`读不了这个目录：${(e && e.message) || e}`);
  }
  const entries = [];
  let truncated = false;
  for (const name of names) {
    if (entries.length >= max) {
      truncated = true;
      break;
    }
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    entries.push({
      name,
      rel: path.relative(base, full).split(path.sep).join('/'),
      kind: st.isDirectory() ? 'dir' : 'file',
      ext: path.extname(name).replace(/^\./, ''),
      size: st.isDirectory() ? 0 : st.size,
      mtime: Math.floor(st.mtimeMs / 1000),
    });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { root: base, path: path.relative(base, dir).split(path.sep).join('/'), entries, total: entries.length, truncated };
}

/** 读文件内容用于预览：文本给正文，图片给 base64，其余只给元信息。 */
function content({ root, rel } = {}) {
  const base = pickRoot(root);
  const file = resolveInside(base, String(rel || ''));
  const st = fs.statSync(file);
  if (st.isDirectory()) throw new Error('这是一个目录，不能直接预览');
  const ext = path.extname(file).replace(/^\./, '').toLowerCase();
  const meta = {
    name: path.basename(file),
    path: file,
    ext,
    type: typeOf(ext),
    size: st.size,
    mtime: Math.floor(st.mtimeMs / 1000),
  };
  if (typeOf(ext) === 'image') {
    if (st.size > MAX_IMAGE) return { kind: 'binary', ...meta, truncated: true, note: `图片超过 ${Math.floor(MAX_IMAGE / 1024 / 1024)}MB，不预览` };
    const b64 = fs.readFileSync(file).toString('base64');
    return { kind: 'image', ...meta, truncated: false, b64 };
  }
  const head = Buffer.alloc(Math.min(st.size, 4096));
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  // 有 NUL 字节基本就是二进制，硬读出来只会是一堆乱码
  if (head.includes(0)) return { kind: 'binary', ...meta, truncated: false, note: '二进制文件，不显示正文' };
  const buf = Buffer.alloc(Math.min(st.size, MAX_TEXT));
  const fd2 = fs.openSync(file, 'r');
  try {
    fs.readSync(fd2, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd2);
  }
  return { kind: 'text', ...meta, truncated: st.size > MAX_TEXT, content: buf.toString('utf8') };
}

/** 写文本到工作区/我的文件（父目录自动建）。 */
function write({ root, rel, content } = {}) {
  const base = pickRoot(root);
  const file = resolveInside(base, String(rel || ''));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = String(content ?? '');
  fs.writeFileSync(file, body, 'utf8');
  return { ok: true, name: path.basename(file), path: file, size: Buffer.byteLength(body), type: typeOf(path.extname(file)) };
}

/** 把产物存进「我的文件」（界面上的"存为文件"）。 */
function saveArtifact({ name, content } = {}) {
  const base = filesRoot();
  const safe = String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled.txt';
  const file = resolveInside(base, safe);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = String(content ?? '');
  fs.writeFileSync(file, body, 'utf8');
  return { ok: true, name: path.basename(file), path: file, size: Buffer.byteLength(body), type: typeOf(path.extname(file)) };
}

/** 附件目录：工作区下的 .evawork/attachments（智能体沙箱限死在工作区内，放外面它读不到）。 */
function attachmentDir(root) {
  const base = root ? pickRoot(root) : getWorkspace() || filesRoot();
  const dir = path.join(base, '.evawork', 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  return { base, dir };
}

/**
 * 把选中的文件复制进附件目录。
 * 同名自动加序号（`-2`、`-3`…），不覆盖——覆盖会悄悄替换掉用户上一版传的图。
 */
function attach({ paths, root } = {}) {
  const { base, dir } = attachmentDir(root);
  const items = [];
  const errors = [];
  const list = Array.isArray(paths) ? paths : [];
  for (const p of list) {
    const src = String(p || '').trim();
    if (!src) continue;
    try {
      const st = fs.statSync(src);
      if (!st.isFile()) {
        errors.push(`${src}：不是文件`);
        continue;
      }
      const origin = path.basename(src);
      const ext = path.extname(origin);
      const stem = path.basename(origin, ext);
      let name = origin;
      let n = 2;
      while (fs.existsSync(path.join(dir, name))) {
        name = `${stem}-${n}${ext}`;
        n += 1;
      }
      const dest = path.join(dir, name);
      fs.copyFileSync(src, dest);
      items.push({
        name,
        rel: path.relative(base, dest).split(path.sep).join('/'),
        bytes: st.size,
        ext: ext.replace(/^\./, ''),
        type: typeOf(ext),
        origin: src,
      });
    } catch (e) {
      errors.push(`${src}：${(e && e.message) || e}`);
    }
  }
  return { dir: path.relative(base, dir).split(path.sep).join('/'), items, errors };
}

/** 删一个附件（chip 上的 ×）。 */
function attachRemove({ root, rel } = {}) {
  const base = root ? pickRoot(root) : getWorkspace() || filesRoot();
  const file = resolveInside(base, String(rel || ''));
  try {
    fs.unlinkSync(file);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || e };
  }
}

/** 解析出一个**允许根内**的绝对路径，供主进程用系统默认程序打开。
 *  本模块不自己开——打开要 shell，那是 electron 的事，这里只负责定边界。 */
function resolveForOpen({ root, rel } = {}) {
  return resolveInside(pickRoot(root), String(rel || ''));
}

module.exports = {
  init, roots, scan, tree, content, write, saveArtifact, attach, attachRemove, filesRoot, resolveForOpen,
};