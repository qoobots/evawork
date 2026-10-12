// 契约加载：审批档位 + 动作风险分类。
//
// 为什么单独一份文件而不是在代码里写死：分类改一次，运行时的审批行为就跟着变，
// 而它是**会被打包带走**的（desktop-node 的 extraResources 把它拷成
// `agent-ts/contract/agent-contract.json`）。所以这里是"读文件"，不是"定义"。
//
// 缺文件的后果不是报错，而是**静默退化**到下面的 FALLBACK——能跑，但风险表是缺的
// （sandbox 档表整个没有），审批按错的表判，且从外面看不出来。sdk.ts 因此把
// 契约来源（哪份文件 / 还是兜底）摆进了 capabilities。

import fs from "node:fs"
import path from "node:path"

export type Risky = "allow" | "ask" | "deny"

export interface ContractAction {
  risky: boolean
  alias?: string[]
  note?: string
}

export interface ContractPolicy {
  on_risky: Risky
  allow?: string[]
  fail_closed?: boolean
  note?: string
}

export interface Contract {
  version: number
  actions: Record<string, ContractAction>
  policies: Record<string, ContractPolicy>
}

/** 找不到契约时的兜底（与契约文件同值；宁可跑起来也不能崩）。
 *  注意它**少于**真实契约：真实文件里还有 plan 档，兜底没有。 */
const FALLBACK: Contract = {
  version: 0,
  actions: {
    read: { risky: false },
    llm: { risky: false },
    memory_write: { risky: false },
    write: { risky: true },
    command: { risky: true },
    network: { risky: true },
    install: { risky: true },
    computer_control: { risky: true },
  },
  policies: {
    never: { on_risky: "deny", fail_closed: true },
    ask: { on_risky: "ask", fail_closed: true },
    full: { on_risky: "allow", fail_closed: false },
  },
}

/**
 * 契约文件路径（按优先级）：
 * 1. `EVA_AGENT_CONTRACT` 显式指定（打包/部署用）
 * 2. 包内 `contract/agent-contract.json`（随分发拷贝）
 * 3. 开发期回退到仓库里的 `shared/agent-contract.json`
 */
function candidates(): string[] {
  const here = import.meta.dirname
  const out: string[] = []
  const env = (process.env.EVA_AGENT_CONTRACT || "").trim()
  if (env) out.push(env)
  out.push(path.join(here, "..", "contract", "agent-contract.json"))
  // 向上找仓库里的 `shared/agent-contract.json`，**不写死层级**：
  // 目录挪一次就少一层，写死就会指到仓库外面去，然后**静默退化**成内置兜底
  // （能跑，但 plan 档这类定义整个丢掉，审批语义少一截，且从外面看不出来）
  let dir = path.resolve(here, "..")
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, "shared", "agent-contract.json")
    if (fs.existsSync(p)) {
      out.push(p)
      break
    }
    dir = path.resolve(dir, "..")
  }
  return out
}

let cached: { contract: Contract; source: string } | null = null

export function loadContract(): { contract: Contract; source: string } {
  if (cached) return cached
  for (const p of candidates()) {
    try {
      const raw = fs.readFileSync(p, "utf8")
      const contract = JSON.parse(raw) as Contract
      if (!contract.actions || !contract.policies) continue
      cached = { contract, source: p }
      return cached
    } catch {
      /* 换下一个候选 */
    }
  }
  cached = { contract: FALLBACK, source: "(内置兜底)" }
  return cached
}

/** 动作名归一：工具名（run_command / terminal）经 alias 归一到抽象类别（command）。 */
export function normalizeAction(action: string): string {
  const a = String(action || "").trim()
  const { contract } = loadContract()
  if (contract.actions[a]) return a
  for (const [name, def] of Object.entries(contract.actions)) {
    if (def.alias && def.alias.includes(a)) return name
  }
  return a
}

export function isRisky(action: string): boolean {
  const { contract } = loadContract()
  return Boolean(contract.actions[normalizeAction(action)]?.risky)
}
