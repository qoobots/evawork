import { createRouter, createWebHashHistory } from 'vue-router';

/** Hash 路由：Electron 加载本地资源，无服务端路由，避免刷新 404 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'new-task', component: () => import('@/views/NewTaskView.vue') },
    // 历史任务回显：与新建任务共用视图，按 id 回放后端事件日志
    { path: '/task/:id', name: 'task-detail', component: () => import('@/views/NewTaskView.vue') },
    { path: '/office', name: 'office', component: () => import('@/views/OfficeAssistantView.vue') },
    { path: '/market', name: 'market', component: () => import('@/views/PluginMarketView.vue') },
    { path: '/templates', name: 'templates', component: () => import('@/views/TemplateView.vue') },
    { path: '/design', name: 'design', component: () => import('@/views/DesignSystemView.vue') },
    { path: '/design/:id', name: 'design-detail', component: () => import('@/views/DesignSystemDetailView.vue') },
    { path: '/automation', name: 'automation', component: () => import('@/views/AutomationView.vue') },
    { path: '/files', name: 'files', component: () => import('@/views/MyFilesView.vue') },
    /* T-128：设置与管理控制台合并为一个界面 —— /admin 这一个壳里两组页面：
       「设置」= 本机偏好（SettingsPane，落 /api/settings 的 kv）；
       「管理」= 账号与服务资产（各 *Page，接真后端）。 */
    {
      /* 注意：父级不写成 `/admin/:page?`。那样 URL `/admin/general` 会被解析成
         ":page 为空 + 子路由 general"，params.page 恒为 ''，SettingsPane 就只能落到兜底节。
         节名一律由子路由路径决定（组件里从 route.path 取）。 */
      path: '/admin',
      name: 'admin',
      component: () => import('@/views/admin/AdminLayout.vue'),
      children: [
        { path: '', redirect: '/admin/general' },
        // 本机偏好
        { path: 'general', component: () => import('@/views/admin/SettingsPane.vue') },
        { path: 'privacy', component: () => import('@/views/admin/SettingsPane.vue') },
        { path: 'chat', component: () => import('@/views/admin/SettingsPane.vue') },
        { path: 'browser', component: () => import('@/views/admin/SettingsPane.vue') },
        { path: 'computer', component: () => import('@/views/admin/SettingsPane.vue') },
        { path: 'worktree', component: () => import('@/views/admin/SettingsPane.vue') },
        { path: 'model', component: () => import('@/views/admin/SettingsPane.vue') },
        { path: 'mobile', component: () => import('@/views/admin/SettingsPane.vue') },
        { path: 'context', component: () => import('@/views/admin/SettingsPane.vue') },
        { path: 'agent', component: () => import('@/views/admin/SettingsPane.vue') },
        { path: 'beta', component: () => import('@/views/admin/SettingsPane.vue') },
        { path: 'about', component: () => import('@/views/admin/SettingsPane.vue') },
        // 账号与服务
        { path: 'usage', component: () => import('@/views/admin/UsagePage.vue') },
        { path: 'account', component: () => import('@/views/admin/AccountPage.vue') },
        { path: 'dashboard', component: () => import('@/views/admin/DashboardPage.vue') },
        { path: 'favorites', component: () => import('@/views/admin/FavoritesPage.vue') },
        { path: 'rules', component: () => import('@/views/admin/RulesPage.vue') },
        { path: 'commands', component: () => import('@/views/admin/CommandsPage.vue') },
        { path: 'integrations', component: () => import('@/views/admin/IntegrationsPage.vue') },
        { path: 'cloud-env', component: () => import('@/views/admin/CloudEnvPage.vue') },
        { path: 'mcp', component: () => import('@/views/admin/McpPage.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
