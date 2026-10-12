<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import UIcon from '@/components/UIcon.vue';
import { useUiStore } from '@/stores/ui';
import { useAccountStore } from '@/stores/account';
import { onBackend } from '@/api/backend';
import { useThemeStore, type ThemeMode } from '@/stores/theme';
import { useI18nStore } from '@/stores/i18n';
import { useEscape } from '@/composables/useEscape';
import { localeLabels, type Locale } from '@/i18n';

const ui = useUiStore();
const account = useAccountStore();
const router = useRouter();

const theme = useThemeStore();
const i18n = useI18nStore();

/* T-052b：语言/主题改成「右侧飞出」子菜单（原来是在菜单里往下顶开，把下面的
   设置/报告问题顶走，且菜单本身没有横向余量）。飞出层挂在触发项外面（absolute），
   菜单本体高度不变。悬停即开（Win11 / VS Code 的行为），点一下则"锁住"，
   移开鼠标也不收——否则鼠标从触发项挪到飞出层时会被 mouseleave 打断。 */
type Flyout = 'lang' | 'theme';
const flyoutOpen = ref<Flyout | null>(null);
const flyoutPinned = ref(false);

const isOpen = (k: Flyout) => flyoutOpen.value === k;
const langOpen = computed(() => isOpen('lang'));
const themeOpen = computed(() => isOpen('theme'));

/** 悬停：只开不锁；没锁住时鼠标一移开就收起。 */
function peek(k: Flyout, enter: boolean) {
  if (enter) {
    // 换到另一个飞出层时，上一个的"锁"不跟着继承过来，否则新面板再也关不掉
    if (flyoutOpen.value !== k) flyoutPinned.value = false;
    flyoutOpen.value = k;
  } else if (!flyoutPinned.value && flyoutOpen.value === k) {
    flyoutOpen.value = null;
  }
}

/** 点击：再点一次才收，收了就是"解锁"，移开鼠标不再影响。 */
function toggle(k: Flyout) {
  if (isOpen(k) && flyoutPinned.value) {
    flyoutPinned.value = false;
    flyoutOpen.value = null;
    return;
  }
  flyoutPinned.value = true;
  flyoutOpen.value = k;
}

function closeFlyouts() {
  flyoutOpen.value = null;
  flyoutPinned.value = false;
}

function chooseLocale(l: Locale) {
  i18n.set(l);
  closeFlyouts();
}

function chooseTheme(mode: ThemeMode) {
  theme.set(mode);
  closeFlyouts();
}

/* 菜单本体收起（点遮罩/退出登录）时飞出层必须跟着走，否则会留一个孤儿面板 */
watch(() => ui.meMenuOpen, (open) => {
  if (!open) closeFlyouts();
});

/* T-052：语言切换会真的替换界面文案（此前这个下拉只是改了个本地变量） */
const locales: Locale[] = ['zh', 'en'];

/* T-051：主题切换落到 <html data-theme> 上的令牌，切的是真主题 */
const themeOptions = [
  { k: 'light', key: 'theme.light' },
  { k: 'dark', key: 'theme.dark' },
  { k: 'system', key: 'theme.system' },
] as const;

/* 登录态来自 EVA IAM：浏览器 SSO 由主进程发起，退出会真的清掉本地会话 */
const bridge = (window as unknown as {
  evawork?: { onAccount?: (cb: (s: unknown) => void) => void };
}).evawork;

onMounted(() => {
  // 主进程在别的窗口/时机完成登录时也会推过来，界面不用等下一次轮询
  bridge?.onAccount?.((s) => {
    const st = s as { logged_in?: boolean; user?: typeof account.user };
    if (st && typeof st === 'object') {
      account.user = st.user ?? null;
    }
  });
});

const themeLabel = computed(() => {
  const hit = themeOptions.find((t) => t.k === theme.mode);
  return hit ? i18n.t(hit.key) : i18n.t('theme.light');
});

/** 浏览器 SSO：主进程拉起系统浏览器，用户在那边登录，密码不经过本客户端。 */
async function doLogin() {
  await account.login();
}

/**
 * T-116：后端地址没到时的出路。
 *
 * 地址由主进程注入，可能晚于首帧（main.js 不等后端就开窗）。此前这种情况只留一句
 * 灰色小字「未连接后端」，登录按钮是灰的、点了毫无反应——用户唯一能做的是重启应用。
 * 这里把重读接上：连上了菜单当场变成已登录态，没连上就维持原样，不做假动作。
 */
