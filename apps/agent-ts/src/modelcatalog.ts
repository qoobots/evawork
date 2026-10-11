// 模型目录（模型广场同步）。
//
// 为什么在 agent-ts 里做：模型详情的**真相源是平台**（模型广场
// `/api/ai/models/square`），而 Python 后端即将废弃——目录不能再由它提供。
// 桌面端原有的模型清单来自后端 `/api/models`（内含硬编码的 model_catalog.py），
// 本模块把那份能力接过来，数据换成平台接口。
//
// **tier 仍来自本地**（`LOCAL_TIERS`）：heavy/balanced/fast/long/code 是
// "自动选择"的裁决依据，平台接口没有这个字段，它属于产品判断而不是平台事实。
// 平台负责**事实**（叫什么、擅长什么、窗口多大、哪些能力），本地负责**选型**。
//
// 降级链：接口 → 落盘缓存（TTL 6h）→ 本地档位表。
// 三级都拿不到才返回空 + 原因，由界面如实显示，不假装"有很多模型"。
//
// 还有一层更靠前的过滤：**计费通道**。eva-ai 由按量付费改成包月套餐之后，
// 平台把模型按 `channel` 分成 payg（按量）与 tokenplan（包月）两类；按量通道
// 没配地址与 Key，调它名下的模型一律 503「模型通道未配置」——**广场里照样列着，
// 但根本调不动**。所以清单最后还要跟通道自己的 `/models` 对一遍，见 applyChannel。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { homeDir } from "./session.ts"

export interface CatalogModel {
  id: string
  name: string
  /** 平台给的定位描述（事实来自平台，不是本地编的） */
  desc?: string
  /** 上下文窗口 token；平台没给就是 undefined，不按名字猜 */
  contextWindow?: number
  /** 能力标签，词表与界面 ABILITY_NAMES 对齐 */
  abilities: string[]
  /** 模型类型：llm / multimodal（其它类型不进对话清单） */
  modelType?: string
  provider?: string
  /** 选型档位（本地判断，平台不提供） */
  tier?: string
  /** 思考强度（本地按官方定位粗分） */
  thinking?: string
}

export interface CatalogResult {
  ok: boolean
  models: CatalogModel[]
  /** 平台清单里的总条数（**不等于** models.length：已按类型过滤） */
  total?: number
  /** 数据来自哪里：square=刚拉的，cache=落盘缓存，local=只剩本地兜底 */
  source: "square" | "cache" | "local"
  fetchedAt: number
  /** 失败/降级原因，供界面说明，不要静默 */
  reason?: string
}

/** 只有这两类能当对话模型。image/tts/stt/embedding/rerank 是别的工种，
 *  塞进"选模型"下拉等于让用户选了必然用不上的东西。 */
const CHAT_TYPES = new Set(["llm", "multimodal"])

/** 平台能力标签（中文）→ 界面词表（英文 key）。
 *  映射不上的原样透传：界面 `ABILITY_NAMES[a] || a` 会显示原文，
 *  平台新增能力时不必等这边发版才能看见。 */
const CAP_TO_ABILITY: Record<string, string> = {
  文本生成: "text",
  深度思考: "reasoning",
  函数调用: "tools",
  联网搜索: "web_search",
  长上下文: "long_ctx",
  视觉理解: "image_in",
  多模态对话: "multimodal",
  图像生成: "image_gen",
  视频生成: "video_gen",
  语音合成: "audio_out",
  语音识别: "audio_in",
  文本向量化: "embedding",
}

/** 选型档位与思考强度：**平台不提供，本地人工整理**。
 *  这不是缓存，是产品判断——"哪个模型算旗舰"要有人负责，改顺序即可换首选。
 *
 *  同时它也是**"当前套餐里用得上"的名单**（见 aliveFallbacks / applyChannel）：
 *  eva-ai 切到包月套餐后，按量档（qwen-plus / qwen-max / qwen-flash / qwen-long /
 *  qwen3-max / qwen3-coder-plus / kimi-k3 / deepseek-v4-pro-0813 / ZHIPU 前缀版 …）
 *  已从通道下架，留在表里等于让"自动选择"和用户下拉继续挑必然 503 的名字。
 *  平台往套餐里加新模型时，往这里补一行即可。按 tier 分组排，便于回退时按档取。 */
