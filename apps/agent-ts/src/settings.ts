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
  /**
   * 动作安全分类器开关（文档 19 P1-8）：**默认关**。
   * 它是审批移除后补的纵深防御加层，不是既有审批链的替身——开着要先看过
   * 真实误拦/漏拦数据，所以由启动方或界面显式打开，不默认全量。
   */
  classifier?: "on" | "off"
  /**
   * 分类器专用模型（小模型、判断标准稳定）。分类器换模型 = 换判断标准，
   * 所以它**不**跟着每轮的对话模型漂移；没配则退到主模型（见 classifierModel）。
   */
  classifierModel?: string
}

/* ---- 分类器的读取口径（classifier.ts 专用；判定逻辑不放这儿，避免环依赖） ----
   优先级：**环境变量 > 持久设置 > 默认关**。与其余 EVA_TS_* 同一语义：
   启动方能不改盘上状态就灰度开一开；界面上的开关写进 settings 后跨会话生效。 */

export function classifierOn(): boolean {
  const env = (process.env.EVA_TS_CLASSIFIER || "").trim().toLowerCase()
  if (["1", "on", "true", "yes"].includes(env)) return true
  if (["0", "off", "false", "no"].includes(env)) return false
  return loadSettings().classifier === "on"
}

/** 分类器用的模型名；`fallback` 传本轮主模型（没单独配分类器模型时就用它）。 */
export function classifierModel(fallback: string): string {
  const env = (process.env.EVA_TS_CLASSIFIER_MODEL || "").trim()
  return (env || loadSettings().classifierModel || fallback).trim()
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
