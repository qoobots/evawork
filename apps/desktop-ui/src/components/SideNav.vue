<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UIcon from '@/components/UIcon.vue';
import UserMenu from '@/components/UserMenu.vue';
import { NAV_MAX, NAV_MIN, useUiStore, type UiTask } from '@/stores/ui';
import { useI18nStore } from '@/stores/i18n';
import { requestNewTask } from '@/stores/newTaskBus';
import { onBackend } from '@/api/backend';

const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const i18n = useI18nStore();

/* T-052：导航文案走 i18n 键；`key` 保持不变，只有显示跟着语言走 */
const navs = [
  { icon: 'plus-square', key: 'nav.new_task', to: '/' },
  { icon: 'bag', key: 'nav.market', to: '/market' },
  { icon: 'grid', key: 'nav.templates', to: '/templates' },
  { icon: 'palette', key: 'nav.design', to: '/design' },
  { icon: 'clock', key: 'nav.automation', to: '/automation' },
  { icon: 'chat', key: 'nav.office', to: '/office' },
  { icon: 'folder', key: 'nav.files', to: '/files' },
];

/**
 * 「新建任务」是唯一需要"原地再点一次也生效"的入口：
 * 已经停在新建页时 `/` → `/` 不产生导航，router-link 什么都不做，
 * 用户会以为按钮坏了（得先切到别的页再切回来）。发一次信号让任务页主动清空。
 */
function onNavClick(to: string) {
  if (to === '/') requestNewTask();
}

/* ============ T-115：侧栏任务区（按工作区分组 / 重命名 / 删除 / 批量删除） ============ */

/**
 * 进页面先拉一次；后端地址比首帧晚到（main.js 不等后端就开窗），
 * 所以地址到了再拉一次——否则首帧那次必然失败，侧栏永远是空的。
 */
onMounted(() => {
  void ui.refreshTasks();
});
onBackend(() => {
  void ui.refreshTasks();
});

const manageMode = ref(false);
const selected = ref<string[]>([]);
const editingId = ref('');
const editingTitle = ref('');
const menuFor = ref('');
const menuPos = ref({ top: 0, left: 0 });
const confirmDelete = ref('');
const bulkConfirm = ref(false);
const notice = ref('');
const busy = ref(false);

const menuStyle = computed(() => ({ top: `${menuPos.value.top}px`, left: `${menuPos.value.left}px` }));
/* 全选只对「看得见的」任务生效（`ui.visibleTasks` 已排除折叠分组）——
   把「默认」折起来再全选，不该把几十条看不见的任务一起送进"删除选中"。 */
const allSelected = computed(() => {
  const vis = ui.visibleTasks;
  return vis.length > 0 && vis.every((t) => selected.value.includes(t.id));
});

/** 正在执行的任务：界面上标个点。它们删不掉（后端会拒），先看见就不会白点。 */
const RUNNING = new Set(['planning', 'running']);
const isRunning = (t: UiTask) => RUNNING.has(String(t.state || ''));

function flash(msg: string) {
  notice.value = msg;
  if (!msg) return;
  window.setTimeout(() => {
    if (notice.value === msg) notice.value = '';
  }, 4000);
}

function toggleManage() {
  manageMode.value = !manageMode.value;
  selected.value = [];
  bulkConfirm.value = false;
  confirmDelete.value = '';
  menuFor.value = '';
  notice.value = '';
}

function toggleSelect(id: string) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((x) => x !== id)
    : [...selected.value, id];
}

/** 该分组当前是否被折叠（T-117）。 */
const isCollapsed = (key: string) => ui.collapsedGroups.includes(key);

/**
 * T-117：点分组标题折叠 / 展开该工作区。
 *
 * 折叠时顺手撤掉该组的勾选：任务被折叠后看不见了，却还留在"待删除"里，
 * 那就是一次看不见的批量删除。
 */
function toggleGroup(key: string) {
  ui.toggleGroupCollapse(key);
  if (!ui.collapsedGroups.includes(key)) return;
  const hidden = new Set(ui.taskGroups.find((g) => g.key === key)?.tasks.map((t) => t.id) ?? []);
  selected.value = selected.value.filter((id) => !hidden.has(id));
}

function toggleAll() {
  selected.value = allSelected.value ? [] : ui.visibleTasks.map((t) => t.id);
}

/* ---------- T-118：拖侧栏右边缘调宽度 ----------
   热区只有 5px，但用 setPointerCapture 把后续事件锁在它自己身上：
   指针拖到正文上方也不会断，松手才结束（窗口级监听的老写法要靠 document 兜底）。 */