const LOCAL_TIERS: Record<string, { tier: string; thinking?: string; abilities?: string[]; desc?: string }> = {
  // heavy（旗舰）
  "qwen3.8-max": { tier: "heavy", thinking: "max", abilities: ["text", "reasoning", "tools"] },
  "qwen3.7-max": { tier: "heavy", thinking: "max", abilities: ["text", "reasoning", "tools"] },
  "deepseek-v4-pro": { tier: "heavy", thinking: "max", abilities: ["text", "reasoning"] },
  "glm-5.3": { tier: "heavy", thinking: "max", abilities: ["text", "reasoning"] },
  // balanced（均衡）
  "qwen3.7-plus": { tier: "balanced", thinking: "high", abilities: ["text", "reasoning", "tools"] },
  "glm-5.2": { tier: "balanced", thinking: "high", abilities: ["text"] },
  // fast（快速）
  "qwen3.8-flash": { tier: "fast", thinking: "low", abilities: ["text"] },
  "qwen3.6-flash": { tier: "fast", thinking: "low", abilities: ["text"] },
  "deepseek-v4.1-flash": { tier: "fast", thinking: "high", abilities: ["text", "reasoning"] },
  "deepseek-v4-flash-0731": { tier: "fast", thinking: "high", abilities: ["text", "reasoning"] },
}

/**
 * 当前套餐里**确认可用**的模型（按档位取，默认 3 个：均衡 → 快 → 旗舰）。
 *
 * 用途：用户选中的模型若已随套餐下线，发过去就是 503，整轮任务直接失败。
 * 这时顺着这里退回同套餐的其它档，而不是败在一个用户选不回来的名字上
 * （见 llm.ts 的 modelChain）。
 */
export function aliveFallbacks(limit = 3): string[] {
  const out: string[] = []
  for (const tier of ["balanced", "fast", "heavy"]) {
    const hit = Object.keys(LOCAL_TIERS).find((id) => LOCAL_TIERS[id].tier === tier)
    if (hit && !out.includes(hit)) out.push(hit)
    if (out.length >= limit) break
  }
  return out
}

const TTL_MS = 6 * 60 * 60 * 1000

function cacheFile(): string {
  return path.join(homeDir(), "model-catalog.json")
}

/** 模型广场地址：`EVA_AI_BASE_URL` 是推理通道（…/api/ai/v1），广场在它的上一级。 */
function squareUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "")
  return `${base}/models/square?page=1&size=1000`
}

/** 平台条目 → 对话模型。字段缺失一律留空，不拿同类字段顶替。 */
function mapItem(it: Record<string, unknown>): CatalogModel | null {
  const id = String(it.modelCode || "").trim()
  if (!id) return null
  const type = String(it.modelType || "").trim()
  if (type && !CHAT_TYPES.has(type)) return null
  const local = LOCAL_TIERS[id] || {}
  const abilities: string[] = []
  for (const c of (Array.isArray(it.capabilities) ? it.capabilities : []) as unknown[]) {
    const cn = String(c || "").trim()
    if (!cn) continue
    const key = CAP_TO_ABILITY[cn] || cn
    if (!abilities.includes(key)) abilities.push(key)
  }
  /* 平台没标的能力用本地补，而不是反过来覆盖：
     平台标"文本生成"不代表它不擅长写代码（那是定位，不是能力白名单）。 */
  for (const a of local.abilities || []) if (!abilities.includes(a)) abilities.push(a)
  const ctxRaw = it.contextWindow
  const ctx = typeof ctxRaw === "number" && Number.isFinite(ctxRaw) && ctxRaw > 0 ? ctxRaw : undefined
  const desc = String(it.description || "").trim() || local.desc || undefined
  return {
    id,
    name: String(it.modelName || "").trim() || id,
    desc,
    contextWindow: ctx,
    abilities,
    modelType: type || undefined,
    provider: String(it.providerCode || "").trim() || undefined,
    tier: local.tier,
    thinking: local.thinking,
  }
}

