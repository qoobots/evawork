/**
 * 设置持久化 API（T-015）：通用 KV，存在**主进程**的 userData/settings.json。
 *
 * 以前存后端 kv 表；后端不拉起之后，改过的设置一重启就回默认值。
 * 本机偏好本来就该存本机——这也是它不跟账号走的原因（换台机器本来就该是默认设置）。
 */
export type SettingsData = Record<string, unknown>;

interface SettingsBridge {
  settingsGet?: () => Promise<{ ok: boolean; reason?: string; items?: SettingsData }>;
  settingsPut?: (patch: SettingsData) => Promise<{ ok: boolean; reason?: string; items?: SettingsData }>;
}

function bridge<K extends keyof SettingsBridge>(key: K): SettingsBridge[K] {
  const b = (window as unknown as { evawork?: SettingsBridge }).evawork;
  const fn = b && b[key];
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），设置无法保存');
  return fn;
}

export async function fetchSettings(): Promise<SettingsData> {
  const r = await bridge('settingsGet')!();
  if (!r.ok) throw new Error(r.reason || '读取设置失败');
  return r.items ?? {};
}

/** 合并写入：只传变更部分，主进程做 merge。 */
export async function putSettings(patch: SettingsData): Promise<SettingsData> {
  const r = await bridge('settingsPut')!(patch);
  if (!r.ok) throw new Error(r.reason || '保存设置失败');
  return r.items ?? {};
}
