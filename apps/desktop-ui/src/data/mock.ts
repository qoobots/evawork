/** 全站 Mock 数据：无任何后端，界面所示即全部 */

/** 与后端目录项同构的完整形态（含安全元数据）。 */
export interface CatalogItem {
  name: string; desc: string; icon: string; color: string; cats: string[];
  version?: string; publisher?: string; verified?: boolean;
  capabilities?: string[]; egress_policy?: string[]; agent_protocol?: string;
  abilities?: string[]; provides_context?: string[];
  [k: string]: unknown;
}

export interface PluginItem { name: string; desc: string; icon: string; color: string; cats: string[] }

export const pluginFeatureCards = [
  {
    title: '研究工具',
    items: ['前端设计工具集', '快速产品原型开发', 'GitHub'],
    art: 'code',
  },
  {
    title: '内容创作',
    items: ['短视频图片生成', '公众号图文创作', '小红书爆款图文生成'],
    art: 'media',
  },
  {
    title: '数据分析',
    items: ['数据准备工作台', '轻量数据洞察引擎', '科研数据助手'],
    art: 'chart',
  },
];

// T-142 / D1：目录数据（plugins / skills / templates / 各类 cats）**不再在本文件抄一份**。
// 唯一数据源是 apps/desktop-node/data/catalog.json，前端离线 mock 由它生成：
//   node scripts/gen-catalog.mjs          重新生成
//   node scripts/gen-catalog.mjs --check  校验是否漂移（CI 用）
// 这样后端运行时与前端离线看到的目录**不可能**不一致。
export {
  pluginCats,
  skillCats,
  templateCats,
  plugins,
  skills,
  templates,
  catalogPlugins,
  catalogSkills,
} from './catalog.generated';

export interface TemplateItem { title: string; hue: string; deco: string; cat: string; desc: string }

/* ---------- 设计系统 ---------- */

export interface DesignSystem {
  id: string;
  name: string;
  dark?: boolean;
  hue: string;
  hue2?: string;
  /** 主题页色板：大行（带全宽头）+ 小 swatch 行 */
  scales: { name: string; base: string; swatches: { name: string; hex: string }[] }[];
  /** 功能令牌行（灰底小块） */
  tokens?: { name: string; items: { name: string; hex: string }[] }[];
  fonts: { name: string; label: string }[];
  skillDesc: string;
}

function scale(name: string, base: string, dark: string, light: string): DesignSystem['scales'][number] {
  const hex = (m: number, M: number, i: number) => {
    const t = (i - m) / (M - m);
    const mix = (a: string, b: string) => {
      const pa = [1, 3, 5].map((k) => parseInt(a.slice(k, k + 2), 16));
      const pb = [1, 3, 5].map((k) => parseInt(b.slice(k, k + 2), 16));
      return '#' + pa.map((v, k) => Math.round(v + (pb[k] - v) * t).toString(16).padStart(2, '0')).join('');
    };
    return mix(dark, light);
  };
  const swatches = Array.from({ length: 10 }, (_, i) => ({
    name: `${name}-${1000 - i * 100}`,
    hex: hex(0, 9, i),
  }));
  return { name, base, swatches };
}