const dragging = ref(false);
let dragFrom = { x: 0, w: 0 };

function onResizeStart(e: PointerEvent) {
  dragging.value = true;
  dragFrom = { x: e.clientX, w: ui.navWidth };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  // 不拦下来的话，拖到文字上会顺手拉出一片蓝色选区
  e.preventDefault();
}

function onResizeMove(e: PointerEvent) {
  if (!dragging.value) return;
  ui.setNavWidth(dragFrom.w + (e.clientX - dragFrom.x));
}

function onResizeEnd(e: PointerEvent) {
  if (!dragging.value) return;
  dragging.value = false;
  const el = e.currentTarget as HTMLElement;
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
}

/** 键盘调宽：←/→ 每次 16px，按住 Shift 48px（只能一格一格点太费手）。 */
function onResizeKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const step = (e.shiftKey ? 48 : 16) * (e.key === 'ArrowRight' ? 1 : -1);
  ui.setNavWidth(ui.navWidth + step);
}

/* 拖动中指针会离开侧栏飘到正文上方，光标就跟着正文变了（拖到段落上还会变成文本光标）。
   用 body 上的标记统一压住，松手即撤。 */
watch(dragging, (on) => document.body.classList.toggle('col-resizing', on));

/** 管理模式下点条目 = 勾选/取消，不跳转——否则勾一下就被带走了，没法多选。 */
function onTaskClick(e: MouseEvent, id: string) {
  if (!manageMode.value) return;
  e.preventDefault();
  toggleSelect(id);
}

/**
 * 行内重命名。不用 `window.prompt`：Electron 里它直接不可用（返回 null），
 * 点「重命名」会像坏了一样毫无反应。
 */
function startRename(id: string) {
  const t = ui.tasks.find((x) => x.id === id);
  if (!t) return;
  menuFor.value = '';
  confirmDelete.value = '';
  editingId.value = id;
  editingTitle.value = t.title;
  void nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.rename-input');
    el?.focus();
    el?.select();
  });
}

async function commitRename() {
  const id = editingId.value;
  if (!id) return;
  const before = ui.tasks.find((x) => x.id === id)?.title || '';
  const title = editingTitle.value.trim();
  editingId.value = '';
  if (!title || title === before) return; // 空标题与"没改"都不发请求，也别把标题改没
  try {
    await ui.retitleTask(id, title);
  } catch (e) {
    flash(e instanceof Error ? e.message : String(e));
  }
}

function cancelRename() {
  editingId.value = '';
}

function openMenu(e: MouseEvent, id: string) {
  if (menuFor.value === id) {
    closeMenu();
    return;
  }
  menuFor.value = id;
  confirmDelete.value = '';
  // 菜单跟着点的那一行走：侧栏窄，锚在行右侧向左展开才不会跑出窗口
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menuPos.value = {
    top: Math.min(r.bottom + 4, Math.max(12, window.innerHeight - 170)),
    left: Math.max(8, r.right - 136),
  };
}

function closeMenu() {
  menuFor.value = '';
  confirmDelete.value = '';
}

/** 删掉的若是当前正在看的那条任务，得离开它的路由——否则停在一个已不存在的任务页。 */
function afterDelete(gone: string[]) {
  if (gone.includes(String(route.params.id || ''))) void router.push('/');
}

