// 动作安全分类器（文档 19 P1-8）：**轻量 8 条、fail-closed、默认关**。
//
// 与 `guard.ts` 的分工：guard 管**循环卫生**（重复调用/卡死），这里管**动作安全**
// （这条命令要不要扣下来）。两回事，别混。
//
// 三条设计约束，都来自 18 号文档对 Claude Code 的解剖：
//   1. **默认放行 + 穷举阻断**：不是白名单制。编码 agent 干的事天然"看着危险"，
//      白名单制等于不让干活；只拦这 8 类明确的灾难动作。
//   2. **说不出规则名就不许拦**：block=yes 但给不出合法规则名 → 按放行处理。
//      拦得住错事的依据是"能指名道姓"，不是模型的语气大小。
//   3. **fail-closed**：分类通道不可达 / 输出解析不出 → **扣住调用**，
//      但 reason 里明说"这不是策略决定，允许重试"——"通道没答上来"与
//      "通道答了 ALLOW"是两种安全含义，不能压成同一种。
//
// **默认关**（settings.ts 的 classifier 开关 / EVA_TS_CLASSIFIER 环境变量）：
// 它是纵深防御的加层，不是既有审批链的替身——审批已移除的现实里，
// 白名单（explore 角色）仍是唯一防线，分类器开着才多一道。
// 先按真实误拦/漏拦数据灰度，规则扩到 67 条（18 号 §3.6）是第二步的事。

import type { LlmConfig } from "./types.ts"
import { completeOnce } from "./llm.ts"
import { clipText } from "./context.ts"
import { telemetry } from "./telemetry.ts"
import { classifierModel, classifierOn } from "./settings.ts"

/** 8 条阻断规则。`category` 是落进日志/事件的稳定英文标识，`rule` 是模型必须报出的规则名。 */
export const CLASSIFIER_RULES = [
  { category: "Irreversible Local Destruction", rule: "不可逆本地销毁", desc: "删除/覆盖没有本地可恢复途径的数据：递归强删非自建目录、格式化、写盘、清空回收站、批量删除且无备份" },
  { category: "Git Destructive", rule: "Git破坏性操作", desc: "改写远端或历史：push --force、reset --hard、clean -fd、删分支/tag、rebase 已推送的提交" },
  { category: "Data Exfiltration", rule: "数据外泄", desc: "把本地文件内容发往外部地址：上传、POST 表单、管道给远端脚本，尤其携带工作区内容或隐私数据" },
  { category: "Credential Leakage", rule: "凭据泄露", desc: "读取、打印、复制、上传令牌/密钥/密码类文件，或把它们拼进任何外发内容" },
  { category: "Production Deploy", rule: "生产环境部署", desc: "触发线上发布：部署脚本、kubectl apply、npm publish、迁移生产库、改线上配置" },
  { category: "Permission Grant", rule: "权限授予", desc: "扩大权限面：改系统目录属主/权限、加 sudo、开防火墙口子、给第三方授权" },
  { category: "Security Weaken", rule: "安全削弱", desc: "关掉既有安全机制：跳过校验钩子、禁用 TLS 验证、关杀毒/防火墙、改安全策略" },
  { category: "Self-Modification", rule: "自我修改", desc: "改动智能体自身的提示词、工具代码、权限/审批配置，或删除自身的审计记录" },
] as const

const RULE_NAMES = new Set(CLASSIFIER_RULES.map((r) => r.rule))

export interface ClassifierVerdict {
  /** true = 扣住这次调用（含 fail-closed 的"通道不可达"，见 unavailable）。 */
  block: boolean
  /** 阻断类别（fail-closed 时为空）。 */
  category?: string
  /** 给模型/日志看的一句话；必须与 block 同真同假。 */
  reason: string
  /** fail-closed：通道不可达或输出不可解析。**不是策略决定**，允许原样重试。 */
  unavailable?: boolean
}

const ALLOW: ClassifierVerdict = { block: false, reason: "" }

/** 分类器系统提示词：协议照搬 Claude Code 的输出形状，规则只列这 8 条。 */
const SYSTEM_PROMPT = [
  "你是一个编码智能体的**动作安全分类器**。智能体准备执行一条工具调用，你判断它是否必须被扣下。",
  "判定原则：",
  "1. **默认放行**。只拦下面穷举的 8 类灾难动作，其余一律放行——包括看起来危险但可恢复的操作、用户工作区里的常规读写、构建与测试。",
  "2. **说不出规则名就不许拦**：拦下必须指名道姓引用下面某一条；引不出就是放行。",
  "3. 只依据给出的命令与参数判断，不做有罪推定，不脑补「它接下来可能还要干坏事」。",
  "规则清单：",
  ...CLASSIFIER_RULES.map((r) => `- [${r.rule}]（${r.category}）：${r.desc}`),
  "输出协议（**只输出协议文本本身**，不要任何解释）：",
  "放行：<block>no</block>",
  "扣下：<block>yes</block><category>规则的英文类别名</category><reason>[规则名] 一句话依据</reason>",
].join("\n")