export const designSystems: DesignSystem[] = [
  {
    id: 'evawork',
    name: 'EvaWork',
    hue: '#5b57d9',
    scales: [],
    tokens: [
      { name: 'bg-brand', items: [
        { name: 'bg-brand', hex: '#5b51e3' }, { name: 'bg-brand-hover', hex: '#8a80ff' }, { name: 'bg-brand-active', hex: '#3c33c5' }, { name: 'bg-brand-disabled', hex: '#c3c1f3' }, { name: 'bg-brand-popup', hex: '#a9a7ff' }, { name: 'color-primary', hex: '#5b51e3' }, { name: 'color-primary-hover', hex: '#8a80ff' }, { name: 'color-primary-disab', hex: '#c3c1f3' }, { name: 'color-primary-soft', hex: '#a9a7ff' }, { name: 'color-accent', hex: '#5b51e3' },
      ] },
      { name: 'bg', items: [
        { name: 'bg', hex: '#ffffff' }, { name: 'bg-hover', hex: '#f5f5f6' }, { name: 'bg-active', hex: '#ebebee' }, { name: 'bg-disabled', hex: '#f7f7f8' }, { name: 'bg-popup', hex: '#ffffff' }, { name: 'bg-container', hex: '#fafafa' }, { name: 'bg-gray', hex: '#f2f2f3' }, { name: 'bg-dark', hex: '#26262a' }, { name: 'bg-inverse', hex: '#1c1c1f' },
      ] },
      { name: 'icon', items: [
        { name: 'icon-default', hex: '#262626' }, { name: 'icon-hover', hex: '#1f1f1f' }, { name: 'icon-secondary', hex: '#8c8c93' }, { name: 'icon-tertiary', hex: '#b3b3ba' }, { name: 'icon-disabled', hex: '#d4d4da' }, { name: 'icon-onbrand', hex: '#ffffff' }, { name: 'icon-brand', hex: '#5b51e3' }, { name: 'icon-brand-hover', hex: '#8a80ff' },
      ] },
      { name: 'text', items: [
        { name: 'text-default', hex: '#26262a' }, { name: 'text-secondary', hex: '#5c5c64' }, { name: 'text-tertiary', hex: '#8c8c93' }, { name: 'text-disabled', hex: '#b8b8c0' }, { name: 'text-inverse', hex: '#ffffff' }, { name: 'text-brand', hex: '#5b51e3' }, { name: 'text-brand-hover', hex: '#8a80ff' },
      ] },
      { name: 'border', items: [
        { name: 'border-neutral', hex: '#f2f2f2' }, { name: 'border-strong', hex: '#d9d9dc' }, { name: 'border-contrast', hex: '#000000' }, { name: 'color-border', hex: '#e5e5e8' }, { name: 'color-outline', hex: '#5b51e3' },
      ] },
      { name: 'status', items: [
        { name: 'status-info', hex: '#4d80f0' }, { name: 'status-success', hex: '#0cb277' }, { name: 'status-warning', hex: '#e8930c' }, { name: 'status-error', hex: '#e5484d' },
      ] },
    ],
    fonts: [
      { name: 'Inter', label: 'Font' },
      { name: 'Georgia', label: 'Font' },
      { name: 'JetBrains Mono', label: 'Font' },
    ],
    skillDesc: 'Use this skill to generate well-branded interfaces and assets for EvaWork.',
  },
  {
    id: 'evacode',
    name: 'EvaCode',
    dark: true,
    hue: '#1c1e24',
    scales: [scale('tc', '#3b82f6', '#0b1a2e', '#dbeafe')],
    tokens: [],
    fonts: [{ name: 'Inter', label: 'Font' }],
    skillDesc: 'Design Library skill specification',
  },
  {
    id: 'volcengine',
    name: 'Volcengine',
    hue: '#1664ff',
    scales: [scale('ve', '#1664ff', '#04123d', '#d6e4ff')],
    tokens: [],
    fonts: [{ name: 'Inter', label: 'Font' }],
    skillDesc: 'Design Library skill specification',
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    dark: true,
    hue: '#161623',
    hue2: '#fe2c55',
    scales: [
      scale('tk-red', '#fe2c55', '#0f0210', '#ffe8ee'),
      scale('tk-cyan', '#25f4ee', '#022322', '#e3fdfd'),
      scale('tk-black', '#161623', '#0b0b10', '#e8e8ed'),
      scale('tk-white', '#8a8a8d', '#58585b', '#ffffff'),
    ],
    tokens: [],
    fonts: [
      { name: 'Inter', label: 'Font' },
      { name: 'Georgia', label: 'Font' },
      { name: 'JetBrains Mono', label: 'Font' },
    ],
    skillDesc: 'Use this skill to generate well-branded interfaces and assets for TikTok — a social video...',
  },
  {
    id: 'doubao',
    name: 'Doubao',
    hue: '#1456f0',
    scales: [scale('db', '#1456f0', '#04123d', '#dbe7ff')],
    tokens: [],
    fonts: [{ name: 'Inter', label: 'Font' }],
    skillDesc: 'Design Library skill specification',
  },
  {
    id: 'apple',
    name: 'Apple',
    hue: '#e8e8ed',
    scales: [scale('ap', '#6e6e73', '#1d1d1f', '#f5f5f7')],
    tokens: [],
    fonts: [{ name: 'SF Pro', label: 'Font' }],
    skillDesc: 'Design Library skill specification',
  },
  {
    id: 'claude',
    name: 'Claude',
    hue: '#d97757',
    scales: [scale('cl', '#d97757', '#3d1f12', '#faeee8')],
    tokens: [],
    fonts: [{ name: 'Styrene', label: 'Font' }],
    skillDesc: 'Design Library skill specification',
  },
  {
    id: 'google',
    name: 'Google',
    hue: '#4285f4',
    scales: [scale('go', '#4285f4', '#0d2f6b', '#dbe8ff')],
    tokens: [],
    fonts: [{ name: 'Google Sans', label: 'Font' }],
    skillDesc: 'Design Library skill specification',
  },
];

