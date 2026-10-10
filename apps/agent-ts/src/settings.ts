// 设置与凭据（TS-026）。
//
// 设置：会变的当前状态，落在非会话存储（storage.ts）。
// 凭据：**只从环境变量读，不落盘**。
//
// 凭据不落盘不是偷懒，是边界：登录态在 Python 侧，由启动方注入给 TS 子进程
// （见 tsAgent.js）。两套智能体的存储必须分开——共享一份凭据存储，等于把两套又绑回一起，
// 那"独立"就只剩名义上的了。

import { get, set } from "./storage.ts"

const KEY = "settings"

export interface Settings {
  model?: string
  workspace?: string
  maxSteps?: number
}

export function loadSettings(): Settings {
  return get<Settings>(KEY, {}) ?? {}
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch }
  set(KEY, next)
  return next
}

export interface Credentials {
  baseUrl: string
  token: string
  /** 两个都在才算"有凭据"——缺一半就报没有，别让调用方去猜 */
  present: boolean
}

export function credentials(): Credentials {
  const baseUrl = (process.env.EVA_AI_BASE_URL || "").trim()
  const token = (process.env.EVA_AI_TOKEN || "").trim()
  return { baseUrl, token, present: Boolean(baseUrl && token) }
}
