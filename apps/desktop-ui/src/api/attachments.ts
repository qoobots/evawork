/**
 * 对话附件（+ 菜单「添加文件 / 截图」）。
 *
 * 分工，与「设置→工作区」那套一致：
 *   - **主进程**负责取料 *和* 落料：系统多选框返回路径、截屏返回临时 PNG 的路径，
 *     再把它们复制进工作区 `.evawork/attachments/`（越界/同名/体积都在那边判）。
 *   - 后端已废弃，不再参与。校验放在主进程，唯一事实源这一点不变。
 *
 * 为什么必须落到工作区内：智能体的文件工具被沙箱限死在工作区（sandbox.resolve 拒绝越界），
 * 附件放在外面 AI 读不到，chip 就成了摆设。做法对标 Cline / Claude Code 的会话附件目录。
 */
/* 类型本体在 files.ts（它是主进程 files 服务的返回形状，附件层只是复用），
   这里**再导出**一次：调用方一直从 '@/api/attachments' 拿 Attachment，
   不补这行等于逼着每个消费端改 import。 */
export type { Attachment } from './files';
import type { Attachment } from './files';

/** 系统多选文件框；用户取消返回空数组（不算错误，别弹提示）。 */
export async function pickFiles(): Promise<string[]> {
  const g = window as unknown as { evawork?: { pickFiles?: () => Promise<string[]> } };
  if (!g.evawork?.pickFiles) throw new Error('当前环境不支持选择文件（仅桌面安装版可用）');
  return g.evawork.pickFiles();
}

/** 唤起框选截图工具；返回临时 PNG 路径，随后由 attachPaths 收进工作区。用户取消返回空串。
    hideWindow=true：截图前先隐藏应用窗口，避免把它自己拍进图里。 */
export async function captureScreen(hideWindow = false): Promise<string> {
  const g = window as unknown as { evawork?: { captureScreen?: (hideWindow?: boolean) => Promise<string> } };
  if (!g.evawork?.captureScreen) throw new Error('当前环境不支持截图（仅桌面安装版可用）');
  return g.evawork.captureScreen(hideWindow);
}

/** 复制进附件目录。主进程返回 { ok, dir, items, errors }，errors 要如实显示给用户。 */
export async function attachPaths(
  paths: string[],
  _mode = 'auto',
): Promise<{ dir: string; items: Attachment[]; errors: string[] }> {
  const g = window as unknown as {
    evawork?: { filesAttach?: (a: { paths: string[]; root?: string }) => Promise<{ ok: boolean; reason?: string; dir?: string; items?: Attachment[]; errors?: string[] }> };
  };
  const fn = g.evawork?.filesAttach;
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），无法添加附件');
  const r = await fn({ paths, root: '' });
  if (!r.ok) throw new Error(r.reason || '添加附件失败');
  return { dir: r.dir || '', items: r.items || [], errors: r.errors || [] };
}

/** 删掉一个附件（用户点了 chip 上的 ×）；失败不阻塞界面，只是文件留在磁盘上。 */
export async function removeAttachment(rel: string): Promise<void> {
  const g = window as unknown as {
    evawork?: { filesAttachRemove?: (a: { rel: string; root?: string }) => Promise<{ ok: boolean; reason?: string }> };
  };
  const fn = g.evawork?.filesAttachRemove;
  if (!fn) return;
  await fn({ rel, root: '' }).catch(() => undefined);
}

/** 图片附件的 chip 缩略图（data URL）；读不到就返回空串，由界面退回文件图标。 */
export async function attachmentPreview(rel: string, root: string): Promise<string> {
  const g = window as unknown as {
    evawork?: { filesContent?: (a: { path: string; root?: string }) => Promise<{ ok: boolean; kind?: string; b64?: string }> };
  };
  const fn = g.evawork?.filesContent;
  if (!fn || !root) return '';
  const r = await fn({ path: rel, root }).catch(() => null);
  return r?.ok && r.kind === 'image' && r.b64 ? `data:image/*;base64,${r.b64}` : '';
}