async function doDelete(id: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await ui.removeTasks([id]);
    closeMenu();
    if (res.skipped.length) flash(i18n.t('tasks.running_kept'));
    afterDelete(res.deleted);
  } catch (e) {
    flash(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

async function removeSelected() {
  if (busy.value || !selected.value.length) return;
  busy.value = true;
  try {
    const res = await ui.removeTasks([...selected.value]);
    // 没删成的（正在执行）要留在选中态里，用户才知道"这几条还在"
    selected.value = selected.value.filter((x) => !res.deleted.includes(x));
    bulkConfirm.value = false;
    if (res.skipped.length) flash(i18n.t('tasks.running_kept'));
    afterDelete(res.deleted);
  } catch (e) {
    flash(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <aside class="sidenav" :style="{ width: `${ui.navWidth}px` }">
    <!-- 左上角品牌区（T-142）。这里原本是 Work / Code / Design 三档模式切换：
         当初设想一套壳同时兼容工作 / 编码 / 设计三种完全不同的界面，现在这套设想
         不做了，于是那一行直接换成「图标 + 产品名」。
         注意它同时是窗口栏的左半段（无边框窗口靠这一条拖窗口），drag 属性不能丢。 -->
    <div class="brand">
      <span class="brand-mark"><UIcon name="sparkle" :size="12" /></span>
      <span class="brand-name">EvaWork</span>
    </div>

    <nav class="nav-list">
      <router-link
        v-for="n in navs"
        :key="n.to"
        :to="n.to"
        class="nav-item"
        :class="{ active: route.path === n.to }"
        @click="onNavClick(n.to)"
      >
        <UIcon :name="n.icon" :size="15" /><span>{{ i18n.t(n.key) }}</span>
      </router-link>
    </nav>

    <!-- T-115：任务区吃掉剩余高度、内部滚动——它再长也顶不掉左下角的账号 -->
    <div class="tasks-block">
      <div class="tasks-head">
        <span class="tasks-title">{{ i18n.t('nav.tasks') }}</span>
        <span v-if="ui.tasks.length" class="tasks-count">{{ ui.tasks.length }}</span>
        <button
          type="button"
          class="head-btn"
          :class="{ on: manageMode }"
          :title="i18n.t(manageMode ? 'tasks.manage_done' : 'tasks.manage')"
          @click="toggleManage"
        >
          <UIcon :name="manageMode ? 'check' : 'sliders'" :size="13" />
        </button>
      </div>

      <div v-if="manageMode" class="manage-bar">
        <label class="pick-all">
          <input type="checkbox" :checked="allSelected" @change="toggleAll" />
          <span>{{ i18n.t('tasks.select_all') }}</span>
        </label>
        <template v-if="selected.length">
          <button
            v-if="!bulkConfirm"
            type="button"
            class="danger-btn"
            @click="bulkConfirm = true"
          >{{ i18n.t('tasks.delete_selected') }} ({{ selected.length }})</button>
          <button
            v-else
            type="button"
            class="danger-btn solid"
            :disabled="busy"
            @click="removeSelected"
          >{{ i18n.t('tasks.confirm_delete') }} ({{ selected.length }})</button>
        </template>
      </div>

      <div class="tasks-scroll">
        <p v-if="!ui.tasks.length" class="tasks-empty">
          {{ ui.tasksError ? ui.tasksError : i18n.t('tasks.empty') }}
        </p>

        <div v-for="g in ui.taskGroups" :key="g.key" class="task-group">
          <!-- 分组头：按工作区划分（组名 = 工作区目录名，老任务归「默认」）。
               T-117：整行可点，折起这一组——「默认」攒到几十条时，先收起比先滚动有用。 -->
          <button
            type="button"
            class="group-head"
            :class="{ folded: isCollapsed(g.key) }"
            :title="i18n.t(isCollapsed(g.key) ? 'tasks.unfold' : 'tasks.fold')"
            @click="toggleGroup(g.key)"
          >
            <UIcon
              class="group-caret"
              :name="isCollapsed(g.key) ? 'chevron-right' : 'chevron-down'"
              :size="12"
            />
            <UIcon name="folder" :size="12" />
            <span class="group-name">{{ g.label || i18n.t('tasks.default_group') }}</span>
            <span class="group-n">{{ g.tasks.length }}</span>
          </button>

          <!-- 折叠时把这些行真的从 DOM 里拿掉，而不是盖一层 ---->
          <template v-if="!isCollapsed(g.key)">

          <div
            v-for="t in g.tasks"
            :key="t.id"
            class="task-row"
            :class="{ active: route.params.id === t.id, picked: selected.includes(t.id) }"
          >
            <!-- 勾选框用**独立** v-if：它不该参与下面"输入框 / 标题"的互斥链。
                 放进 v-if/v-else-if 链里，管理模式一开就会把标题整条换掉——
                 用户勾选时看不见自己勾的是哪条任务。 -->
            <input
              v-if="manageMode"
              class="pick"
              type="checkbox"
              :checked="selected.includes(t.id)"
              @change="toggleSelect(t.id)"
            />
            <input
              v-if="editingId === t.id"
              v-model="editingTitle"
              class="rename-input"
              maxlength="120"
              @keyup.enter="commitRename"
              @keyup.esc="cancelRename"
              @blur="commitRename"
            />
            <router-link
              v-else
              class="task-item"
              :to="`/task/${t.id}`"
              @click="onTaskClick($event, t.id)"
            >
              <UIcon name="chat" :size="13" />
              <span v-if="isRunning(t)" class="run-dot" :title="i18n.t('tasks.deleting')" />
              <span class="task-name">{{ t.title }}</span>
            </router-link>
            <button
              v-if="!manageMode && editingId !== t.id"
              type="button"
              class="row-more"
              :title="i18n.t('tasks.more')"
              @click.stop="openMenu($event, t.id)"
            >
              <UIcon name="dots" :size="13" />
            </button>
          </div>
          </template>
        </div>
      </div>

      <p v-if="notice" class="tasks-notice">{{ notice }}</p>
    </div>

    <UserMenu />

    <!-- 行内操作菜单（重命名 / 删除，删除带二次确认） -->
    <div v-if="menuFor" class="menu-mask" @click="closeMenu" />
    <div v-if="menuFor" class="row-menu" :style="menuStyle" @click.stop>
      <button type="button" class="menu-item" @click="startRename(menuFor)">
        <UIcon name="pen" :size="12" /><span>{{ i18n.t('tasks.rename') }}</span>
      </button>
      <button
        v-if="confirmDelete !== menuFor"
        type="button"
        class="menu-item danger"
        @click="confirmDelete = menuFor"
      >
        <UIcon name="trash" :size="12" /><span>{{ i18n.t('tasks.delete') }}</span>
      </button>
      <button
        v-else
        type="button"
        class="menu-item solid"
        :disabled="busy"
        @click="doDelete(menuFor)"
      >
        <UIcon name="trash" :size="12" /><span>{{ i18n.t('tasks.confirm_delete') }}</span>
      </button>
    </div>

    <!-- T-118：拖这条边调侧栏宽度。tabindex 化的 separator 就是 ARIA 的 window splitter，
         所以它才允许带 aria-valuenow；键盘用户 Tab 过来用 ←/→ 调。 -->
    <div
      class="nav-resizer"
      :class="{ dragging }"
      role="separator"
      aria-orientation="vertical"
      :aria-label="i18n.t('nav.resize')"
      :aria-valuenow="ui.navWidth"
      :aria-valuemin="NAV_MIN"
      :aria-valuemax="NAV_MAX"
      :title="i18n.t('nav.resize')"
      tabindex="0"
      @pointerdown="onResizeStart"
      @pointermove="onResizeMove"
      @pointerup="onResizeEnd"
      @pointercancel="onResizeEnd"
      @keydown="onResizeKey"
    />
  </aside>
</template>

<style scoped>
.sidenav {
  /* T-118：宽度由内联样式给（唯一真相源是 store 的 NAV_DEFAULT）；
     position: relative 是给贴边拖拽热区做定位基准 */
  position: relative;
  flex: none; height: 100%;
  display: flex; flex-direction: column;
  /* T-120：顶部不留 padding——上面那条模式行自己就是窗口栏的一部分（原生标题栏已去掉） */
  padding: 0 8px 8px;
  background: var(--bg);
  /* T-115：整栏不滚动，滚动只发生在任务列表内部 */
  overflow: hidden;
}
/**
 * T-118：拖拽调宽的热区。
 * 贴右边缘内侧，不是 `right: -3px` 探到栏外——.sidenav 自己是 overflow:hidden，
 * 探出去的部分会被裁掉：看着在，其实点不到。
 */
.nav-resizer {
  position: absolute; top: 0; right: 0; bottom: 0; width: 5px;
  cursor: col-resize; touch-action: none; z-index: 5;
  /* T-120：把它从窗口栏拖拽带里"挖"出来——不然在这条边上往下按是拖窗口，不是调宽度 */
  -webkit-app-region: no-drag;
}
/* 平时不画线（不改变现状观感），hover / 拖动时才亮出来 */
.nav-resizer::after {
  content: ''; position: absolute; top: 0; right: 0; bottom: 0; width: 2px;
  background: transparent; transition: background 0.15s ease;
}
.nav-resizer:hover::after, .nav-resizer.dragging::after { background: var(--violet); }
/* T-120/T-142：这一条就是窗口栏的左半段——原生标题栏去掉后，它顶上窗口第一行。
   min-height 取窗口栏高度，跟右上角的系统窗口按钮同一水平线（--titlebar-h 归零时
   自动退回内容高度，见 styles/app.css）；空白处可拖动窗口。 */
.brand {
  display: flex; align-items: center; gap: 7px; flex: none;
  min-height: var(--titlebar-h); margin-bottom: 10px; padding: 0 4px;
  -webkit-app-region: drag;
}
/**
 * 品牌图标：唯一一处写死色值的地方——它是产品标识，不该跟着主题变浅变深
 * （暗色下用 var(--violet) 会淡成 #8b86f0，白图标压上去就糊了）。
 * 白描边图标在这两个蓝紫底的对比度都在 4.5 以上，浅色/暗色/控制台三套主题通用。
 */
.brand-mark {
  width: 20px; height: 20px; flex: none; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  color: #fff; background: linear-gradient(135deg, #6d5cf6, #2f6bff);
}
.brand-name { font-size: 13px; font-weight: 600; color: var(--t1); }
.nav-list { display: flex; flex-direction: column; gap: 1px; flex: none; }
.nav-item {
  display: flex; align-items: center; gap: 9px;
  padding: 7px 9px; border-radius: 8px; font-size: 13px; color: var(--t1);
}
.nav-item:hover { background: var(--hover); }
.nav-item.active { background: var(--active-bg); font-weight: 500; }
.nav-item svg { color: var(--t2); }

/**
 * T-115：任务区 flex:1 + 内部滚动。
 * 以前是 `margin-top: auto` 让任务块顶到底部——任务一多，整块高度超过侧栏，
 * 就顺着 flex 把下面的账号条挤出屏幕（账号"消失"就是这么来的）。
 */
.tasks-block {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  margin-top: 10px; padding: 0 4px;
}
.tasks-head { flex: none; display: flex; align-items: center; gap: 6px; padding: 2px 5px 6px; }
.tasks-title { font-size: 12px; color: var(--t2); }
.tasks-count { font-size: 11px; color: var(--t3); }
.head-btn {
  margin-left: auto; width: 22px; height: 22px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center; color: var(--t3);
}
.head-btn:hover { background: var(--hover); color: var(--t1); }
.head-btn.on { background: var(--active-bg); color: var(--t1); }

.manage-bar { flex: none; display: flex; align-items: center; gap: 6px; padding: 0 5px 6px; }
.pick-all { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--t2); cursor: pointer; }
.danger-btn {
  margin-left: auto; padding: 3px 8px; border-radius: 6px;
  font-size: 11.5px; color: var(--err); border: 1px solid var(--line);
}
.danger-btn:hover { background: var(--hover); }
.danger-btn.solid { color: #fff; background: var(--err); border-color: var(--err); }
.danger-btn:disabled { opacity: 0.6; cursor: default; }

.tasks-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.tasks-empty { padding: 8px 9px; font-size: 12px; color: var(--t3); }

.task-group + .task-group { margin-top: 6px; }
/* T-117：分组头是按钮（全局 button 已重置，且带键盘焦点环），整行可点 */
.group-head {
  width: 100%; display: flex; align-items: center; gap: 6px;
  padding: 4px 6px; border-radius: 6px; text-align: left;
  font-size: 11.5px; color: var(--t3);
}
.group-head:hover { background: var(--hover); color: var(--t1); }
.group-head svg { flex: none; }
/* 折叠后组名亮一点、计数留灰：一眼看出"这组收着 84 条" */
.group-head.folded .group-name { color: var(--t2); }
.group-caret { margin-left: -2px; }
.group-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-n { margin-left: auto; }

.task-row { position: relative; display: flex; align-items: center; border-radius: 7px; }
.task-row:hover { background: var(--hover); }
.task-row.active { background: var(--active-bg); }
.task-item {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px;
  padding: 6px 9px; border-radius: 7px; font-size: 12.5px; color: var(--t1);
}
.task-item svg { color: var(--t3); flex: none; }
.task-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--violet); flex: none; }
.pick { margin-left: 7px; flex: none; }
.row-more {
  width: 22px; height: 22px; margin-right: 4px; border-radius: 6px; flex: none;
  display: flex; align-items: center; justify-content: center; color: var(--t3);
  opacity: 0;
}
.task-row:hover .row-more, .task-row.active .row-more { opacity: 1; }
.row-more:hover { background: var(--active-bg); color: var(--t1); }
.rename-input {
  flex: 1; min-width: 0; margin: 3px 6px; padding: 4px 6px;
  border: 1px solid var(--line); border-radius: 6px;
  background: var(--panel); color: var(--t1); font-size: 12.5px;
}
.tasks-notice { flex: none; padding: 4px 8px 0; font-size: 11px; color: var(--err); }

.menu-mask { position: fixed; inset: 0; z-index: 40; }
.row-menu {
  position: fixed; z-index: 41; width: 132px; padding: 4px;
  background: var(--panel); border-radius: 10px; box-shadow: var(--shadow);
}
.menu-item {
  width: 100%; display: flex; align-items: center; gap: 7px;
  padding: 6px 8px; border-radius: 7px; font-size: 12.5px; color: var(--t1);
}
.menu-item:hover { background: var(--line-2); }
.menu-item.danger { color: var(--err); }
.menu-item.solid { color: #fff; background: var(--err); }
.menu-item.solid:disabled { opacity: 0.6; cursor: default; }
</style>