/** 送进分类器的动作描述上限（字符）：再长的命令截中段看骨架即可。 */
const INPUT_MAX_CHARS = 4_000
/** 分类调用超时（ms）：它是每步的前置闸，慢过这个值用户体感先崩。 */
const CLASSIFY_TIMEOUT_MS = 10_000

/**
 * 分类一次工具调用。返回"放行"是唯一允许快速返回的路径；
 * 任何拿不到可信结论的情形（没凭据、超时、解析失败）都折算成 fail-closed 的扣住。
 */
export async function classifyAction(
  toolName: string,
  args: Record<string, unknown>,
  cfg: LlmConfig | undefined,
  signal?: AbortSignal,
): Promise<ClassifierVerdict> {
  if (!classifierOn()) return ALLOW
  if (!cfg) {
    // 开了分类器却没有模型通道：fail-closed，别把"没配好"读成"允许"
    telemetry.count("classifier.unavailable")
    return { block: true, unavailable: true, reason: "动作安全分类器已启用，但当前没有可用的分类通道（fail-closed）。这不是策略决定，恢复通道后可原样重试。" }
  }

  // 命令类工具看命令正文；MCP 这类没有 command 参数的，看"工具名 + 参数骨架"
  const cmd = typeof args.command === "string" && args.command.trim() ? args.command : `${toolName} ${JSON.stringify(args)}`
  const r = await completeOnce(cfg, {
    model: classifierModel(cfg.model),
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `即将执行：\n${clipText(cmd, INPUT_MAX_CHARS)}` }],
    maxTokens: 240,
    // 输出协议以 </reason> 收尾；放行路径 <block>no</block> 本身极短
    stop: ["</reason>"],
    timeoutMs: CLASSIFY_TIMEOUT_MS,
    signal,
  })
  telemetry.count("classifier.check")

  if (r.finishReason !== "stop" && r.finishReason !== "length") {
    // 没答上来 = fail-closed；措辞必须说清这不是"策略拦你"，允许重试
    telemetry.count("classifier.unavailable")
    return {
      block: true,
      unavailable: true,
      reason: `动作安全分类器暂时不可达（${r.error || r.finishReason}），按 fail-closed 扣住。这不是策略决定，可以原样重试。`,
    }
  }

  const text = r.text
  const blockYes = /<block>\s*yes?\s*<\/block>/i.test(text)
  const blockNo = /<block>\s*no\b\s*<\/block>/i.test(text)
  if (!blockYes && !blockNo) {
    // 协议完整形状都没出来 = 不可解析 → fail-closed
    telemetry.count("classifier.unavailable")
    return {
      block: true,
      unavailable: true,
      reason: "动作安全分类器的输出无法解析（没给出 <block> 判定），按 fail-closed 扣住。这不是策略决定，可以原样重试。",
    }
  }
  if (blockYes && blockNo) {
    /* 同一份输出里两种判定标记都在 = 自相矛盾，多半是推理文本里混进了完整的
       <block>no</block>（或被刻意构造）。**绝不能让"谁排在检查前面"决定放行**——
       矛盾输出与不可解析同档：fail-closed 扣住，交给人看。 */
    telemetry.count("classifier.unavailable")
    return {
      block: true,
      unavailable: true,
      reason: "动作安全分类器的输出包含矛盾的判定标记（<block> 同时是 yes 和 no），按 fail-closed 扣住。这不是策略决定，可以原样重试。",
    }
  }
  if (blockNo) {
    telemetry.count("classifier.allow")
    return ALLOW
  }

  /* ---- block=yes：必须指名道姓，且规则名与类别都要对得上 ---- */
  const rule = /\[([^\]【\n]{1,32})\]/.exec(text)?.[1]?.trim() || ""
  const catRaw = /<category>\s*([^<]+?)\s*<\/category>/i.exec(text)?.[1]?.trim() || ""
  const hit = CLASSIFIER_RULES.find((x) => x.rule === rule)
  if (!hit || (catRaw && catRaw.toLowerCase() !== hit.category.toLowerCase())) {
    // 说不出规则名（或名字/类别对不上）= 不许拦：按放行处理，但记一笔供人查。
    // 误拦的代价（agent 干不了活）高于这条判断本身的可疑度。
    telemetry.count("classifier.block_no_rule")
    return ALLOW
  }
  const why = /<reason>([\s\S]*?)(?:<\/reason>|$)/i.exec(text)?.[1]?.replace(/\s+/g, " ").trim() || ""
  telemetry.count("classifier.block", 1, { reason: hit.category })
  return {
    block: true,
    category: hit.category,
    reason: `动作安全分类器拦下（规则 [${hit.rule}]）：${why || "（未给出依据）"}。换一种做法或向用户说明后由用户决定。`,
  }
}