/** 图形 tab 的图标名网格（借用 UIcon 名称 + 装饰命名，纯展示） */
export const graphicIcons = [
  'Doc_Default', 'error-simple', 'underline', 'c-2', 'design-library', 'Search', 'border-weg', 'deepseek-c', 'code-light', 'task',
  'check-off', 'artifacts-we', 'showcase-ic', 'explorer-lan', 'Like', 'system', 'figma', 'debug-fill', 'webview', 'user-banned',
  'chat-ai', 'explorer-fill', 'Doc-Loading', 'Service_Detail', 'gemini', 'debug', 'claude-outl', 'PlusCircle', 'Doc-Absent', 'claude',
  'Deploy_fill', 'success-sim', 'unit', 'search-doc', 'code-dark-c', 'java-2', 'tool2', 'bars-menu-2', 'deepseek-b', 'doc-ai-line',
  'linuxlink', 'cue-edit', 'glasses-read', 'fill-gradient', 'Previous-top', 'margin-hor', 'ai-sum', 'EVA-1', 'code-dark-s', 'Run_fill',
  'showcase-si', 'text-choice', 'explorer-lig', 'bonus', 'recent', 'addfile-dark', 'explorer-typ', 'user-add', 'solo-tool-tide', 'user-small',
];

/* ---------- 办公助理 ---------- */

export const commTools = [
  { name: '飞书', desc: '随手完成任务，即刻执行结果', status: 'bind', icon: 'feishu', color: '#00d6b9' },
  { name: '微信', desc: '随时提问问题，快速获取帮助', status: 'bind', icon: 'wechat', color: '#07c160' },
  { name: '企业微信', desc: '企业微信支持即将上线', status: 'soon', icon: 'wechat-work', color: '#4d80f0' },
  { name: '钉钉', desc: '钉钉支持即将上线', status: 'soon', icon: 'dingtalk', color: '#3296fa' },
];

/* ---------- 自动化 ---------- */

export const automationTemplates = [
  { title: '每日 AI 新闻简报', desc: '每天早上上传 latest AI 行业热点新闻摘要与趋势分析' },
  { title: '品牌舆情追踪周报', desc: '每周追踪指定品牌在社交媒体和社区中的提及与评价，生成品牌周报' },
  { title: '每周竞品动态追踪', desc: '定期追踪指定产品的更新、社区反馈和重要新闻' },
  { title: '股价监控与预警', desc: '每天监控指定股票价格变动，异常波动时自动预警' },
  { title: '安全漏洞扫描', desc: '定期扫描指定仓库，发现潜在过期依赖中可能安全漏洞' },
  { title: '扫描仓库发现 Bug', desc: '分析仓库的代码历史，发现可疑重复与高风险的 Bug' },
  { title: '补充测试覆盖', desc: '为指定仓库中缺少少测试的模块自动补充单元测试' },
  { title: '每日空注维新报', desc: '每天汇总知识库的变更更新，生成团队可以复盘的工程日报' },
];

