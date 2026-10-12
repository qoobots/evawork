/**
 * S-20：语音输入（ASR）——录音转文字。
 *
 * 契约：
 * - `GET /api/asr/status`：服务端有没有开语音识别（`available` + 成句 `reason`）；
 * - `POST /api/asr`（multipart `file` + 可选 `lang`）：返回 `{ text }`。
 *
 * 音频走**自己的 IAM 凭据**转发到 eva-ai，桌面端不持有任何厂商密钥；
 * 转写结果**只回填输入框，不自动发送**——转写会错，必须让人先看一眼再按发送。
 */

export interface AsrStatus {
  available: boolean;
  reason: string;
}

/* 后端废弃后，转写这件事暂时没有承载方：它要把音频用自己的 IAM 凭据转发到
   eva-ai 的识别服务（桌面端不持有任何厂商密钥）。主进程现在**有** IAM 凭据，
   但识别端点与协议没有落到本地实现里——在接通之前如实报"不可用"，
   比让用户录完音才发现转不出来要好。 */
const ASR_REASON = '语音输入暂不可用：本地尚未接通识别服务';

export function fetchAsrStatus(_force = false): Promise<AsrStatus> {
  return Promise.resolve({ available: false, reason: ASR_REASON });
}

/** 上传一段录音（浏览器 MediaRecorder 产出），返回识别出的文字。 */
export async function transcribeAudio(_blob: Blob, _lang = ''): Promise<string> {
  throw new Error(ASR_REASON);
}
