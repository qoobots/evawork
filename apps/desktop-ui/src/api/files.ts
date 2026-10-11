/**
 * 我的文件 API（T-014）：只读扫描本地目录。
 * 后端负责越权校验与深度/数量限制，前端只做展示与筛选条件拼装。
 */
export interface FileItem {
  name: string;
  path: string;
  rel: string;
  ext: string;
  type: string;
  size: number;
  mtime: number;
}

export interface FileScan {
  root: string;
  items: FileItem[];
  total: number;
  truncated: boolean;
  skipped: number;
  types: string[];
}

/** T-035：文件预览结果（文本给正文，图片给 base64，其余只给元信息）。 */
export interface FilePreview {
  kind: 'text' | 'image' | 'binary';
  name: string;
  path: string;
  ext: string;
  type: string;
  size: number;
  mtime: number;
  truncated: boolean;
  content?: string;
  b64?: string;
  note?: string;
}

export interface SavedFile {
  ok: boolean;
  name: string;
  path: string;
  size: number;
  type: string;
}

/** 对话附件：主进程复制到工作区 `.evawork/attachments/` 后的条目。
 *  类型定义放这儿（而不是 attachments.ts），因为它是主进程 files 服务的返回形状，
 *  附件那一层只是复用它——反过来 import 会绕成环。 */
export interface Attachment {
  /** 落在附件目录里的文件名（可能与原名不同：同名会加 -2 序号） */
  name: string;
  /** 相对工作区的路径，发消息时按它引用 */
  rel: string;
  bytes: number;
  ext: string;
  /** 分类（图片/文档/表格…），用于 chip 上的类型标签 */
  type: string;
  /** 用户当初选中的原始路径，出错时要说清"是哪个文件没进来" */
  origin?: string;
}

/* 文件与附件：主进程直接读写磁盘（apps/desktop-node/src/files.js）。
   后端废弃后这些接口没有别的地方可去——它们是纯文件操作，
   而主进程本来就有工作区与完整的 fs；越界/体积校验也一起搬过去了。 */
