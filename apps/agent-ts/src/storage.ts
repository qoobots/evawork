// 非会话存储（TS-025）：设置、凭据引用、杂项 KV。
//
// 和事件日志（session.ts）是**两回事**，别混：
//   - 事件日志：只追加的事实（会话里发生了什么），可重放；
//   - 这里：会变的当前状态（设置、上次用的模型…），最后写入生效。
//
// 为什么先用 JSON 而不是 SQLite：零依赖优先，且这点数据量（几十个键）用不上数据库。
// 真到需要并发写或数据量上来，再换成 SQLite WAL（DSH 的 storage-sqlite 默认就是 WAL），
// 接口保持不变即可。
//
// 与 Python 侧：**不共用**。`~/.evawork/ts-agent/storage.json`，不碰 evawork.db。

import fs from "node:fs"
import path from "node:path"
import { homeDir } from "./session.ts"

const FILE = "storage.json"
const SCHEMA_VERSION = 1

interface Store {
  schema: number
  data: Record<string, unknown>
  updated_at: number
}

let cache: Store | null = null

function file(): string {
  const dir = homeDir()
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, FILE)
}

function load(): Store {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(file(), "utf8")
    const s = JSON.parse(raw) as Store
    // 版本不匹配**直接拒绝**而不是自动迁移（照 DSH 的 storage-sqlite 做法）：
    // 悄悄改数据结构比拒绝更危险——读出来的值对不上，问题会推迟到很远处才爆。
    if (s.schema !== SCHEMA_VERSION) {
      throw new Error(`storage schema ${s.schema} ≠ ${SCHEMA_VERSION}，拒绝读取（需显式迁移）`)
    }
    cache = { schema: SCHEMA_VERSION, data: s.data || {}, updated_at: s.updated_at || 0 }
  } catch (err) {
    if ((err as Error).message?.includes("schema")) throw err
    cache = { schema: SCHEMA_VERSION, data: {}, updated_at: 0 }
  }
  return cache
}

function persist(s: Store): void {
  s.updated_at = Date.now()
  // 先写临时文件再 rename：写到一半崩了不会留下半截 JSON 把整份存储毁掉
  const f = file()
  const tmp = `${f}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8")
  try {
    fs.renameSync(tmp, f)
  } catch (e) {
    // rename 失败（如被占用）就退化为直接写，至少别丢这次更新
    fs.writeFileSync(f, JSON.stringify(s, null, 2), "utf8")
    try { fs.rmSync(tmp, { force: true }) } catch { /* 删不掉不影响结果 */ }
  }
  cache = s
}

export function get<T = unknown>(key: string, fallback?: T): T | undefined {
  const s = load()
  const v = s.data[key]
  return v === undefined ? fallback : (v as T)
}

export function set(key: string, value: unknown): void {
  const s = load()
  s.data[key] = value
  persist(s)
}

export function remove(key: string): void {
  const s = load()
  delete s.data[key]
  persist(s)
}

export function keys(): string[] {
  return Object.keys(load().data)
}

/** 测试/隔离用：丢掉内存缓存，下次重新读盘。 */
export function resetCache(): void {
  cache = null
}

export const storageMeta = { SCHEMA_VERSION, FILE }
