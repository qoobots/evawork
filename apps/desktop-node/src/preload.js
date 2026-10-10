/**
 * 预加载脚本：向渲染层暴露 window.evawork。
 * 后端地址由主进程在页面加载完成后通过 IPC 注入（异步到达，渲染层用 mock 兜底）。
 *
 * T-113：这里的频道名与主进程 main.js 的 send/handle、渲染层的 window.evawork
 * 是同一个契约——改一处必须三处同步，否则后端地址注入不进来。
 */
const { contextBridge, ipcRenderer } = require('electron');

let url = '';
const listeners = [];
const shortcutListeners = [];
const accountListeners = [];
// TS 智能体的事件流（事件/状态/审批请求/退出），由主进程子进程转发而来
const tsAgentListeners = [];

ipcRenderer.on('evawork:backend', (_event, u) => {
  url = u;
  listeners.forEach((cb) => cb(u));
});

ipcRenderer.on('evawork:shortcut', (_event, msg) => {
  shortcutListeners.forEach((cb) => cb(msg));
});

// 浏览器 SSO 完成后的登录态（含主进程在别的窗口触发的情况）
ipcRenderer.on('evawork:account', (_event, state) => {
  accountListeners.forEach((cb) => cb(state));
});

ipcRenderer.on('evawork:ts-agent', (_event, payload) => {
  tsAgentListeners.forEach((cb) => cb(payload));
});

