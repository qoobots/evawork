/**
 * 账户与登录态 API：真实 EVA 账号（eva-iam，OAuth2 授权码 + PKCE）。
 *
 * 与旧版「本地昵称会话」的关键差别：这里没有任何"填个名字就登录"的入口。
 *
 * **登录链路在主进程自治**（`apps/desktop-node/src/iam.js`）：PKCE verifier、令牌换取、
 * 令牌存储、refresh 轮换都在主进程里完成，渲染层拿到的始终是登录态结果，
 * 接触不到 PKCE verifier，也接触不到密码。
 *
 * 因此这里**不再走后端 HTTP**——后端正在废弃，而它曾是登录态的唯一持有者。
 * 全部改用主进程 IPC；纯浏览器环境（没有桥）时明确报错，而不是假装登录成功。
 */
export interface AccountUser {
  id: string;
  username: string;
  name: string;
  email: string;
  phone: string;
  roles: string[];
  activeTenantId: number | null;
  provider: string;
  cloud: boolean;
}

export interface AccountState {
  logged_in: boolean;
  user: AccountUser | null;
  cloud: boolean;
  provider: string;
  server: string;
  client_id: string;
}

export interface IamConfig {
  server: string;
  client_id: string;
  scope: string;
}

/**
 * 主进程桥是否可用。
 * 登录态不再依赖后端，所以"账号功能能不能用"的判据是**桥在不在**，
 * 而不是"后端地址有没有"——这两者以后端为准会让界面在桥缺失时永远显示"未连接后端"。
 */
export function iamAvailable(): boolean {
  const b = (window as unknown as { evawork?: IamBridge }).evawork;
  return Boolean(b && b.iamAccount);
}

/** 主进程桥的形状（与 preload.js 同源，改一处要同步另一处）。 */
interface IamBridge {
  iamLogin?: () => Promise<AccountState>;
  iamAccount?: () => Promise<AccountState>;
  iamLogout?: () => Promise<AccountState>;
  iamConfig?: () => Promise<IamConfig>;
  iamConfigSave?: (patch: Partial<IamConfig>) => Promise<IamConfig>;
}

/**
 * 取主进程桥上的某个能力；没有桥（纯 vite 预览）就明确报错。
 * 不静默兜底成"未登录"——那会把"环境不对"伪装成"用户没登录"，排障时方向全错。
 */
function bridge<K extends keyof IamBridge>(key: K): IamBridge[K] {
  const b = (window as unknown as { evawork?: IamBridge }).evawork;
  const fn = b && b[key];
  if (!fn) throw new Error('当前不是桌面运行环境（缺少主进程桥），账号功能不可用');
  return fn;
}

export function fetchAccount(): Promise<AccountState> {
  return bridge('iamAccount')!();
}

export function logoutAccount(): Promise<AccountState> {
  return bridge('iamLogout')!();
}

export function fetchIamConfig(): Promise<IamConfig> {
  return bridge('iamConfig')!();
}

export function saveIamConfig(patch: Partial<IamConfig>): Promise<IamConfig> {
  return bridge('iamConfigSave')!(patch);
}

/** 发起浏览器登录：整条链路在主进程里完成，渲染层只等结果。 */
export function startIamLogin(): Promise<AccountState> {
  return bridge('iamLogin')!();
}
