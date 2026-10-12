// 网络出口管控（TS-023）。
//
// 环境变量与判定规则**和 Python 侧逐字对齐**（`security.py`）：
//   EVA_EGRESS_ALLOWLIST  逗号分隔的允许主机（如 `api.github.com,.github.com`）
//   EVA_EGRESS_ENFORCE    =1 才真拦；否则只声明、不拦
//   匹配                h == d 或 h 以 "." + d 结尾（小写比较）
//
// 为什么必须对齐：两套智能体共用同一份模型通道与同一份工作区，出口策略若各判各的，
// 用户配了一次白名单却只有一半生效——那比两边都没有管控更难解释。
//
// 诚实边界：它管的是**本进程**发出的请求（模型调用、web_fetch 等）。
// `run_command` 拉起的子进程不受它约束（Node 没有 socket 级拦截；permission model
// 也没有 --allow-net）。所以真正的组合拳是：
//   - 普通档：本进程受控 + 子进程不受控（靠审批与沙箱兜）
//   - hardened 档：命令工具禁用 → 除本进程外没有别的出口

const EGRESS_ENV = "EVA_EGRESS_ALLOWLIST"
const EGRESS_ENFORCE = "EVA_EGRESS_ENFORCE"

export function egressHosts(): string[] {
  const raw = (process.env[EGRESS_ENV] || "").trim()
  if (!raw) return []
  return [...new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))]
}

export function egressEnforced(): boolean {
  return (process.env[EGRESS_ENFORCE] || "").trim() === "1"
}

export function checkHost(host: string): { allowed: boolean; reason: string } {
  const hosts = egressHosts()
  if (!hosts.length || !egressEnforced()) {
    return { allowed: true, reason: "未声明出口策略（按允许全部外联处理）" }
  }
  const h = String(host || "").trim().toLowerCase()
  if (!h) return { allowed: false, reason: "出站被拦截：主机名为空" }
  // 兼容 `.github.com` 与 `github.com` 两种写法：原规则对带点的条目其实不生效
  // （`raw.github.com`.endsWith("..github.com") 恒为假），而示例注释正是按带点写的，
  // 用户照着配就会失效。两边（Python security.py / 本文件）一起改，保持一致。
  if (hosts.includes(h) || hosts.some((d) => h === d || h.endsWith("." + d.replace(/^\./, "")))) {
    return { allowed: true, reason: `命中出口白名单：${h}` }
  }
  return { allowed: false, reason: `出站被拦截：${h} 不在允许列表 ${JSON.stringify(hosts)}` }
}

/** 未显式传 signal 时的兜底超时（ms）。可用 EVA_EGRESS_TIMEOUT_MS 覆盖。 */
export function egressTimeoutMs(): number {
  const v = Number(process.env.EVA_EGRESS_TIMEOUT_MS || "")
  return Number.isFinite(v) && v > 0 ? v : 30_000
}

/**
 * 带出口检查的 fetch。URL 解析不出来按拒绝处理（fail-closed）。
 *
 * 超时：**调用方没传 signal 才由这里兜底**（`AbortSignal.timeout`）。
 * 不能反过来无条件覆盖——模型通道有自己的三段看门狗
 * （首字节 / 片间静默 / 总时长，见 `llm.ts`），被这里一刀切就没法区分"
 * 连不上"和"生成到一半断流"了，而这两种挂法该给的提示完全不同。
 */
export async function egressFetch(url: string, init?: RequestInit): Promise<Response> {
  let host = ""
  try {
    host = new URL(url).hostname
  } catch {
    throw new Error(`出站被拦截：URL 无法解析（${url.slice(0, 80)}）`)
  }
  const r = checkHost(host)
  if (!r.allowed) throw new Error(r.reason)
  const init2: RequestInit = init?.signal ? init : { ...init, signal: AbortSignal.timeout(egressTimeoutMs()) }
  return await fetch(url, init2)
}