function reconnect() {
  account.syncBackend();
}

async function doLogout() {
  await account.logout();
  closeFlyouts();
  ui.meMenuOpen = false;
}

// 后端地址可能晚于首帧注入（main.js 不等后端就开窗）：地址到了要重读登录态，
// 否则 online 这个 getter 会把"没连上"永久缓存，界面一直卡在未登录。
onMounted(() => account.syncBackend());
onBackend(() => account.syncBackend());

// T-053：Esc 关闭用户菜单（键盘用户不该被困在浮层里）
useEscape(() => {
  closeFlyouts();
  ui.meMenuOpen = false;
});
</script>

<template>
  <div class="me-root">
    <!-- 我的 浮层菜单 -->
    <div v-if="ui.meMenuOpen" class="me-mask" @click.self="ui.meMenuOpen = false">
      <div class="me-pop" @click.stop>
        <div class="me-head">
          <div class="me-user">
            <div class="avatar">{{ account.initial }}</div>
            <div>
              <div class="me-name">
                {{ account.displayName }}
                <span class="tag tag-gray">
                  {{ account.loggedIn ? i18n.t('menu.iam_account') : i18n.t('menu.not_logged') }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 未登录：走浏览器 SSO，密码始终留在浏览器里 -->
        <div v-if="!account.loggedIn" class="login-box">
          <button
            class="login-btn wide"
            :disabled="account.busy || !account.online"
            @click="doLogin"
          >
            {{ account.busy ? i18n.t('menu.logging_in') : i18n.t('menu.iam_login') }}
          </button>
          <!-- 离线不是死局：给一个能真的重连的按钮，而不是只留一行灰字 -->
          <div v-if="!account.online" class="offline-row">
            <span class="login-tip">{{ i18n.t('common.offline') }}</span>
            <button type="button" class="retry-btn" @click="reconnect">{{ i18n.t('common.retry') }}</button>
          </div>
          <p v-else-if="account.error" class="login-tip err">{{ account.error }}</p>
          <p v-else class="login-tip">{{ i18n.t('menu.login_hint') }}</p>
          <p v-if="account.server" class="login-tip">{{ i18n.t('menu.server') }}：{{ account.server }}</p>
        </div>
        <div v-else class="login-box">
          <div v-if="account.rolesLabel" class="login-tip">{{ i18n.t('menu.roles') }}：{{ account.rolesLabel }}</div>
          <div class="login-tip">{{ i18n.t('menu.server') }}：{{ account.server || '—' }}</div>
        </div>

        <!-- T-053：菜单项一律用 button，键盘能 Tab 到、能回车触发 -->
        <div class="me-list">
          <!-- T-128：设置已并入管理控制台，「管理账户」子菜单（账号设置/用量管理）成了重复入口，删掉；
               账号与用量在 /admin 侧栏里都有 -->
          <button type="button" class="me-item" @click="ui.messagesOpen = true; ui.meMenuOpen = false">
            <UIcon name="bell" :size="15" /><span>{{ i18n.t('menu.messages') }}</span>
          </button>

          <!-- T-052b：选项飞出到右侧，菜单本体不再被往下顶 -->
          <div class="me-row" @mouseenter="peek('lang', true)" @mouseleave="peek('lang', false)">
            <button type="button" class="me-item" :aria-expanded="langOpen" @click="toggle('lang')">
              <UIcon name="globe" :size="15" /><span>{{ i18n.t('menu.language') }}</span>
              <span class="value">{{ localeLabels[i18n.locale] }}</span>
              <UIcon name="chevron-right" :size="13" class="arrow" :class="{ open: langOpen }" />
            </button>
            <Transition name="flyout">
              <!-- 只列已落字典的语言：列一个点了没变化的"日本語"等于骗人 -->
              <div v-if="langOpen" class="flyout">
                <button
                  v-for="l in locales" :key="l" type="button" class="flyout-item"
                  @click="chooseLocale(l)"
                >
                  <span>{{ localeLabels[l] }}</span>
                  <UIcon v-if="i18n.locale === l" name="check" :size="12" class="tick" />
                </button>
              </div>
            </Transition>
          </div>

          <div class="me-row" @mouseenter="peek('theme', true)" @mouseleave="peek('theme', false)">
            <button type="button" class="me-item" :aria-expanded="themeOpen" @click="toggle('theme')">
              <UIcon name="sun" :size="15" /><span>{{ i18n.t('menu.theme') }}</span>
              <span class="value">{{ themeLabel }}</span>
              <UIcon name="chevron-right" :size="13" class="arrow" :class="{ open: themeOpen }" />
            </button>
            <Transition name="flyout">
              <div v-if="themeOpen" class="flyout">
                <button
                  v-for="t in themeOptions" :key="t.k" type="button" class="flyout-item"
                  @click="chooseTheme(t.k)"
                >
                  <span>{{ i18n.t(t.key) }}</span>
                  <UIcon v-if="theme.mode === t.k" name="check" :size="12" class="tick" />
                </button>
              </div>
            </Transition>
          </div>

          <!-- T-128：设置已并入管理控制台，这里直接进那一个界面（不再开弹窗） -->
          <button type="button" class="me-item" @click="closeFlyouts(); ui.meMenuOpen = false; router.push('/admin/general')">
            <UIcon name="gear" :size="15" /><span>{{ i18n.t('menu.settings') }}</span>
          </button>
          <button type="button" class="me-item" @click="closeFlyouts()">
            <UIcon name="help" :size="15" /><span>{{ i18n.t('menu.report') }}</span>
          </button>
        </div>

        <!-- 只在已登录时出现：未登录还给个"退出登录"按钮（哪怕禁用）就是在自相矛盾 -->
        <button
          v-if="account.loggedIn"
          class="logout" :disabled="account.busy"
          title="退出 EVA 账号并清除本地令牌"
          @click="doLogout"
        ><UIcon name="logout" :size="14" /> {{ i18n.t('menu.logout') }}</button>
      </div>
    </div>

    <!-- 左下角用户条 -->
    <button class="me-bar" @click.stop="ui.meMenuOpen = !ui.meMenuOpen">
      <div class="avatar sm">{{ account.initial }}</div>
      <span class="me-bar-name">{{ account.displayName }}</span>
      <span class="tag tag-gray">
        {{ account.loggedIn ? i18n.t('menu.iam_account') : i18n.t('menu.not_logged') }}
      </span>
      <UIcon name="phone" :size="13" class="me-bar-ic" />
    </button>
  </div>
</template>

<style scoped>
/* T-115：`flex: none` —— 侧栏是 flex 列，任务列表再长也不许压缩这一条。
   少了它，任务多时账号条会被压扁/挤出可视区（"左下角账号不见了"的成因之一）。 */
.me-root { margin-top: 6px; position: relative; flex: none; }
.me-mask { position: fixed; inset: 0; z-index: 50; }
.me-pop {
  position: fixed; left: 10px; bottom: 52px; width: 268px;
  /* T-052b：内边距提成令牌。飞出层靠它算出「与菜单右边缘齐平」的位置，
     写死数值就得跟着 padding 一起改。 */
  --me-pad: 14px;
  /* T-052b：飞出层阴影**只往右下**投。菜单用的是对称的 0 8px 32px，若直接借用，
     面板左侧（正压在菜单上）会铺开一片暗晕，面板看着就像浮在菜单外面一段距离——
     "距离过远"真正的来源是这道晕，不是那 2px 间隙。 */
  --me-flyout-shadow: 6px 10px 28px rgba(23, 25, 30, 0.12);
  background: var(--panel); border-radius: 16px; box-shadow: var(--shadow);
  padding: var(--me-pad); z-index: 51;
}
:global([data-theme='dark']) .me-pop { --me-flyout-shadow: 6px 10px 28px rgba(0, 0, 0, 0.45); }
.me-head { display: flex; align-items: center; justify-content: space-between; }
.me-user { display: flex; align-items: center; gap: 10px; }
.avatar {
  width: 34px; height: 34px; border-radius: 50%; background: linear-gradient(135deg, #9ec3f5, #6f8ef2);
  color: #fff; font-size: 13px; font-weight: 700; display: flex; align-items: center; justify-content: center;
}
.avatar.sm { width: 24px; height: 24px; font-size: 11px; }
.me-name { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
/* EVA 账号登录（浏览器 SSO） */
.login-box { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.login-btn {
  height: 30px; border-radius: 8px; background: var(--violet); color: #fff; font-size: 12.5px;
}
.login-btn.wide { width: 100%; }
.login-btn:disabled { background: var(--violet-soft); cursor: default; }
.login-tip { margin: 0; font-size: 11px; color: var(--t3); }
.login-tip.err { color: var(--err); }
/* T-116：离线时的「重试」——比一行灰字多的那点可操作性，正好是用户唯一能做的事 */
.offline-row { display: flex; align-items: center; gap: 8px; }
.retry-btn {
  margin-left: auto; padding: 3px 9px; border-radius: 6px;
  border: 1px solid var(--line); font-size: 11.5px; color: var(--t1);
}
.retry-btn:hover { background: var(--line-2); }
.me-list { margin-top: 10px; }
.me-item {
  /* T-052b：`width: 100%` 不能省。<button> 即使 display:flex，Chromium 仍按内容收缩
     （实测整行只67px 宽），于是 .value/.arrow 的 `margin-left: auto` 完全失效——「简体中文」
     紧贴文字、箭头也跟在后面，而飞出层是按整行右边缘定位的，于是面板离文字/箭头 100+px，
     看着就是"飘在很远的地方"。撑满整行后 value/arrow 被推到右侧（行右端 256），
     面板紧挨着弹出。 */
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 8px 8px; border-radius: 8px; font-size: 13px; cursor: pointer; color: var(--t1);
}
.me-item:hover { background: var(--line-2); }
.me-item svg:first-child { color: var(--t2); }
.arrow { margin-left: auto; color: var(--t3); transition: transform 0.15s; }
.arrow.open { transform: rotate(90deg); }
.value { margin-left: auto; color: var(--t2); font-size: 12px; }
/* T-052b：飞出层（语言/主题）。挂在触发行上靠 absolute，菜单本体高度不变。
   水平只留 2px：面板从菜单右侧"长出来"，盖住菜单的右内边距，视觉上紧挨着触发行
   （箭头右端 → 面板左边缘约 10px）。左侧不留圆角、不画左边框，阴影只往右下
   ——面板和菜单看上去是一整块，而不是"贴着一个独立浮层"。
   ::before 是向左溢出 --me-pad 的透明命中区：指针从菜单右侧内边距横穿进来时
   仍算在面板内，行不会先收到 mouseleave，面板不会"闪一下就没"。 */
.me-row { position: relative; }
.flyout {
  position: absolute; left: calc(100% + 2px); top: -4px; z-index: 2;
  min-width: 148px; padding: 5px; border-radius: 0 10px 10px 0;
  background: var(--panel); border: 1px solid var(--line); border-left: 0;
  box-shadow: var(--me-flyout-shadow);
  transform-origin: left center;
}
.flyout::before {
  content: ''; position: absolute; left: calc(-1 * var(--me-pad));
  top: 0; bottom: 0; width: var(--me-pad);
}
.flyout-item {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 7px 9px; border-radius: 7px; font-size: 12.5px; color: var(--t2); text-align: left;
}
.flyout-item:hover { background: var(--line-2); color: var(--t1); }
.flyout-item .tick { margin-left: auto; color: var(--violet); }
/* 窗口窄到右侧放不下时改为向左飞出，别把选项顶出可视区 */
@media (max-width: 560px) {
  .flyout {
    left: auto; right: calc(100% + 2px);
    border-radius: 10px 0 0 10px; border-left: 1px solid var(--line); border-right: 0;
    transform-origin: right center;
  }
  .flyout::before { left: auto; right: calc(-1 * var(--me-pad)); }
}
.flyout-enter-active, .flyout-leave-active { transition: opacity 0.12s, transform 0.12s; }
.flyout-enter-from, .flyout-leave-to { opacity: 0; transform: scale(0.96); }
.logout {
  width: 100%; height: 34px; margin-top: 8px; border-radius: 9px; border: 1px solid var(--line);
  display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 13px; color: var(--t1);
}
.logout:hover { background: var(--line-2); }
.me-bar {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 7px 8px; border-radius: 10px;
}
.me-bar:hover { background: var(--hover); }
.me-bar-name { font-size: 13px; font-weight: 600; }
.me-bar-ic { margin-left: auto; color: var(--t3); }
</style>