/** 只靠本地档位表能给出的清单（接口与缓存都没有时的最后一层）。 */
function localOnly(): CatalogModel[] {
  return Object.entries(LOCAL_TIERS).map(([id, v]) => ({
    id,
    name: id,
    desc: v.desc,
    abilities: v.abilities || ["text"],
    tier: v.tier,
    thinking: v.thinking,
  }))
}

function readCache(): { models: CatalogModel[]; fetchedAt: number } | null {
  try {
    const f = cacheFile()
    if (!existsSync(f)) return null
    const d = JSON.parse(readFileSync(f, "utf8")) as { models?: CatalogModel[]; fetchedAt?: number }
    if (!Array.isArray(d.models) || !d.models.length || !d.fetchedAt) return null
    return { models: d.models, fetchedAt: d.fetchedAt }
  } catch {
    return null // 缓存坏了当没有：不该因为一个坏文件就整个功能不可用
  }
}

function writeCache(models: CatalogModel[], fetchedAt: number): void {
  try {
    const f = cacheFile()
    mkdirSync(path.dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify({ models, fetchedAt }), "utf8")
  } catch {
    /* 缓存写不进去不影响本次结果，下次再拉就是 */
  }
}

/* ---- 计费通道 ---------------------------------------------------------------
   eva-ai 由按量付费改成**包月套餐**：平台 `/api/ai/v1/models` 给每条模型标了
   `channel`（`payg` 按量 / `tokenplan` 包月）。按量通道没配 base-url 与 api-key，
   调它名下的模型一律 `503 模型通道未配置：通道 payg 的 base-url / api-key 为空`
   ——而模型广场 `/models/square` 完全看不出这件事（344 条照常返回）。
   所以"能不能调"只能问通道自己的 `/models`，广场只负责"叫什么、多大窗口"。

   允许哪个通道由 `EVA_AI_CHANNEL` 决定（逗号分隔，默认 `tokenplan`）：
   平台以后再切回按量，改这个环境变量即可，不必改代码。 */
function allowedChannels(): string[] {
  const raw = String(process.env.EVA_AI_CHANNEL || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return raw.length ? raw : ["tokenplan"]
}

interface ChannelModels {
  ok: boolean
  /** 本套餐（allowedChannels）能调的模型 id */
  ids: string[]
  /** 通道上全部模型的 id——本套餐一条都没有时，靠它不至于把清单清空 */
  allIds: string[]
  reason?: string
}

/** 通道侧清单：唯一能说明"这个模型现在调得动"的地方。失败如实带原因，不猜。 */
async function fetchChannelModels(cfg: { baseUrl: string; token: string }): Promise<ChannelModels> {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/models"
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 401 || res.status === 403) return { ok: false, ids: [], allIds: [], reason: "登录态已失效" }
    if (!res.ok) return { ok: false, ids: [], allIds: [], reason: `通道模型清单请求失败（${res.status}）` }
    const body = (await res.json()) as { data?: { id?: string; channel?: string }[] }
    const allow = new Set(allowedChannels())
    const ids: string[] = []
    const allIds: string[] = []
    for (const it of Array.isArray(body?.data) ? body.data : []) {
      const id = String(it?.id || "").trim()
      if (!id || allIds.includes(id)) continue
      allIds.push(id)
      const ch = String(it?.channel || "").trim().toLowerCase()
      if (ch && !allow.has(ch)) continue // 别的套餐的模型：广场里有，但调不动
      ids.push(id)
    }
    if (!allIds.length) return { ok: false, ids: [], allIds: [], reason: "通道没有返回任何模型" }
    return { ok: true, ids, allIds }
  } catch (e) {
    return { ok: false, ids: [], allIds: [], reason: `无法连接通道模型清单：${(e as Error)?.message || e}` }
  }
}

