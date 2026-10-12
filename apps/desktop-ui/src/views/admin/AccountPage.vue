<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAccountStore } from '@/stores/account';
import { useI18nStore } from '@/stores/i18n';

const account = useAccountStore();
const i18nStore = useI18nStore();
const serverDraft = ref('');
const serverEditing = ref(false);

onMounted(async () => {
  // syncBackend 与 UserMenu 同源：地址晚注入时也能追上，别把"还没连上"当永久状态
  account.syncBackend();
  await account.loadConfig();
  serverDraft.value = account.server;
});

async function doLogin() {
  await account.login();
}

async function doLogout() {
  await account.logout();
}

function startEditServer() {
  serverDraft.value = account.server;
  serverEditing.value = true;
}

async function saveServer() {
  const ok = await account.saveServer(serverDraft.value);
  if (ok) serverEditing.value = false;
}

/* 身份来自 IAM：这些字段能改就得改在 IAM 上，本机不能改 */
const thirdParty = [
  { t: '手机号', d: account.user?.phone || '未提供' },
  { t: '邮箱', d: account.user?.email || '未提供' },
  { t: '角色', d: account.rolesLabel || '无' },
  { t: '当前租户', d: String(account.user?.activeTenantId ?? '—') },
];

const initial = computed(() => account.initial);
</script>

<template>
  <div class="pg">
    <h1>{{ i18nStore.t('账号设置') }}</h1>
    <p class="sub">
      {{ i18nStore.t('登录方式：EVA 账号（eva-iam，浏览器 OAuth2 授权码 + PKCE）') }}
      {{ account.loggedIn ? `${i18nStore.t('· 当前用户：')}${account.user?.username || account.user?.name}` : i18nStore.t('· 当前未登录') }}
    </p>

    <p v-if="!account.online" class="notice">{{ i18nStore.t('未连接后端：登录态无法读取与保存。') }}</p>
    <p v-else-if="account.error" class="notice err">{{ account.error }}</p>

    <h2>{{ i18nStore.t('个人信息') }}</h2>
    <div class="panel">
      <div class="row">
        <div>
          <b class="row-t">{{ i18nStore.t('头像') }}</b>
          <div class="dim">{{ i18nStore.t('IAM 未提供头像，这里用账号首字母占位') }}</div>
        </div>
        <div class="avatar">{{ initial }}</div>
      </div>
      <div class="row">
        <div>
          <b class="row-t">{{ i18nStore.t('账号') }}</b>
          <div class="dim">{{ i18nStore.t('来自 EVA IAM，修改请在控制台「用户管理」里改') }}</div>
        </div>
        <span class="name">{{ account.user?.username || account.user?.name || i18nStore.t('未登录') }}</span>
      </div>
      <div class="row">
        <div>
          <b class="row-t">{{ i18nStore.t('用户 ID') }}</b>
          <div class="dim">{{ i18nStore.t('平台侧唯一标识，本机不可修改') }}</div>
        </div>
        <span class="name">{{ account.user?.id || '—' }}</span>
      </div>
    </div>

    <h2>{{ i18nStore.t('EVA 服务') }}</h2>
    <div class="panel">
      <div class="row">
        <div>
          <b class="row-t">{{ i18nStore.t('网关地址') }}</b>
          <div class="dim">{{ i18nStore.t('默认 http://localhost:8080/api/governance；接内网或云端时改这里') }}</div>
        </div>
        <div v-if="serverEditing" class="edit-row">
          <input v-model="serverDraft" class="name-input wide" @keyup.enter="saveServer" />
          <button class="btn-a primary" :disabled="account.busy" @click="saveServer">{{ i18nStore.t('保存') }}</button>
          <button class="btn-a" @click="serverEditing = false">{{ i18nStore.t('取消') }}</button>
        </div>
        <span v-else class="name">
          {{ account.server || i18nStore.t('未配置') }}
          <i @click="startEditServer">✎</i>
        </span>
      </div>
      <div class="row">
        <div>
          <b class="row-t">{{ i18nStore.t('客户端 ID') }}</b>
          <div class="dim">{{ i18nStore.t('在 IAM「应用管理（SSO 应用注册）」里注册本机客户端') }}</div>
        </div>
        <span class="name">{{ account.clientId || '—' }}</span>
      </div>
    </div>

    <h2>{{ i18nStore.t('账号操作') }}</h2>
    <div class="panel">
      <div v-for="a in thirdParty" :key="a.t" class="row">
        <div>
          <b class="row-t">{{ i18nStore.t(a.t) }}</b>
          <div class="dim">{{ i18nStore.t(a.d) }}</div>
        </div>
        <button class="btn-a" disabled>{{ i18nStore.t('只读') }}</button>
      </div>
      <div class="row">
        <div>
          <b class="row-t">{{ i18nStore.t('登录 / 退出') }}</b>
          <div class="dim">{{ i18nStore.t('登录会拉起系统浏览器，密码不会经过本机客户端') }}</div>
        </div>
        <div class="edit-row">
          <button
            v-if="!account.loggedIn" class="btn-a primary"
            :disabled="account.busy || !account.online" @click="doLogin"
          >{{ account.busy ? i18nStore.t('登录中…') : i18nStore.t('登录 EVA 账号') }}</button>
          <button
            v-else class="btn-a danger"
            :disabled="account.busy" @click="doLogout"
          >{{ i18nStore.t('退出登录') }}</button>
        </div>
      </div>
    </div>

    <h2>{{ i18nStore.t('隐私模式') }}</h2>
    <div class="panel">
      <div class="row">
        <div style="max-width: 620px">
          <b class="row-t">{{ i18nStore.t('隐私模式') }}</b>
          <div class="dim">
            {{ i18nStore.t('本地运行时，所有任务、产物与会话都只存在本机 SQLite 中，不会上传到任何服务器。（云端同步与隐私开关尚未接入）') }}
          </div>
        </div>
        <span class="switch-off" data-coming aria-disabled="true" :title="i18nStore.t('隐私开关尚未接入')" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.pg h1 { font-size: 22px; }
