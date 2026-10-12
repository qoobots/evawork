import { defineStore } from 'pinia';
import { backendURL } from '@/api/backend';
import {
  fetchAccount,
  logoutAccount,
  startIamLogin,
  fetchIamConfig,
  saveIamConfig,
  iamAvailable,
  type AccountUser,
  type IamConfig,
} from '@/api/account';

/**
 * 登录态：账号来自 EVA IAM，**会话由主进程持有**（`apps/desktop-node/src/iam.js`）。
 *
 * 这里只做**镜像 + 操作入口**：左下角用户条、账号设置页、差异化 UI 永远看同一份状态。
 * 主进程桥不在时保持 `unknown`：界面显示"不可用"，而不是假装已登录。
 *
 * 两个判据要分开看，别混：
 *   - `online`（桥在不在）→ 决定账号功能能不能用；
 *   - `loggedIn`（有没有用户）→ 决定要不要先登录。
 * 登录态已经不经过后端了，所以 `backendUrl` 只作展示镜像，不再当"在线"的判据。
 *
 * 与旧实现最大的差别：没有 `login(name, email)` 了。桌面客户端不接收用户密码 ——
 * 密码一旦经过本机进程，泄露面就从 EVA 扩大到每一版桌面客户端。
 */
export const useAccountStore = defineStore('account', {
  state: () => ({
    loaded: false,
    user: null as AccountUser | null,
    error: '' as string,
    busy: false as boolean,
    server: '' as string,
    clientId: '' as string,
    configLoaded: false,
    /** 主进程桥是否可用：window.evawork 不是响应式源，getter 直接读它会永久缓存 */
    bridgeReady: false as boolean,
    /** 后端地址的响应式镜像（仅作展示，登录态不再依赖它） */
    backendUrl: '' as string,
  }),
  getters: {
    online: (s) => s.bridgeReady,
    loggedIn: (s) => s.user !== null,
    /** 昵称/用户名首字母，用作头像占位（IAM 未提供头像）。 */
    initial: (s) => (s.user?.name || s.user?.username || '?').trim().slice(0, 1).toUpperCase(),
    displayName: (s) => s.user?.name || s.user?.username || '未登录',
    rolesLabel: (s) => (s.user?.roles?.length ? s.user.roles.join(' / ') : ''),
  },
  actions: {
    /** 同步桥状态并重读登录态：onBackend 回调里也调它，桥晚到也能追上。 */
    syncBackend() {
      this.backendUrl = backendURL();
      this.bridgeReady = iamAvailable();
      if (this.bridgeReady) void this.load();
    },
    async load() {
      this.backendUrl = backendURL();
      this.bridgeReady = iamAvailable();
      if (!this.bridgeReady) {
        // 桥不在就是"不知道"，不猜
        this.error = '';
        this.loaded = false;
        return;
      }
      this.busy = true;
      try {
        const st = await fetchAccount();
        this.user = st.user;
        this.server = st.server || '';
        this.clientId = st.client_id || '';
        this.loaded = true;
        this.error = '';
      } catch (e) {
        this.error = (e as Error).message || '登录态读取失败';
      } finally {
        this.busy = false;
      }
    },
    /** 浏览器 SSO：拉起系统浏览器让用户登录，回到桌面时登录态已经就位。 */
    async login(): Promise<boolean> {
      this.busy = true;
      this.error = '';
      try {
        const st = await startIamLogin();
        this.user = st.user;
        this.server = st.server || '';
        this.clientId = st.client_id || '';
        this.loaded = true;
        return st.logged_in;
      } catch (e) {
        this.error = (e as Error).message || '登录失败';
        return false;
      } finally {
        this.busy = false;
      }
    },
    async logout() {
      this.busy = true;
      this.error = '';
      try {
        await logoutAccount();
        this.user = null;
        return true;
      } catch (e) {
        this.error = (e as Error).message || '退出失败';
        return false;
      } finally {
        this.busy = false;
      }
    },
    async loadConfig() {
      if (!iamAvailable()) return;
      const cfg: IamConfig = await fetchIamConfig();
      this.server = cfg.server || '';
      this.clientId = cfg.client_id || '';
      this.configLoaded = true;
    },
    async saveServer(server: string): Promise<boolean> {
      const value = server.trim();
      if (!value) {
        this.error = '服务地址不能为空';
        return false;
      }
      this.busy = true;
      try {
        const cfg: IamConfig = await saveIamConfig({ server: value });
        this.server = cfg.server || '';
        this.clientId = cfg.client_id || '';
        this.error = '';
        return true;
      } catch (e) {
        this.error = (e as Error).message || '保存失败';
        return false;
      } finally {
        this.busy = false;
      }
    },
  },
});