/**
 * 把"广场/缓存/本地"那份清单跟通道对一遍，**只留下当前套餐调得动的模型**。
 *
 * 为什么必须过滤：不清掉的话，下拉里 kimi-k3 / qwen-max 这类按量档照样摆着，
 * 用户选了就必定 503——界面看起来有模型，实际一个都用不了。
 * 通道清单拿不到时退回本地档位表（那里记的就是套餐内的模型），而不是原样放行。
 */
async function applyChannel(cfg: { baseUrl: string; token: string }, r: CatalogResult): Promise<CatalogResult> {
  const ch = await fetchChannelModels(cfg)
  const notes: string[] = r.reason ? [r.reason] : []
  let models: CatalogModel[]
  if (ch.ok && ch.ids.length) {
    const alive = new Set(ch.ids)
    models = r.models.filter((m) => alive.has(m.id))
    if (!models.length) {
      /* 通道活着却一条都对不上：本地这份（缓存或广场）已经跟通道漂移了。
         退回档位表——宁可少给几个，也不给一堆必然报错的名字。 */
      models = localOnly()
      notes.push("模型广场与当前套餐没有交集，已用内置档位表")
    }
  } else if (ch.ok) {
    /* 本套餐一个都没有（比如平台又切回按量）：与其把清单清空，不如退回
       通道上**全部**模型——它们未必都调得动，但至少不是"没有模型"。
       说明写在 reason 里，不假装这份是本套餐的。 */
    const alive = new Set(ch.allIds)
    models = r.models.filter((m) => alive.has(m.id))
    if (!models.length) models = localOnly()
    notes.push("当前套餐在通道里没有可用模型，已列出通道全部模型")
  } else {
    models = r.models.filter((m) => LOCAL_TIERS[m.id])
    if (!models.length) models = localOnly()
    notes.push(`拿不到通道模型清单（${ch.reason}），只保留套餐内模型`)
  }
  const excluded = r.models.length - models.length
  if (excluded > 0) notes.push(`当前套餐为 ${allowedChannels().join("/")}，已隐藏 ${excluded} 个套餐外模型`)
  return { ...r, models, reason: notes.length ? notes.join("；") : undefined }
}

/**
 * 拉模型广场并映射成对话清单（再按当前套餐过滤）。
 *
 * `force` 绕过 TTL（界面手动刷新用）。任何一步失败都**如实返回**原因，
 * 再按 cache → local 降级，绝不用空清单假装"没有模型"。
 */
export async function fetchModelCatalog(
  cfg: { baseUrl: string; token: string },
  opts: { force?: boolean } = {},
): Promise<CatalogResult> {
  const cached = readCache()
  if (cached && !opts.force && Date.now() - cached.fetchedAt < TTL_MS) {
    return await applyChannel(cfg, { ok: true, models: cached.models, source: "cache", fetchedAt: cached.fetchedAt })
  }

  const url = squareUrl(cfg.baseUrl)
  let reason = ""
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 401 || res.status === 403) reason = "登录态已失效，请重新登录 EVA 账号";
    else if (res.status >= 400) reason = `模型广场请求失败（${res.status}）`;
    else {
      const body = (await res.json()) as { data?: { content?: unknown[]; totalElements?: number } }
      const raw = Array.isArray(body?.data?.content) ? (body.data!.content as unknown[]) : []
      const models: CatalogModel[] = []
      const seen = new Set<string>()
      for (const it of raw) {
        if (!it || typeof it !== "object") continue
        const m = mapItem(it as Record<string, unknown>)
        if (!m || seen.has(m.id)) continue
        seen.add(m.id)
        models.push(m)
      }
      if (!models.length) reason = "模型广场未返回可用的对话模型";
      else {
        const fetchedAt = Date.now()
        writeCache(models, fetchedAt)
        return await applyChannel(cfg, {
          ok: true,
          models,
          total: Number(body?.data?.totalElements) || models.length,
          source: "square",
          fetchedAt,
        })
      }
    }
  } catch (e) {
    reason = `无法连接模型广场：${(e as Error)?.message || e}`
  }

  if (cached) {
    return await applyChannel(cfg, {
      ok: true,
      models: cached.models,
      source: "cache",
      fetchedAt: cached.fetchedAt,
      reason: `${reason}（已用 ${new Date(cached.fetchedAt).toLocaleString("zh-CN")} 的缓存）`,
    })
  }
  /* 只剩本地档位表时不必再问通道：档位表本身就是套餐内的名单，问了也只会失败。 */
  return { ok: true, models: localOnly(), source: "local", fetchedAt: Date.now(), reason: `${reason}（已用内置档位表）` }
}

