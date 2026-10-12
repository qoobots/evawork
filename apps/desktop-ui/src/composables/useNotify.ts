/**
 * S-12：任务结束时的**真通知与真提示音**。
 *
 * 以前「横幅 / 声音 / 音量」三个控件只是把数字写进 KV，没有任何代码听它们——
 * 任务跑完了用户完全不知道。这里把它补齐：
 *   - 提示音：Web Audio 合成（不依赖任何音频文件，离线可用，音量直接走设置里的百分比）
 *   - 横幅：浏览器/ Electron 的 Notification（需要授权；没授权就直说，不假装成功）
 *
 * 诚实边界：**只做"通知 + 提示音"这一件事**。三条音效各用不同音型区分
 * （完成=上行、等待=单音、异常=下行），但不支持"上传自定义音效"——
 * 那个按钮因此在界面上标了 data-coming，不做假入口。
 */

export type ChimeKind = 'done' | 'waiting' | 'error';

/** 音型：[频率 Hz, 起始秒, 时长秒] */
const PATTERNS: Record<ChimeKind, Array<[number, number, number]>> = {
  done: [
    [660, 0, 0.12],
    [880, 0.12, 0.16],
  ],
  waiting: [[740, 0, 0.14]],
  error: [
    [440, 0, 0.14],
    [330, 0.14, 0.2],
  ],
};

let ctx: AudioContext | null = null;

/** 播一声提示音。`volume` 取 0~1（界面上是 0~100 的滑条）。 */
export function playChime(kind: ChimeKind = 'done', volume = 0.5): void {
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = ctx || new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    // 分三段做包络（起音-保持-收尾）：直接给 gain 定值会有"啪"的爆音
    for (const [freq, at, dur] of PATTERNS[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const peak = Math.max(0, Math.min(1, volume)) * 0.25; // 0.25：满音量也不刺耳
      gain.gain.setValueAtTime(0, now + at);
      gain.gain.linearRampToValueAtTime(peak, now + at + 0.015);
      gain.gain.setValueAtTime(peak, now + at + dur * 0.7);
      gain.gain.linearRampToValueAtTime(0, now + at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + dur + 0.02);
    }
  } catch {
    /* 音频不可用（无音频设备 / 被策略禁用）就静默跳过：提示音不是主干功能 */
  }
}

/** 通知要不要先要授权：Electron 里默认允许，纯浏览器预览里会被拒。 */
export function notifyPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestNotifyPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * 发一条任务结束通知。
 * 返回值是**真结果**：'shown' / 'unsupported' / 'denied' / 'failed'，
 * 调用方据此给用户一句实话，不出现"点了没反应"。
 */
export function notifyTask(title: string, body: string): 'shown' | 'unsupported' | 'denied' | 'failed' {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'granted') return 'denied';
  try {
    new Notification(title, { body, silent: true }); // silent：声音由提示音自己管，避免系统再叠一记
    return 'shown';
  } catch {
    return 'failed';
  }
}