interface FilesBridge {
  filesRoots?: () => Promise<FilesRootsResult>;
  filesScan?: (a: Record<string, unknown>) => Promise<FileScanResult>;
  filesTree?: (a: Record<string, unknown>) => Promise<TreeLevelResult>;
  filesContent?: (a: Record<string, unknown>) => Promise<FilePreviewResult>;
  filesWrite?: (a: Record<string, unknown>) => Promise<SavedFileResult>;
  filesSave?: (a: Record<string, unknown>) => Promise<SavedFileResult>;
  filesAttach?: (a: Record<string, unknown>) => Promise<AttachResult>;
  filesAttachRemove?: (a: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>;
  filesOpen?: (a: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string; path?: string }>;
}

type FilesRootsResult = { ok: boolean; reason?: string; workspace?: string; files?: string };
type FileScanResult = { ok: boolean; reason?: string } & Partial<FileScan>;
type TreeLevelResult = { ok: boolean; reason?: string } & Partial<TreeLevel>;
type FilePreviewResult = { ok: boolean; reason?: string } & Partial<FilePreview>;
type SavedFileResult = { ok: boolean; reason?: string } & Partial<SavedFile>;
type AttachResult = { ok: boolean; reason?: string; dir?: string; items?: Attachment[]; errors?: string[] };

function bridge<K extends keyof FilesBridge>(key: K): FilesBridge[K] {
  const b = (window as unknown as { evawork?: FilesBridge }).evawork;
  const fn = b && b[key];
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），文件功能不可用');
  return fn;
}

/** 统一拆包：主进程回 { ok, ...payload }，ok=false 时 reason 就是给用户看的成句原因。 */
async function call<T extends { ok: boolean; reason?: string }>(fn: () => Promise<T>): Promise<T> {
  const r = await fn();
  if (!r || r.ok === false) throw new Error((r && r.reason) || '操作失败');
  return r;
}

export async function fetchFiles(p: { root?: string; q?: string; type?: string; limit?: number } = {}): Promise<FileScan> {
  const r = await call(() => bridge('filesScan')!({ root: p.root || '', q: p.q || '', type: p.type || '', limit: p.limit || 500 }));
  return {
    root: r.root || '',
    items: r.items || [],
    total: r.total ?? (r.items || []).length,
    truncated: Boolean(r.truncated),
    skipped: r.skipped ?? 0,
    types: r.types || [],
  };
}

/** T-089：文件树的一层（懒加载，按目录展开才取）。 */
export interface TreeEntry {
  name: string;
  rel: string;
  kind: 'dir' | 'file';
  ext: string;
  size: number;
  mtime: number;
}

export interface TreeLevel {
  root: string;
  path: string;
  entries: TreeEntry[];
  total: number;
  truncated: boolean;
}

export async function fetchFileTree(path = '', root = '', limit = 500): Promise<TreeLevel> {
  const r = await call(() => bridge('filesTree')!({ rel: path, root, limit }));
  return {
    root: r.root || '',
    path: r.path || '',
    entries: r.entries || [],
    total: r.total ?? (r.entries || []).length,
    truncated: Boolean(r.truncated),
  };
}

/** T-089：可用的文件树根（我的文件 + 智能体工作区）。 */
export async function fetchFileRoots(): Promise<{ files: string; workspace: string }> {
  const r = await call(() => bridge('filesRoots')!());
  return { files: r.files || '', workspace: r.workspace || '' };
}

/** 读取文件内容用于预览（越界与体积约束在主进程）。root 省略时用「我的文件」。 */
export async function fetchFileContent(path: string, root = ''): Promise<FilePreview> {
  const r = await call(() => bridge('filesContent')!({ rel: path, root }));
  const { ok: _ok, reason: _reason, ...rest } = r;
  return rest as FilePreview;
}

/** 写回文本文件（保存编辑 / 另存）。 */
export async function writeFileContent(path: string, content: string): Promise<SavedFile> {
  const r = await call(() => bridge('filesWrite')!({ rel: path, content }));
  return { ok: true, name: r.name || '', path: r.path || '', size: r.size ?? 0, type: r.type || '' };
}

/** 把任务产物按文件名写到「我的文件」根目录（T-035：产物回写）。 */
export async function saveArtifactToFiles(name: string, content: string): Promise<SavedFile> {
  const r = await call(() => bridge('filesSave')!({ name, content }));
  return { ok: true, name: r.name || '', path: r.path || '', size: r.size ?? 0, type: r.type || '' };
}

/* 工作区根：主进程持有（userData/workspace.json），不再经后端。
   后端不拉起之后 `GET/PUT /api/workspace` 是死路，而工作区是智能体的落盘位置——
   拿不到就只能退回 cwd，用户选过的目录会被悄悄忘掉。 */
function workspaceBridge() {
  const b = (window as unknown as {
    evawork?: {
      workspaceGet?: () => Promise<{ path: string }>;
      workspaceSet?: (p: string) => Promise<{ path: string }>;
    };
  }).evawork;
  /* 把两个函数**单独取出来再判空**：只在对象上判空，TS 不会把 narrowing 传导到
     后续分别访问这两个属性时（返回出去的仍是可选类型），调用点会报"可能未定义"。 */
  const get = b?.workspaceGet;
  const set = b?.workspaceSet;
  if (!get || !set) {
    throw new Error('当前不是桌面运行环境（缺少主进程桥），工作区不可用');
  }
  return { workspaceGet: get, workspaceSet: set };
}

export async function fetchWorkspace(): Promise<{ root: string; locked: boolean }> {
  const r = await workspaceBridge().workspaceGet();
  // locked=false：不再有"被环境变量钉死"的状态，界面允许改
  return { root: r.path || '', locked: false };
}

/** 更换工作区根目录。主进程会校验后落盘，并在子进程运行中用新目录重拉它。 */
export async function setWorkspaceRoot(root: string): Promise<{ ok: boolean; root: string; note?: string }> {
  const r = await workspaceBridge().workspaceSet(root);
  return { ok: true, root: r.path || '' };
}

/** 用系统默认程序打开文件（主进程校验只放行工作区/我的文件根内的路径）。 */
export async function openFilePath(path: string): Promise<{ ok: boolean; path: string }> {
  const r = await call(() => bridge('filesOpen')!({ rel: path }));
  return { ok: true, path: r.path || path };
}