contextBridge.exposeInMainWorld('evawork', {
  getBackendURL: () => url,
  onBackend: (cb) => {
    listeners.push(cb);
    if (url) cb(url);
  },
  // T-055：主进程全局快捷键 → 渲染层
  onShortcut: (cb) => {
    shortcutListeners.push(cb);
  },
  /** EVA 账号登录：拉起系统浏览器完成 SSO，resolve 后返回登录态。
      登录链路在主进程自治（PKCE + 令牌），不经后端。 */
  iamLogin: () => ipcRenderer.invoke('evawork:iam-login'),
  /** 读登录态（主进程持有会话，进程重启仍登录）。 */
  iamAccount: () => ipcRenderer.invoke('evawork:iam-account'),
  /** 退出登录：清掉本机会话。 */
  iamLogout: () => ipcRenderer.invoke('evawork:iam-logout'),
  /** EVA 服务配置（server / client_id / scope）读写。 */
  iamConfig: () => ipcRenderer.invoke('evawork:iam-config'),
  iamConfigSave: (patch) => ipcRenderer.invoke('evawork:iam-config-save', patch),
  openExternal: (target) => ipcRenderer.invoke('evawork:iam-open-external', target),
  /** 工作区根（主进程持有，不再经后端）。 */
  workspaceGet: () => ipcRenderer.invoke('evawork:workspace-get'),
  workspaceSet: (p) => ipcRenderer.invoke('evawork:workspace-set', p),
  /** S-23：内置浏览器命令——直接下发主进程执行并同步返回结果。 */
  browserCommand: (cmd) => ipcRenderer.invoke('evawork:browser-command', cmd),
  /** 内置浏览器状态（窗口在不在）+ 自动截图清单。 */
  browserState: () => ipcRenderer.invoke('evawork:browser-state'),
  /** 取一张自动截图，返回可直接给 <img src> 的 data URL。 */
  browserShot: (name) => ipcRenderer.invoke('evawork:browser-shot', name),
  /** S-25：BYOK 自定义通道（Key 只存本机，列表只回显后 4 位）。 */
  providersList: () => ipcRenderer.invoke('evawork:providers-list'),
  providersAdd: (draft) => ipcRenderer.invoke('evawork:providers-add', draft),
  providersUpdate: (id, patch) => ipcRenderer.invoke('evawork:providers-update', { id, patch }),
  providersDelete: (id) => ipcRenderer.invoke('evawork:providers-delete', { id }),
  providersTest: (a) => ipcRenderer.invoke('evawork:providers-test', a),
  /** 本机集合存储（控制台配置 / 设计系统 / 模板 / 自动化）。 */
  storeList: (name) => ipcRenderer.invoke('evawork:store-list', { name }),
  storeGet: (name, id) => ipcRenderer.invoke('evawork:store-get', { name, id }),
  storePut: (name, item) => ipcRenderer.invoke('evawork:store-put', { name, item }),
  storeDelete: (name, id) => ipcRenderer.invoke('evawork:store-delete', { name, id }),
  storeReplace: (name, items) => ipcRenderer.invoke('evawork:store-replace', { name, items }),
  /** 目录（插件/技能/模板：静态数据）+ 模板收藏（本机）。 */
  catalogMeta: () => ipcRenderer.invoke('evawork:catalog-meta'),
  catalogItems: (a) => ipcRenderer.invoke('evawork:catalog-items', a),
  templatesMeta: () => ipcRenderer.invoke('evawork:templates-meta'),
  templatesList: (a) => ipcRenderer.invoke('evawork:templates-list', a),
  templateGet: (a) => ipcRenderer.invoke('evawork:template-get', a),
  /** 本地已装技能（目录与 agent-ts 一致：用户级 → 项目级）。 */
  skillsInstalled: () => ipcRenderer.invoke('evawork:skills-installed'),
  skillDetail: (name) => ipcRenderer.invoke('evawork:skill-detail', { name }),
  favoritesGet: () => ipcRenderer.invoke('evawork:favorites-get'),
  favoritesSet: (a) => ipcRenderer.invoke('evawork:favorites-set', a),
  /** MCP 服务：写入 agent-ts 真正读取的 mcp.json（不是另起一份配置）。 */
  mcpList: () => ipcRenderer.invoke('evawork:mcp-list'),
  mcpCreate: (a) => ipcRenderer.invoke('evawork:mcp-create', a),
  mcpPatch: (id, patch) => ipcRenderer.invoke('evawork:mcp-patch', { id, patch }),
  mcpDelete: (id) => ipcRenderer.invoke('evawork:mcp-delete', { id }),
  mcpTools: (id, refresh) => ipcRenderer.invoke('evawork:mcp-tools', { id, refresh }),
  /** S-22 工作树：真的 git worktree（只在工作区内的仓库上操作）。 */
  worktreeState: () => ipcRenderer.invoke('evawork:worktree-state'),
  worktreeCreate: (branch, base) => ipcRenderer.invoke('evawork:worktree-create', { branch, base }),
  worktreeDelete: (path, force) => ipcRenderer.invoke('evawork:worktree-delete', { path, force }),
  worktreePrune: (keep) => ipcRenderer.invoke('evawork:worktree-prune', { keep }),
  worktreeConfig: (patch) => ipcRenderer.invoke('evawork:worktree-config', patch),
  /** 自动化：条目存本机，cron 预览真解析（不自动触发，无本地调度器）。 */
  automationsList: () => ipcRenderer.invoke('evawork:automations-list'),
  automationsCreate: (a) => ipcRenderer.invoke('evawork:automations-create', a),
  automationsPatch: (id, patch) => ipcRenderer.invoke('evawork:automations-patch', { id, patch }),
  automationsRemove: (id) => ipcRenderer.invoke('evawork:automations-remove', { id }),
  automationsRuns: (limit) => ipcRenderer.invoke('evawork:automations-runs', { limit }),
  automationsPreview: (cron) => ipcRenderer.invoke('evawork:automations-preview', { cron }),
  automationsTick: () => ipcRenderer.invoke('evawork:automations-tick'),
  /** 用量统计（基于本地会话目录）。 */
  usage: (days) => ipcRenderer.invoke('evawork:usage', { days }),
  /** T-015：设置（通用 KV，落在主进程 userData）。 */
  settingsGet: () => ipcRenderer.invoke('evawork:settings-get'),
  settingsPut: (patch) => ipcRenderer.invoke('evawork:settings-put', patch),
  /** S-21：长期记忆（应用数据区的 user_profile.md）。 */
  memoryGet: () => ipcRenderer.invoke('evawork:memory-get'),
  memorySave: (content) => ipcRenderer.invoke('evawork:memory-save', content),
  memoryClear: () => ipcRenderer.invoke('evawork:memory-clear'),
  /* 我的文件 / 附件：主进程直接读写磁盘，不再经后端。 */
  filesRoots: () => ipcRenderer.invoke('evawork:files-roots'),
  filesScan: (a) => ipcRenderer.invoke('evawork:files-scan', a),
  filesTree: (a) => ipcRenderer.invoke('evawork:files-tree', a),
  filesContent: (a) => ipcRenderer.invoke('evawork:files-content', a),
  filesWrite: (a) => ipcRenderer.invoke('evawork:files-write', a),
  filesSave: (a) => ipcRenderer.invoke('evawork:files-save', a),
  filesAttach: (a) => ipcRenderer.invoke('evawork:files-attach', a),
  filesAttachRemove: (a) => ipcRenderer.invoke('evawork:files-attach-remove', a),
  /** 用系统默认程序打开（主进程校验在工作区/我的文件根内）。 */
  filesOpen: (a) => ipcRenderer.invoke('evawork:files-open', a),
  /** 系统目录选择对话框（工作区更换文件夹用）；取消返回空串。 */
  pickFolder: () => ipcRenderer.invoke('evawork:pick-folder'),
  /** 对话附件（+ 菜单「添加文件」）：系统多选文件框；取消返回空数组。 */
  pickFiles: () => ipcRenderer.invoke('evawork:pick-files'),
  /** 唤起框选截图工具；落临时 PNG 并返回绝对路径（由后端复制进工作区附件目录），取消返回空串。
      hideWindow=true 时截图前先隐藏本窗口，避免把 EvaWork 自己拍进图里。 */
  captureScreen: (hideWindow) => ipcRenderer.invoke('evawork:capture-screen', !!hideWindow),
  /** T-119：设置→关于 的「检查更新」，返回 { status, version?, message? }。 */
  checkUpdates: () => ipcRenderer.invoke('evawork:check-updates'),
  /** T-120：窗口栏（无边框窗口的标题栏带）颜色跟随内容主题，传 { color, symbolColor }。 */
  setTitleBarTheme: (theme) => ipcRenderer.send('evawork:titlebar-theme', theme),
  /** S-04：设置里的「保持电脑唤醒」立即生效（powerSaveBlocker）。 */
  setKeepAwake: (on) => ipcRenderer.send('evawork:keep-awake', !!on),
  /** S-20：设置里的「语音转录快捷键」立即生效（注册/注销 Alt+V 全局快捷键）。 */
  setVoiceHot: (on) => ipcRenderer.send('evawork:voice-hot', !!on),
  /** S-15：关于页的真实版本号（app.getVersion()），拿不到返回空串。 */
  appInfo: () => ipcRenderer.invoke('evawork:app-info'),
  /** T-120：是否启用了自定义标题栏——前端据此决定要不要给顶部留拖拽带。
   *  判据与 main.js 的 CUSTOM_TITLEBAR 同源（都看平台），别只改一边。 */
  customTitleBar: process.platform !== 'darwin',
  onAccount: (cb) => {
    accountListeners.push(cb);
  },

  /* TS 智能体（TS-011）：第二套智能体，与 Python 侧并存、互不感知。
     调用走 invoke（有返回值），流式事件走 onTsAgent 推送。
     频道名与主进程 tsAgent.js 三处一致，改一处要同步另外两处。 */
  tsAgent: {
    status: () => ipcRenderer.invoke('evawork:ts-agent-status'),
    start: (opts) => ipcRenderer.invoke('evawork:ts-agent-start', opts),
    prompt: (args) => ipcRenderer.invoke('evawork:ts-agent-prompt', args),
    cancel: (args) => ipcRenderer.invoke('evawork:ts-agent-cancel', args),
    stop: () => ipcRenderer.invoke('evawork:ts-agent-stop'),
    /** T-131：回放历史会话（主进程读落盘 JSONL，返回事件数组）。 */
    replay: (args) => ipcRenderer.invoke('evawork:ts-agent-replay', args),
    /** TS-065：上下文用量（分类明细）。子进程不在跑时主进程会临时拉起。 */
    contextUsage: (args) => ipcRenderer.invoke('evawork:ts-agent-context-usage', args),
    /** 模型清单（模型广场同步）：Python 后端废弃后的唯一来源。force=true 绕过缓存。 */
    models: (args) => ipcRenderer.invoke('evawork:ts-agent-models', args),
    /* 侧栏历史：列表 / 改名 / 删除 / 搜索。主进程直接读写落盘会话目录，
       不依赖子进程在不在跑——没登录时侧栏也该能翻旧账。 */
    sessions: () => ipcRenderer.invoke('evawork:ts-agent-sessions'),
    sessionRename: (sessionId, title) => ipcRenderer.invoke('evawork:ts-agent-session-rename', { sessionId, title }),
    sessionDelete: (sessionId) => ipcRenderer.invoke('evawork:ts-agent-session-delete', { sessionId }),
    sessionSearch: (term, sessionId) => ipcRenderer.invoke('evawork:ts-agent-session-search', { term, sessionId }),
    /** 调试模式（trace）：重拉子进程以套用最新的 EVA_TS_TRACE 环境变量。 */
    restart: () => ipcRenderer.invoke('evawork:ts-agent-restart'),
    /** 打开 trace 目录（系统文件管理器）。 */
    openTraceDir: () => ipcRenderer.invoke('evawork:open-trace-dir'),
    // 返回**取消订阅函数**：组件卸载后回调必须能摘掉，否则事件会继续往死组件里灌
    // （表现为"切换页面后旧会话的事件还在刷"）。
    on: (cb) => {
      tsAgentListeners.push(cb);
      return () => {
        const i = tsAgentListeners.indexOf(cb);
        if (i >= 0) tsAgentListeners.splice(i, 1);
      };
    },
  },

  /* TS-052：智能体二选一。选哪个决定主进程要不要拉起 TS 那套——
     两套智能体**互不感知、各自独立存储与历史**，所以选择必须持久、且切换要立刻生效
     （选了 Python 还把 TS 子进程挂在后台，用户会以为是"历史丢了"）。 */
  agentChoice: {
    get: () => ipcRenderer.invoke('evawork:agent-choice-get'),
    set: (agent) => ipcRenderer.invoke('evawork:agent-choice-set', String(agent || '')),
  },

});
