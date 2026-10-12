# EvaWork Desktop

桌面 AI 工作台客户端：**Electron 壳 + Vue 渲染层 + TypeScript 智能体（agent-ts）**。
**没有后端服务**：登录/令牌、工作区、设置、文件、目录、MCP 等能力全部由主进程直接提供
（IPC + 本机文件），或由主进程拉起的 agent-ts 子进程提供。

## 项目结构

```
apps/desktop-node/  Electron 主进程：开窗 + 拉起 agent-ts 子进程 + 本机数据（IPC）
apps/desktop-ui/    Vue 3 + TS 渲染层，18 条 hash 路由
apps/agent-ts/      TypeScript 智能体运行时（唯一内核）
```

## 开发

```bash
pnpm install                          # 安装前端依赖
pnpm dev                              # 一键：vite dev(:1420) + Electron 壳（不再拉后端）
pnpm build                            # vite build → apps/desktop-ui/dist
pnpm typecheck                        # vue-tsc --noEmit
node scripts/gen-catalog.mjs --check   # 目录单一源与前端产物是否一致
```

打包：`pnpm build` 后 `cd apps/desktop-node && pnpm exec electron-builder --win nsis portable`。

改完 `.vue`/`.css` 必须重跑 `pnpm build`，否则 Electron 加载的是旧 dist。

## 文档（`.docs/`）

| 文档 | 内容 |
|---|---|
| `01_EvaWork Desktop 产品需求文档PRD.md` | 范围、路由、功能需求、非功能与验收 |
| `02_EvaWork Desktop 设计系统规范.md` | 设计令牌、组件类、图标系统、状态约定 |
| `03_EvaWork Desktop UI设计文档.md` | 逐页界面说明与 Mock 数据映射 |
| `04_EvaWork Desktop 技术架构文档.md` | 分层、目录、构建链路、约束与验证 |
| `05_EvaWork Desktop 功能清单与进度.md` | 逐项状态，含"静态/点了没反应"清单 |
| `06_EvaWork Desktop 用户手册.md` | 装上就能用 + 常见问题 |

改界面后请同步 `03` 与 `05`，否则文档会说谎。

## 界面范围

- 新建任务 / 自动化 / 插件市场 / 模板库 / 设计规范 / 我的文件 / 办公助理
- 管理账户（`/admin`）：用量、账号、订阅、仪表盘、收藏盒、外部应用授权、云端运行环境、MCP、命令、规则
- 设置弹层 17 节，与上述页面同源 Mock

所有图标为内联 SVG（`src/components/icons.ts`），无外部图片资源。