.sub { color: var(--ac-text-muted); font-size: 12.5px; margin-top: 6px; }
h2 { font-size: 14px; margin: 24px 0 10px; }
.panel { background: var(--ac-panel); border: 1px solid var(--ac-border); border-radius: 12px; padding: 4px 18px; }
.row { display: flex; align-items: center; justify-content: space-between; padding: 14px 0; gap: 20px; }
.row + .row { border-top: 1px solid var(--ac-border); }
.row-t { font-size: 13px; }
.dim { color: var(--ac-text-muted); font-size: 11.5px; margin-top: 4px; line-height: 1.6; }
.avatar {
  width: 36px; height: 36px; border-radius: 8px;
  background: linear-gradient(135deg, var(--ac-avatar-1), var(--ac-avatar-2)); color: var(--ac-white); font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.name { font-size: 13px; }
.name i { font-style: normal; color: var(--ac-green); margin-left: 6px; cursor: pointer; }
.edit-row { display: flex; gap: 8px; align-items: center; }
.name-input {
  height: 28px; width: 160px; border-radius: 7px; border: 1px solid var(--ac-surface);
  background: var(--ac-surface-2); color: var(--ac-text); padding: 0 10px; font-size: 12.5px;
}
.name-input.wide { width: 280px; }
.btn-a { height: 28px; padding: 0 14px; border-radius: 7px; background: var(--ac-surface); color: var(--ac-text); font-size: 12px; }
.btn-a:hover:not(:disabled) { background: var(--ac-hover-2); }
.btn-a:disabled { opacity: 0.5; cursor: default; }
.btn-a.primary { background: var(--ac-blue); color: var(--ac-white); }
.btn-a.danger:hover:not(:disabled) { background: var(--ac-danger-bg); color: var(--ac-error); }
.notice { margin-top: 14px; padding: 10px 14px; border-radius: 8px; background: var(--ac-surface-2); color: var(--ac-text-muted); font-size: 12px; }
.notice.err { background: var(--ac-error-bg); color: var(--ac-error); }
.switch-off { width: 36px; height: 20px; border-radius: 999px; background: var(--ac-surface); position: relative; flex: none; }
.switch-off::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: var(--ac-text-muted);
}
</style>
