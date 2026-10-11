// 打包前的准备：把 agent-ts 的依赖**实体化**（只拷它真正可达的那部分）。
//
// 这条链路踩了五层坑，全是"看起来对、跑起来就炸"，所以从头写清楚：
//
// 1. **pnpm 的 node_modules 全是符号链接**，electron-builder 拷 extraResources 时把符号链接
//    变成**空目录**——目录在、package.json 不在，产物里 `import("docx")` 直接
//    ERR_MODULE_NOT_FOUND。
// 2. **只拷顶层不够**：传递依赖在 `.pnpm/<pkg>@<ver>/node_modules/` 里。
// 3. **纯扁平也不够**：exceljs 报 `Cannot find module 'readable-stream/passthrough'`
//    ——它要 v2 的那个路径，顶层是 v4。版本分歧必须靠**嵌套**表达。
// 4. **递归展开能对上版本，但产出 839MB**——重复拷贝炸了。
// 5. **扫整个 .pnpm 更糟**：那是**工作区共享**的，会把 electron(259MB)、
//    app-builder-bin(207MB)、mermaid(119MB) 这些**别的子项目的依赖**一起拷进来，
//    实测 856MB。
//
// 最终方案（三件事一起做）：
//   a. 从 agent-ts 的直接依赖出发，沿 pnpm 解析出的依赖关系**递归收集可达包**
//      ——只拷这个子集，不碰工作区里其他项目的包（这是第 5 层的解法）
//   b. 扁平放进顶层
//   c. 版本与顶层不一致的，**定向嵌套**进那个包的 node_modules（这是第 3 层的解法）

import fs from "node:fs"
import path from "node:path"

const args = process.argv.slice(2).filter((a) => a !== "--fresh")
const src = path.resolve(args[0] || "")
const dest = path.resolve(args[1] || "")
if (!src || !dest) {
  console.error("用法：node scripts/materialize_deps.mjs <srcNodeModules> <destDir> [--fresh]")
  process.exit(2)
}
if (!fs.existsSync(src)) {
  console.log(`[deps] 源目录不存在，跳过：${src}`)
  process.exit(0)
}

function findPnpmDir(from) {
  let dir = from
  for (let i = 0; i < 5; i++) {
    for (const cand of [path.join(dir, "node_modules", ".pnpm"), path.join(dir, ".pnpm")]) {
      if (fs.existsSync(cand)) return cand
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

const pnpmDir = findPnpmDir(src)
if (!pnpmDir) {
  console.log(`[deps] 警告：从 ${src} 往上没找到 .pnpm——只实体化顶层依赖（产物里可能缺传递依赖）`)
}

let files = 0
let dirs = 0

/** 嵌一份时跳过的目录/文件：对运行没用，却是体积大头。 */
const SKIP_DIRS = new Set(["docs", "doc", "test", "tests", "__tests__", "example", "examples", "benchmark", "bench", ".github", "coverage", ".vscode", ".idea"])
const SKIP_EXT = [".map", ".md", ".markdown", ".flow", ".orig"]

/**
 * 拷贝一个包的内容（跟随符号链接），跳过 node_modules（依赖单独处理）。
 *
 * `lean`：只在**嵌一份副本**时用——只拷运行要用的文件。顶层拷贝不用 lean，
 * 保持完整，避免漏东西（宁可大一点，也不能少）。
 */
function copyPkg(from, to, lean = false) {
  fs.mkdirSync(to, { recursive: true })
  dirs += 1
  for (const name of fs.readdirSync(from)) {
    if (name === "node_modules") continue
    // 嵌一份只需要"能跑"的部分：文档、测试、示例、source map 对运行毫无用处，
    // 而它们恰恰是包体积的大头（实测嵌 280 份时它们占了 277MB 的大部分）。
    if (lean && SKIP_DIRS.has(name)) continue
    const s = path.join(from, name)
    const d = path.join(to, name)
    let st
    try {
      st = fs.statSync(s)
    } catch {
      continue
    }
    if (st.isDirectory()) copyPkg(s, d, lean)
    else if (st.isFile()) {
      if (lean && SKIP_EXT.some((x) => name.endsWith(x))) continue
      try {
        if (fs.statSync(d).size === st.size) continue
      } catch {
        /* 目标没有 → 拷 */
      }
      fs.copyFileSync(s, d)
      files += 1
    }
  }
}

function pkgVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version || ""
  } catch {
    return ""
  }
}

function pkgFilesSize(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() || e.isSymbolicLink())
      .reduce((sum, e) => {
        try {
          return sum + fs.statSync(path.join(dir, e.name)).size
        } catch {
          return sum
        }
      }, 0)
  } catch {
    return 0
  }
}

