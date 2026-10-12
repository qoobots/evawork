# EvaWork Desktop · 技术架构文档（Electron + Python）

> 本文档随技术栈由 **Rust 壳** 迁移到 **Electron + Python** 重写。前端 Vue 界面零重写，作为 Electron 渲染层复用；Python 只做智能体后端，且与外壳解耦。

## 1. 一句话架构

**Electron 主进程当窗口壳并拉起 Python 智能体后端；业务界面是复用的 Vue 3 SPA；数据来自 Python 后端（FastAPI，localhost），无后端时回退内存 Mock。**

```
┌──────────────────────────────────────────────────────────┐
│ Electron 主进程（apps/desktop-node）                       │
│   src/main.js：spawn python -m evawork → 等 /api/health   │
│                → 开窗口加载 Vue dist → IPC 注入后端地址     │
│   src/preload.js：暴露 window.trawork（后端 URL）          │
├──────────────────────────────────────────────────────────┤
│ Vue 3 SPA（apps/desktop-ui，复用，不重写）                 │
│   router(hash) → views → components                         │
│   src/api/backend.ts：直连 http://127.0.0.1:<port>          │
│   data/mock.ts：无后端时的兜底数据                          │
├──────────────────────────────────────────────────────────┤
│ Python 后端（apps/desktop-py，shell-agnostic）             │
│   FastAPI：/api/health · /api/design-systems · /api/chat   │
│   evawork/agent.py：智能体内核（async 生成器，SSE 流式）   │
│   evawork/design_assets.py：读 .docs 真实设计资产          │
└──────────────────────────────────────────────────────────┘
```

## 2. 目录结构

```
eva-desktop/
├── apps/desktop-ui/            前端渲染层（复用，唯一有界面业务代码）
│   ├── src/
│   │   ├── api/backend.ts      渲染层 ↔ 后端的对接接缝（无后端回退 mock）
│   │   ├── data/mock.ts        全部展示数据（兜底）
│   │   ├── stores/ui.ts        Pinia 内存状态（mode / tasks / 浮层）
│   │   ├── views/              8 主壳页 + views/admin/ 11 深色页
│   │   └── styles/app.css      设计令牌 + 通用组件类
│   ├── vite.config.ts          alias @ → ./src
│   └── package.json            @evawork/desktop-ui
├── apps/desktop-node/          Electron 外壳（窗口 + 拉起 Python）
│   ├── package.json            @evawork/desktop-node（electron 依赖）
│   └── src/main.js, preload.js
├── apps/desktop-py/            Python 智能体后端（FastAPI，端口默认 18765）
│   ├── requirements.txt        fastapi / uvicorn / pydantic
│   └── evawork/
│       ├── config.py           端口 / .docs 资源根
│       ├── design_assets.py    读 .docs/TRAE-UI设计/design/*/css.json 真实色板
│       ├── agent.py            智能体内核（离线占位，契约稳定）
│       ├── api.py              FastAPI 路由
│       └── main.py             装配 + uvicorn 启动
├── package.json                根工作区（dev/build/typecheck）
└── pnpm-workspace.yaml         只含 apps/*
```

## 3. 技术选型

| 层 | 选型 | 版本 |
|---|---|---|
| 桌面壳 | Electron（主进程 + 渲染层） | 31.x |
| 后端 | Python + FastAPI（localhost HTTP/SSE） | 3.12 / 0.111 |
| 智能体内核 | pydantic-ai / langgraph（待装，替换 agent.py 占位） | — |
| 框架 | Vue 3（`<script setup>` + TS） | 3.5.x |
| 构建 | Vite | 5.4.x |
| 状态 | Pinia | 2.2.x |
| 路由 | vue-router（hash 模式） | 4.4.x |
| 类型检查 | vue-tsc + TypeScript | 5.6.x / 2.1.x |
| 打包 | electron-builder（MSI/NSIS/dmg） | 最新 |
| 运行时 | Node ≥ 20（pnpm）；Python ≥ 3.12 | — |

**为什么用 hash 路由**：Electron 加载本地资源（`app://` 或 `file://`），刷新无服务端兜底；hash 模式不因路径 404，沿用旧约定。

## 4. 数据流

```
mock.ts ──┐
           ├─▶ backend.ts ──fetch──▶ Python /api/* ──▶ agent / design_assets
views ◀───┘   (无后端走 mock；有后端覆盖 mock)
stores/ui.ts：mode / tasks / 浮层开关（内存）
```

