/**
 * S-20：语音输入（录音 → 转写 → 回填输入框）。
 *
 * 三条刻意的纪律：
 * 1. **不自动发送**：识别结果交给 `onText` 回填输入框，让人先看一眼再按发送
 *    （转写会错，错了自动发出去就是替用户说了一句没说过的话）。
 * 2. **错误必须有成句原因**（没麦克风权限 / 服务端没开 / 转写为空），不许静默失败。
 * 3. **音频只在内存里**：MediaRecorder 的分片用完即弃，不落任何本地文件。
 */
import { onUnmounted, ref } from 'vue';
import { fetchAsrStatus, transcribeAudio } from '@/api/asr';

/** 单次录音上限：再长就该分段说；也避免一次性上传几十 MB。 */
const MAX_SEC = 60;

const MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of MIMES) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return '';
}

export function useVoiceInput(onText: (text: string) => void) {
  const recording = ref(false);
  const working = ref(false); // 转写中（上传 + 等待服务端）
  const error = ref('');
  const seconds = ref(0);
  /** 服务端有没有开语音识别；`null` = 还没问过 */
  const available = ref<boolean | null>(null);

  let rec: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let stream: MediaStream | null = null;
  let timer: number | undefined;
  let tick: number | undefined;

  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof MediaRecorder !== 'undefined';

  function releaseStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  function clearTimers() {
    if (timer) window.clearTimeout(timer);
    if (tick) window.clearInterval(tick);
    timer = undefined;
    tick = undefined;
  }

  async function probe(): Promise<boolean> {
    if (available.value !== null) return available.value;
    try {
      const st = await fetchAsrStatus();
      available.value = !!st.available;
      if (!st.available) error.value = st.reason || '语音识别不可用';
    } catch (e) {
      available.value = false;
      error.value = (e as Error).message || '语音识别状态获取失败';
    }
    return !!available.value;
  }

  async function start() {
    error.value = '';
    if (!supported) {
      error.value = '当前环境不支持录音（需要浏览器 MediaRecorder + 麦克风权限）';
      return;
    }
    if (!(await probe())) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const err = e as { name?: string };
      error.value =
        err?.name === 'NotAllowedError'
          ? '麦克风权限被拒绝：请在系统/应用设置里允许麦克风后重试'
          : `打开麦克风失败：${(e as Error).message || e}`;
      return;
    }
    const mime = pickMime();
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      releaseStream();
      error.value = `无法开始录音：${(e as Error).message || e}`;
      return;
    }
    chunks = [];
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) chunks.push(ev.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec?.mimeType || mime || 'audio/webm' });
      chunks = [];
      releaseStream();
      clearTimers();
      recording.value = false;
      void upload(blob);
    };
    rec.start();
    recording.value = true;
    seconds.value = 0;
    tick = window.setInterval(() => {
      seconds.value += 1;
    }, 1000);
    // 到点自动停：与其让用户举着麦忘了停，不如定个上限（停了照常转写，不丢内容）
    timer = window.setTimeout(() => void stop(), MAX_SEC * 1000);
  }

  async function upload(blob: Blob) {
    if (!blob.size) {
      error.value = '没有录到声音（录音为空）';
      return;
    }
    working.value = true;
    try {
      const text = await transcribeAudio(blob);
      if (text) onText(text);
    } catch (e) {
      error.value = (e as Error).message || '识别失败';
    } finally {
      working.value = false;
    }
  }

  function stop() {
    if (!rec || rec.state === 'inactive') return;
    clearTimers();
    rec.stop();
  }

  async function toggle() {
    if (recording.value) stop();
    else await start();
  }

  onUnmounted(() => {
    clearTimers();
    try {
      if (rec && rec.state !== 'inactive') rec.stop();
    } catch {
      /* 页面卸载时不该因为停止失败抛错 */
    }
    releaseStream();
  });

  return { recording, working, error, seconds, supported, available, start, stop, toggle, probe };
}