/**
 * pnpm 布局里某个包的**依赖同级目录**（即它旁边的 node_modules）。
 *
 *   .pnpm/pkg@1.0.0/node_modules/pkg/        ← 包
 *   .pnpm/pkg@1.0.0/node_modules/zod/        ← 依赖（同级！）
 *
 * 关键坑：**作用域包**的真实路径是 `…/node_modules/@scope/pkg`，它的父目录是
 * `@scope` 而不是 `node_modules`。只看一层父目录就会退回"包内的 node_modules"
 * （通常不存在）→ 这个包的依赖**一个都收不到**。实测后果：
 * `@playwright/mcp` 的 playwright/playwright-core、`@notionhq/notion-mcp-server`
 * 的 axios、`@upstash/context7-mcp` 的 undici 全被漏掉，产物里 MCP 服务起不来。
 * 所以要沿祖先往上找到那层以 node_modules 结尾的目录（最多两级：@scope/pkg）。
 */
function siblingNodeModules(resolved) {
  let dir = path.dirname(resolved)
  for (let i = 0; i < 3; i++) {
    if (path.basename(dir) === "node_modules") return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return path.join(resolved, "node_modules")
}

/* ---------- a. 递归收集"可达包" ---------- */
// 从 agent-ts 的直接依赖出发，沿 pnpm 在每个包旁边摆好的依赖集（符号链接）走。
// 用 visited 按真实路径去重：既避免死循环，也天然让重复的包只收录一次。
const reachable = new Map() // realDir -> pkgName
const directNames = new Set() // **直接**依赖的包名：只有它们才值得做版本嵌套
const queue = []

for (const name of fs.readdirSync(src)) {
  if (name === ".bin") continue
  const p = path.join(src, name)
  if (name.startsWith("@")) {
    for (const sub of fs.readdirSync(p)) queue.push({ real: path.join(p, sub), name: `${name}/${sub}` })
  } else {
    queue.push({ real: p, name })
  }
}
// 入口队列里的就是直接依赖
for (const item of queue) directNames.add(item.name)

while (queue.length) {
  const { real, name } = queue.shift()
  let st
  try {
    st = fs.statSync(real)
  } catch {
    continue
  }
  if (!st.isDirectory()) continue
  if (reachable.has(real)) continue
  reachable.set(real, name)
  /* pnpm 布局里，**依赖不在包自己里面，而在它的同级**：
   *   .pnpm/docx@9.8.1/node_modules/docx/     ← 包
   *   .pnpm/docx@9.8.1/node_modules/jszip/    ← 它的依赖（同级！）
   * 所以要找"祖先里路径以 node_modules 结尾的那一层"，而不是包内的 node_modules。
   * （找错的话只收录到 62 个直接依赖，传递依赖全丢——这正是实测撞出来的。） */
  // 入口是符号链接（apps/agent-ts/node_modules/docx -> ../../.pnpm/docx@9.x/node_modules/docx），
  // 不解析的话 dirname 还是顶层目录，永远走不进传递依赖（实测只收录到 62 个直接依赖）。
  let resolved = real
  try {
    resolved = fs.realpathSync(real)
  } catch {
    /* 解析不了就按原样 */
  }
  const nm = siblingNodeModules(resolved)
  if (!fs.existsSync(nm)) continue
  for (const dep of fs.readdirSync(nm)) {
    if (dep === ".bin") continue
    const depPath = path.join(nm, dep)
    if (!fs.statSync(depPath, { throwIfNoEntry: false })) continue
    if (path.resolve(depPath) === path.resolve(resolved)) continue
    if (dep.startsWith("@")) {
      let subs
      try {
        subs = fs.readdirSync(depPath)
      } catch {
        continue
      }
      for (const sub of subs) queue.push({ real: path.join(depPath, sub), name: `${dep}/${sub}` })
    } else {
      queue.push({ real: depPath, name: dep })
    }
  }
}

if (process.argv.includes("--fresh") && fs.existsSync(dest)) {
  fs.rmSync(dest, { recursive: true, force: true })
  console.log("[deps] 已清空目标目录")
}
fs.mkdirSync(dest, { recursive: true })

/* ---------- b. 扁平放进顶层 ---------- */
for (const [real, name] of reachable) copyPkg(real, path.join(dest, name))

/* ---------- c. 定向嵌套：版本与顶层不一致的，给那个包一份自己的 ---------- */
// 体积闸门：不设闸门时定向嵌套能到 877MB（大包被整份重复拷）。
// 真正会炸的是**小包的具体子路径**（readable-stream/passthrough 这类），几乎都在 2MB 内；
// 大版本分歧（typescript / @types/*）基本向后兼容，用顶层版本即可。
const NEST_MAX_BYTES = 2 * 1024 * 1024
let nested = 0
const nestedSkipped = []

for (const [real, name] of reachable) {
  // 只给**直接依赖**做嵌套：实测传递依赖的分歧不影响运行（docx/pptx/pdf 不嵌也能过），
  // 而每多嵌一份就是几 MB。直接依赖才是"入口"，出问题一定是它。
  if (!directNames.has(name)) continue
  // 与收集可达集时同一套"同级依赖集"定位（pnpm 把依赖摆在包的同级）
  let resolved = real
  try {
    resolved = fs.realpathSync(real)
  } catch {
    /* ignore */
  }
  const nm = siblingNodeModules(resolved)
  if (!fs.existsSync(nm)) continue
  for (const dep of fs.readdirSync(nm)) {
    if (path.resolve(path.join(nm, dep)) === path.resolve(resolved)) continue
    const depNames = dep.startsWith("@")
      ? fs.readdirSync(path.join(nm, dep)).map((x) => `${dep}/${x}`)
      : [dep]
    for (const depName of depNames) {
      if (depName === ".bin") continue
      const realDep = path.join(nm, depName)
      let st
      try {
        st = fs.statSync(realDep)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      const want = pkgVersion(realDep)
      const have = pkgVersion(path.join(dest, depName))
      if (want && have && want === have) continue
      const nestedPath = path.join(dest, name, "node_modules", depName)
      if (fs.existsSync(path.join(nestedPath, "package.json"))) continue
      const size = pkgFilesSize(realDep)
      if (size > NEST_MAX_BYTES) {
        nestedSkipped.push(`${name}→${depName}@${want}(${Math.round(size / 1024)}KB)`)
        continue
      }
      copyPkg(realDep, nestedPath, true)
      nested += 1
    }
  }
}

console.log(
  `[deps] 实体化完成：可达包 ${reachable.size} 个（扁平）、定向嵌套 ${nested} 个版本分歧；` +
    `共 ${files} 个文件、${dirs} 个目录 → ${dest}`,
)
if (nestedSkipped.length) {
  console.log(
    `[deps] 注意：${nestedSkipped.length} 个版本分歧因包太大（>2MB）未嵌套，产物里用顶层版本：` +
      `${nestedSkipped.slice(0, 5).join(", ")}${nestedSkipped.length > 5 ? " …" : ""}`,
  )
}