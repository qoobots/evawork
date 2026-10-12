/**
 * 产物回写到「我的文件」（T-035）。
 *
 * 任务面板里"产物"以前只是几个文件名，点不出任何后果；这里把它接到
 * `/api/files/save`，点一下就真的在本地目录里生成一个文件。
 * T-105：产物只来自真实落盘的文件，所以文件类产物要先按路径读盘再回写——
 * 直接用事件里的 content 会把"那一步的模型答复"写成文件，存出来答非所问。
 * 无正文（例如空产物）时如实说明，不做"点了没反应"的假动作。
 */
import { ref } from 'vue';
import { bridgeAvailable } from '@/api/backend';
import { fetchFileContent, fetchWorkspace, saveArtifactToFiles } from '@/api/files';
import type { Artifact } from '@/api/tasks';

export function useArtifactSave() {
  const savingId = ref('');
  const artMsg = ref('');

  async function saveArtifact(a: Artifact) {
    if (!bridgeAvailable()) {
      artMsg.value = '未连接后端，无法保存到我的文件';
      return;
    }
    let body = a.content || '';
    if (a.kind === 'file' && a.path) {
      try {
        const ws = await fetchWorkspace();
        const pv = await fetchFileContent(a.path, ws.root);
        body = pv.content || '';
      } catch (e) {
        artMsg.value = '读取文件失败：' + (e as Error).message;
        return;
      }
    }
    if (!body) {
      artMsg.value = '「' + a.name + '」没有可保存的正文';
      return;
    }
    savingId.value = a.id;
    artMsg.value = '';
    try {
      const res = await saveArtifactToFiles(a.name, body);
      artMsg.value = `已保存到我的文件：${res.name}`;
    } catch (e) {
      artMsg.value = `保存失败：${(e as Error).message}`;
    } finally {
      savingId.value = '';
    }
  }

  return { savingId, artMsg, saveArtifact };
}