export const automationConfigs = [
  { title: '每周商品动态追踪', product: 'Work', schedule: '每周三 16:30', on: true },
  { title: '每日 AI 新闻简报', product: 'Work', schedule: '每天 07:30', on: true },
];

/* ---------- 消息 ---------- */

export const messages = [
  { time: '08:26', title: '已开启 EVA 记忆，越用越懂你', body: 'Eva 记忆你的偏好和项目上下文，对话之后不用从头开始。随时可在设置中查看或关闭。（如果已关闭记忆开关，则忽略本条消息，系统会默认以你偏好的配置为准。）', action: '去设置' },
  { time: '08:17', title: 'EvaWork 接入 飞书/微信，随时在聊天中下达任务！', body: '在通讯工具里 @你的办公助理 EvaWork，消息自动转为任务，无需切换应用。直接在聊天里查看结果。', action: '去体验' },
  { time: '07:31', title: '全新积分体系即刻上线，专享额度坚持长编', body: 'Eva 全新积分体系上线，您将快速通知您可订户积分，优惠券和商城好礼；现有积分已升级为新积分。详情请查看公众号，更多福利持续进行中。', action: '查看详情' },
];

/* ---------- 模型清单 ---------- */

/* 不再内置兜底模型清单：早期写死的 Seed 系列 / GLM 系列名单已删除。
   模型一律来自模型通道（eva-ai /api/ai/v1/models 的模型广场）；
   拿不到就**显示空**并说明原因，不假装"有这些模型"。 */

export const modelProviders = ['自定义模型', 'DeepSeek', '火山引擎', 'MiniMax CN', 'MiniMax Global', 'Bigmodel', '阿里云', 'Xiaomi MIMO', '硅基流动', 'Z.ai', 'OpenRouter', 'Kimi CN', 'Kimi Global', 'BytePlus', 'AWS', '腾讯云', '极方舟', 'PPIO'];

/* ---------- MCP 市场 ---------- */

export const mcpServers = [
  { name: '稻壳PPT', desc: '稻壳 PPT MCP server，可根据主题生成 PPT。' },
  { name: 'RDS MSSQL MCP', desc: '火山引擎 RDS SQL Server 数据库开放接口，稳定可靠的云关系型数据库服务。' },
  { name: 'e宝宝', desc: '基于 Model Context Protocol (MCP) 的淘宝电商子买卖工具，支持商品上传、搜索、编辑、上下架、订单查询发货等。' },
  { name: 'DBW MCP', desc: '阿里云数据库工作台（Database Workbench，简称DBW），是一款面向...' },
  { name: 'toolhost', desc: '让 MCP Client 能够通过自然语言与 Toolhost 进行连接，降低复杂的服务，条...' },
  { name: 'Time', desc: 'Time and timezone conversion capabilities' },
];

/* ---------- 云端运行环境 ---------- */

export const runtimes = [
  { name: 'Python', ver: '3.14', color: '#3776ab' },
  { name: 'Node.js', ver: '24', color: '#3c873a' },
  { name: 'Go', ver: '1.25.1', color: '#00add8' },
  { name: 'Rust', ver: '1.92.0', color: '#b7410e' },
  { name: 'Java', ver: '25', color: '#e76f00' },
  { name: 'Ruby', ver: '3.4.4', color: '#cc342d' },
  { name: 'PHP', ver: '8.5', color: '#777bb3' },
  { name: 'Swift', ver: '6.2', color: '#f05138' },
];

/* ---------- 新建任务 ---------- */

export const quickChips = ['PPT', '文档', '数据分析', '视频', '图像', '产品开发', '内容创作'];

export const taskSuggestions = [
  { icon: 'chart', text: '根据我的持仓结构评估行业中度和主要风险' },
  { icon: 'video', text: '根据这段会议录音整理纪要、结论和待办事项' },
  { icon: 'user', text: '根据我的经历和项目制作一个交互式个人作品集' },
  { icon: 'sparkle', text: '根据我最近的项目和行业趋势预测市场机会' },
];

export const fileTypes = ['全部', '网页', '幻灯片', '文档', '表格', '视频', '图片'];