// ---------------------------------------------------------------- 精选

/** 对话模型厂商白名单。
 *
 *  为什么是白名单而不是"排除视频/3D 厂商"：平台的 `modelType` 不可信——
 *  实测 344 条 `llm`/`multimodal` 里混着 wan(31)、vidu(20)、pixverse(16) 这类
 *  **视频生成**模型（名字全是 i2v/t2v/lipsync），还有 `system` 名下的
 *  `test-sre-gpu-auto-handle` 这类内部测试模型。按类型过滤挡不住它们。
 *
 *  白名单是**产品判断**：我们只推荐这几家的对话模型。平台新添一家时，
 *  往这里加一行即可——比逐个把新视频厂商加进黑名单可靠（黑名单永远漏）。 */
const CHAT_PROVIDERS: Record<string, string> = {
  qwen: "阿里百炼",
  deepseek: "深度求索",
  /* 智谱在平台上有两个 providerCode：`zhipu-ai`（带 `ZHIPU/` 前缀那批）与
     `glm`（裸名那批）。包月套餐里剩下的是裸名那批（glm-5.2 / glm-5.3），
     少了 `glm` 这行它们会被白名单整个剔掉——下拉里就再也看不到智谱了。 */
  "zhipu-ai": "智谱",
  glm: "智谱",
  moonshot: "月之暗面",
  "mini-max": "MiniMax",
  stepfun: "阶跃星辰",
  xiaomi: "小米",
}

/** Moonshot 在平台上有两个 providerCode（moonshot-ai 与 kimi），同一家，合并统计。 */
function providerKey(code: string | undefined): string {
  const c = String(code || "").toLowerCase();
  if (c === "kimi" || c === "moonshot-ai") return "moonshot";
  return c;
}

export function providerLabel(key: string): string {
  return CHAT_PROVIDERS[key] || key;
}

/**
 * 从 modelCode 里解析版本号，用于"取最新的"。
 *
 * 平台给不了时间：`releaseDate` **全部为 null**，`version` 只有 0/1（无语义），
 * 所以唯一可比的线索就是名字里的数字。
 *
 * 三个坑：
 *  1. **日期后缀不是版本**：`qwen-turbo-0919` / `qwen-plus-0112` /
 *     `qwen-flash-2025-07-28` 里的数字是 MMDD / 年份。按版本号排会把
 *     三年前的快照顶到最前面（919 > 3.8），实测精选出来全是这些老快照。
 *     判据：第一个数字段长度 >= 3 就是日期——真实版本号没有三位段（v4.1 是 1 位）。
 *  2. **参数量不是版本**：`qwen-72b-chat` 的 72 是 72B 参数，72 > 3.8 会把
 *     一代老模型排到 qwen3.8 前面。判据：数字段紧跟 b/B 就是参数量。
 *  3. `qwen3.8-max` 是 3.8、`deepseek-v4.1-flash` 是 4.1，要按段比不是按字符串比
 *     （"10"会小于 "9"）。
 */