- **契约稳定**：渲染层经 `src/api/backend.ts` 直连 `http://127.0.0.1:<port>`，不依赖主进程代理。`GET /api/design-systems` 返回的字段已与 `DesignSystemView` 对齐（缺 `dark`/`hue2` 时模板自动回退）。
- **流式对话**：`POST /api/chat` 返回 `text/event-stream`，逐 token `data: <tok>\n\n`，结束发 `data: [DONE]\n\n`。
- **离线兜底**：`window.trawwork` 未注入（纯 `vite preview`）时，`getJSON()` 抛错，调用方回退 `data/mock.ts`，界面不崩。

## 5. 构建与打包

```bash
# 前端
pnpm install                 # 安装前端依赖
pnpm build                   # vite build → apps/desktop-ui/dist
pnpm typecheck               # vue-tsc --noEmit

# 后端
cd apps/desktop-py && pip install -r requirements.txt && python -m evawork
#   另开：curl http://127.0.0.1:18765/api/health

# 外壳
cd apps/desktop-node && npm install && npm start
#   （npm start = electron .，自动拉起 python 并加载 Vue dist）
```

链路要点：

1. Electron 主进程 `src/main.js` 在开窗口前先 `spawn python -m trawork`，轮询 `/api/health` 至多 ~24s，就绪后再 `loadURL`。
2. 后端地址经 `win.webContents.send('trawork:backend', URL)` 注入，`preload.js` 暴露为 `window.trawwork.getBackendURL()`；渲染层启动即读，缺失则走 mock。
3. **改 `.vue`/`.css` 必须重跑 `pnpm build`**，否则 Electron 加载的是旧 dist。
4. 发布用 `electron-builder` 产出 MSI/NSIS（Windows）/ dmg（macOS）——Electron 直接 `loadFile` 或 `loadURL` 本地 dist，没有 `custom-protocol` 概念。

产物体积（前端）：JS 158KB（gzip 62KB）、CSS 18KB（gzip 4KB），页面级 chunk 按路由懒加载。Python 侧体积取决于是否打包虚拟环境（建议用 `pip` + 轻量依赖，或 PyInstaller 打包后端）。

## 6. 关键约束（踩过坑，别再犯）

1. **后端地址不硬编码在渲染层**：必须经 `window.trawwork` 注入，端口由 `TRAWORK_BACKEND_PORT`（默认 18765）决定。
2. **CORS 仅开发期放开**：`api.py` 当前 `allow_origins=["*"]` 只为本地联调；发布期收紧为渲染层同源或固定白名单。
3. **Python 后端 shell-agnostic**：不依赖 Electron 专有 API；未来若换壳（如 PySide）可直接复用 `apps/desktop-py`。
4. **模型 API Key 走环境变量**：`agent.py` 只从 `os.environ` 读，不写死；智能体接口保持 `async def stream_chat(...) -> AsyncIterator[str]`，接 pydantic-ai/langgraph 时前端 SSE 消费方式不变。
5. **图标缺 key 是静默的**：`UIcon` 用 `v-html` 渲染字典路径，缺失键渲染空路径——不报错但空白；加图标前先查 `components/icons.ts`。
6. **删目录会被权限拦**（递归删除需批准），清理时用逐文件删除。

## 7. 验证方式

| 层次 | 做法 | 当前结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过 |
| 构建 | `pnpm build` | 通过 |
| 后端 | `python -m trawork` + `curl /api/health`、`/api/design-systems` | 后端代码就位，待本机执行验证 |
| 外壳启动 | `npm start` 拉起 electron + python，窗口出内容、进程存活 | electron 待装/验证 |
| 路由渲染 | 起静态服务托管 dist，headless chromium 遍历 18 条 hash 路由，收集 `console.error` / `pageerror` | 18/18 渲染干净（纯前端阶段） |

> 没有端到端用例工程（旧的 EVA e2e 已随旧客户端删除）。界面/后端改动后至少做一遍"路由渲染冒烟 + 后端 health"。

## 8. 技术债

1. **无加载/错误/重试状态**：数据全为同步常量。接后端后每个列表页都要补这三态（见 PRD 任务清单 T-050）。
2. **深色控制台没有令牌**：admin 侧色值硬编码在各自 `<style scoped>`，与 `app.css` 令牌并存两套；待令牌化（T-051）。
3. **持久化现在可行**：原型阶段为"最小权限"刻意不做持久化；Electron + Python 阶段可借 Python 侧 SQLite 落盘（设置/命令/授权/规则/自动化/任务），不再与权限冲突（T-040）。
4. **无 i18n**：语言入口只改文案变量，待落地（T-052）。
5. **无动效/无障碍规范**：待键盘可达性与对比度检查（T-053）。
6. **任务没有详情页**：侧栏任务只是标题，点击回首页；待状态机 + 产物（T-020）。