export function versionOf(code: string): number[] {
  const s = String(code || "")
  const m = s.match(/(\d+(?:\.\d+)*)/)
  if (!m || m.index === undefined) return []
  const after = s[m.index + m[1].length] || ""
  if (/[bB]/.test(after)) return [] // 72b / 7b / 95b —— 参数量，不是版本
  const firstSeg = m[1].split(".")[0]
  if (firstSeg.length >= 3 || Number(firstSeg) >= 1000) return [] // 日期，不是版本
  return m[1].split(".").map((n) => Number(n))
}

/** 版本号比较：逐段比，缺段当 0（5 == 5.0）。 */
function cmpVersion(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] || 0) - (b[i] || 0)
    if (d) return d
  }
  return 0
}

/** 同一个模型在平台上有多种写法（`kimi/kimi-k3` 与 `kimi-k3`）——只留裸名那条。 */
function dedupKey(code: string): string {
  return String(code || "").split("/").pop()!.toLowerCase()
}

/**
 * 精选出给用户可选的模型（默认 20 个），**每个厂商至少一个**。
 *
 * 为什么要筛：平台 llm/multimodal 有 344 条，绝大多数是视频/3D 模型、
 * 重复写法与日期快照。344 项的下拉没人翻得动，而且很多条目发过去根本调不动。
 *
 * 规则（按优先级）：
 *  1. 厂商白名单 + 厂商名归一（moonshot-ai 与 kimi 算一家）
 *  2. 同一模型去重（取裸名写法）
 *  3. 每厂商先保底 1 个（该厂商版本号最高的）——满足"各厂商至少一个"
 *  4. 剩下的名额按版本号从高到低补，同厂商内不重复
 */
export function pickFeatured(models: CatalogModel[], limit = 20): CatalogModel[] {
  const byProv = new Map<string, Map<string, CatalogModel>>()
  for (const m of models) {
    const pk = providerKey(m.provider)
    if (!CHAT_PROVIDERS[pk]) continue
    if (!byProv.has(pk)) byProv.set(pk, new Map())
    const bucket = byProv.get(pk)!
    const key = dedupKey(m.id)
    const exist = bucket.get(key)
    // 同名两条时优先留没有 provider 前缀的（更短、更像用户会用的那个）
    if (!exist || (m.id.length < exist.id.length)) bucket.set(key, m)
  }
  if (!byProv.size) return []

  // 每厂商按版本号降序（无版本号的排最后，但保留——qwen-flash 这类没有版本号的
  // 恰恰是常用档，砍掉它们等于砍掉用户真正会选的模型）
  const ranked = [...byProv.entries()]
    .map(([pk, bucket]) => ({
      pk,
      list: [...bucket.values()].sort((a, b) => {
        const d = cmpVersion(versionOf(a.id), versionOf(b.id))
        if (d) return -d
        return (b.contextWindow || 0) - (a.contextWindow || 0)
      }),
    }))
    .sort((a, b) => b.list.length - a.list.length)

  const picked: CatalogModel[] = []
  const taken = new Set<string>()

  // ① 每厂商保底 1 个（名额够的话按厂商模型数从多到少分配，保证"各厂商至少一个"）
  for (const g of ranked) {
    if (picked.length >= limit) break
    const first = g.list[0]
    if (!first) continue
    picked.push(first)
    taken.add(first.id)
  }
  // ② 剩下的名额：轮流从各厂商取次新的，避免某一家独占
  for (let round = 1; picked.length < limit; round += 1) {
    let progressed = false
    for (const g of ranked) {
      if (picked.length >= limit) break
      const next = g.list[round]
      if (!next || taken.has(next.id)) continue
      picked.push(next)
      taken.add(next.id)
      progressed = true
    }
    if (!progressed) break // 各厂商都取完了
  }
  return picked.slice(0, limit)
}

/**
 * 某一档的首选模型（自动选择的裁决依据）。没有该档返回 null——
 * 由调用方决定怎么办，不在这里硬塞一个模型名。
 */
export function byTier(models: CatalogModel[], tier: string): CatalogModel | null {
  const t = String(tier || "").trim().toLowerCase()
  if (!t) return null
  return models.find((m) => (m.tier || "").toLowerCase() === t) || null
}