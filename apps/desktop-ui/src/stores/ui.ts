import { defineStore } from 'pinia';
import {
  deleteTasks as deleteTasksApi,
  fetchTaskList,
  renameTask as renameTaskApi,
  type DeleteTasksResult,
  type TaskSummary,
} from '@/api/tasks';
import { isTsTaskId } from '@/api/tsChannel';

/**
 * 侧栏任务项。字段对齐后端 `GET /api/tasks?summary=1`，
 * 另外承载"新建任务时还没有真实 id"的临时条目。
 */
export interface UiTask {
  id: string;
  title: string;
  state?: string;
  /** T-115：任务创建时的工作区（侧栏按它分组）；空 = 老任务 → 「默认」组 */
  work_dir?: string;
  created_at?: number;
  updated_at?: number;
  /** 父任务 id（根任务为 null）。24 号方案：父子关系结构化 */
  parent_id?: string | null;
  /** 层级种类：root / subtask / job */
  kind?: string;
  /** 直接子任务（嵌套），仅根任务可能非空 */
  children?: UiTask[];
  /** 子任务数量（仅根任务非零） */
  childCount?: number;
}

/** T-115：任务分组（一个工作区一组）。 */
export interface TaskGroup {
  key: string;
  /** 组名 = 工作区目录名；空串表示「默认」组（显示文案由界面按 i18n 渲染） */
  label: string;
  work_dir: string;
  tasks: UiTask[];
}

/** 侧栏列表落盘：后端连不上时至少还能看见最近用过的任务（内容回显仍走后端）。 */
const TASKS_KEY = 'evawork.tasks';

/**
 * T-117：折叠的分组落盘。
 *
 * 折叠是"这是我暂时不想看的一大堆"（「默认」组动辄几十条），
 * 不落盘的话每次重启又全部摊开，等于没折。
 */
const GROUPS_KEY = 'evawork.collapsed_groups';

function loadCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(arr) ? arr.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * T-118：侧栏宽度可拖，宽度值落盘。
 *
 * 标题被 186px 挤成"De..."的时候用户看不全任务名；反过来也有人想让它更窄、
 * 把地方留给正文。默认值只是默认值，宽度该由用户说话。
 */
const WIDTH_KEY = 'evawork.nav_width';
/** 拖拽的下限 / 上限。下限保住导航文案不被切碎，上限别把正文挤没。 */
export const NAV_MIN = 168;
export const NAV_MAX = 420;
const NAV_DEFAULT = 186;

function loadNavWidth(): number {
  const raw = Number(localStorage.getItem(WIDTH_KEY));
  // 没存过（null → 0）当默认值；存过就钳进当前范围再返回——
  // 用户调过的宽度不该因为范围调整被整段丢掉。
  if (!Number.isFinite(raw) || raw <= 0) return NAV_DEFAULT;
  return Math.round(Math.min(Math.max(raw, NAV_MIN), NAV_MAX));
}

function loadTasks(): UiTask[] {
  try {
    const raw = localStorage.getItem(TASKS_KEY);
    const arr = raw ? (JSON.parse(raw) as UiTask[]) : [];
    if (!Array.isArray(arr)) return [];
    /* 迁移 + 去重：旧版本给本就带 `ts-` 的会话 id 又叠了一层前缀（`ts-ts-…`），
       那是同一条会话被记了两遍的指纹，丢掉；同一 id 也只留一条。 */
    const seen = new Set<string>();
    const out: UiTask[] = [];
    for (const t of arr) {
      if (!t || !t.id || !t.title) continue;
      if (t.id.startsWith('ts-ts-')) continue;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 把后端/API 的 TaskSummary 树递归转换成界面用的 UiTask（含嵌套子任务）。
 * 层级字段（parent_id / kind / children / childCount）一并带过来（24 号方案）。
 */
function toUiTask(t: TaskSummary): UiTask {
  return {
    id: t.id,
    title: t.title,
    state: t.state,
    work_dir: t.work_dir || '',
    created_at: t.created_at,
    updated_at: t.updated_at,
    parent_id: t.parent_id ?? null,
    kind: t.kind || 'root',
    childCount: t.childCount ?? (t.children ? t.children.length : 0),
    children: t.children && t.children.length ? t.children.map(toUiTask) : undefined,
  };
}

/** 全壳状态：模式、任务列表、各浮层开关。 */
export const useUiStore = defineStore('ui', {
  state: () => ({
    /**
     * 任务模式。T-142 起侧栏那一行模式切换换成了品牌标识（产品收敛为单一 EvaWork），
     * 界面里再没有改它的入口，实际恒为 'work'：只作为任务记录里的一个字段传给后端。
     * NewTaskView 里原本的 Design/Code 分支（isDesign/isCode）已删除（T-142）。
     * 留着而不删，是因为已落盘的老任务里可能存着 code/design，字段口径要保持一致。
     */
    mode: 'work' as 'work' | 'code' | 'design',
    tasks: loadTasks() as UiTask[],
    /** T-117：被折叠起来的分组 key（`__default__` 或工作区目录） */
    collapsedGroups: loadCollapsed() as string[],
    /** T-118：侧栏宽度（px），由右侧拖拽热区改 */
    navWidth: loadNavWidth(),
    /** T-115：是否成功从后端拉过一次列表（界面据此区分"真的没有任务"和"没拉到"） */
    tasksLoaded: false,
    tasksError: '',
    /**
     * 24 号方案：子任务默认隐藏（只展示根任务，保持列表干净），
     * 展开某个父任务或关掉本开关才看得到子任务。
     */
    hideSubtasks: true,
    /** 已展开、显示其子任务的父任务 id 集合 */
    expandedParents: [] as string[],
    meMenuOpen: false,
    messagesOpen: false,
  }),
  getters: {
    /**
     * T-117：还看得见的任务（= 未折叠分组的任务）。
     *
     * 管理模式的「全选 / 已选计数」只认它：把「默认」折起来再点全选，
     * 如果连看不见的那几十条一起选上，"删除选中"就会删掉用户根本没看到的任务。
     */
    visibleTasks(): UiTask[] {
      const folded = new Set(this.collapsedGroups);
      return this.taskGroups
        .filter((g) => !folded.has(g.key))
        .flatMap((g) => g.tasks);
    },
    /**
     * T-115：按工作区分组。
     *
     * 组名取工作区目录名（`D:\proj\eva` → `eva`）：完整路径塞进 186px 的侧栏
     * 只会被省略号吃掉，反而看不出是哪组。空工作区（老任务）归「默认」，永远垫底——
     * 它是兜底桶，不该因为"最近有新任务"就挤到真工作区前面。
     */
    taskGroups(state): TaskGroup[] {
      const map = new Map<string, TaskGroup>();
      for (const t of state.tasks) {
        const dir = (t.work_dir || '').replace(/[\\/]+$/, '');
        const key = dir || '__default__';
        let g = map.get(key);
        if (!g) {
          g = {
            key,
            label: dir ? dir.split(/[\\/]/).pop() || dir : '',
            work_dir: dir,
            tasks: [],
          };
          map.set(key, g);
        }
        g.tasks.push(t);
      }
      const groups = [...map.values()];
      for (const g of groups) {
        g.tasks.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      }
      groups.sort((a, b) => {
        if (a.key === '__default__') return 1;
        if (b.key === '__default__') return -1;
        return (b.tasks[0]?.created_at || 0) - (a.tasks[0]?.created_at || 0);
      });
      return groups;
    },
  },
  actions: {
    persist() {
      try {
        localStorage.setItem(TASKS_KEY, JSON.stringify(this.tasks.slice(0, 50)));
      } catch {
        /* 存不进去就算了，不影响主流程 */
      }
    },
    persistCollapsed() {
      try {
        localStorage.setItem(GROUPS_KEY, JSON.stringify(this.collapsedGroups));
      } catch {
        /* 存不进去只影响下次启动是否还折着，不影响本次折叠 */
      }
    },
    /** T-117：折叠 / 展开某个工作区分组。 */
    toggleGroupCollapse(key: string) {
      this.collapsedGroups = this.collapsedGroups.includes(key)
        ? this.collapsedGroups.filter((k) => k !== key)
        : [...this.collapsedGroups, key];
      this.persistCollapsed();
    },
    /** 24 号方案：一键切换"隐藏/显示子任务"。默认隐藏，保持列表干净。 */
    toggleHideSubtasks() {
      this.hideSubtasks = !this.hideSubtasks;
    },
    /** 24 号方案：展开 / 收起某个父任务的子任务列表。 */
    toggleExpandParent(id: string) {
      this.expandedParents = this.expandedParents.includes(id)
        ? this.expandedParents.filter((k) => k !== id)
        : [...this.expandedParents, id];
    },
    /**
     * T-118：设置侧栏宽度（钳到 [NAV_MIN, NAV_MAX] 并落盘）。
     *
     * 拖动时每帧都会调到这里，所以先比一次值再写：宽度已经顶在边界上时不做无谓落盘。
     */
    setNavWidth(px: number) {
      const w = Math.round(Math.min(Math.max(px, NAV_MIN), NAV_MAX));
      if (w === this.navWidth) return;
      this.navWidth = w;
      try {
        localStorage.setItem(WIDTH_KEY, String(w));
      } catch {
        /* 存不进去只影响下次启动的宽度，不影响本次拖动 */
      }
    },
    /** 记一条任务；真实任务 id 在 createTask 之后用 renameTask 绑定。返回临时 id。
     *  workDir：TS 会话这类**不在后端库**的条目没有后端回填工作区，
     *  不在这里带上就会落进垫底的「默认」组，用户以为没记上。 */
    addTask(title: string, id?: string, workDir?: string): string {
      const key = id || `t-${Date.now()}`;
      this.tasks = [
        { id: key, title, work_dir: workDir || '', created_at: Date.now() },
        ...this.tasks.filter((t) => t.id !== key),
      ];
      this.persist();
      return key;
    },
    /** 临时 id → 后端真实任务 id（侧栏点击回显全靠这个 id）。 */
    renameTask(oldId: string, realId: string) {
      const t = this.tasks.find((x) => x.id === oldId);
      if (!t || oldId === realId) return;
      t.id = realId;
      this.persist();
      // T-115：列表真相在后端（含工作区），换绑完顺手拉一次，新任务就带着分组进来了
      void this.refreshTasks();
    },

    /**
     * 刷新侧栏列表。真相源是**会话目录**（`fetchTaskList` → 主进程读落盘会话），
     * 它本身就包含 TS 会话——所以这里必须**按 id 合并**，而不是把本地条目与远端列表前后拼接。
     *
     * 旧写法把本地 `ts-` 条目留在 `pending`、又把远端同一条会话追加一遍，同一会话出现两次，
     * 且每刷新一次就多一条（实测能堆出十几条同名任务）。拉失败时**保留**现有列表
     * （离线可用），只把原因记在 `tasksError` 里——清空等于"一抖，用户的任务就全没了"。
     */
    async refreshTasks() {
      try {
        const remote = await fetchTaskList();
        /* 远端是会话目录的真相源，返回的是**根任务树**（子任务嵌套在 children 里）。
           转换时把层级字段（parent_id / kind / children）一并带上。
           本地条目只保留**临时的**（`t-`，还没换绑真实 id，会话可能尚未落盘）；
           真实的 `ts-` 条目以会话目录为准——不在远端就说明会话文件已被删
           （手动清目录 / 另一窗口删除）。这里必须剔除，否则影子列表里的幽灵条目
           会在每次重启后"复活"——用户删了会话，重启一看任务又全回来了。 */
        const remoteIds = new Set(remote.map((r) => r.id));
        const out: UiTask[] = [];
        /* 本地只留**远端还没有的临时条目**（`t-`）。
           远端已有的 id 一律以远端那条为准：本地与远端同 id 各留一条，
           侧栏就会出现"同一条任务既在工作区分组、又在「默认」组"
           （本地那条没带上 work_dir，于是落进兜底桶）。
           `ts-` 条目不在远端 = 会话文件已被删，一并剔除，
           否则影子列表里的幽灵条目会在每次重启后复活。 */
        for (const t of this.tasks) {
          if (!isTsTaskId(t.id) && !remoteIds.has(t.id)) out.push(t);
        }
        for (const r of remote) out.push(toUiTask(r));
        this.tasks = out;
        this.tasksLoaded = true;
        this.tasksError = '';
        this.persist();
      } catch (e) {
        this.tasksError = e instanceof Error ? e.message : String(e);
      }
    },

    /** T-115：重命名（改标题）。先落后端，成功了再改本地——失败就别改。 */
    async retitleTask(id: string, title: string) {
      const clean = title.trim();
      if (!clean) return;
      /* 真实会话（`ts-`）的改名必须落进会话日志：侧栏刷新以会话目录为准，
         标题取最后一条改名记录。只改本地的话，下一次 refreshTasks 就会把这次改名
         丢掉（那条本地条目已按 id 去重、以远端为准被剔除）。
         临时条目（`t-`，会话还没落盘）不发：发过去会在会话目录里凭空建一个文件。 */
      if (isTsTaskId(id)) await renameTaskApi(id, clean);
      const t = this.tasks.find((x) => x.id === id);
      if (t) t.title = clean;
      this.persist();
    },

    /**
     * 删除若干任务（单条与批量走同一条路）。
     *
     * 任务 id 与会话 id 同值，`deleteTasks` 内部就是逐个 `tsSessionDelete` 删会话文件，
     * 所以**整批一起发**——只在本地剔除的话，下次 `refreshTasks` 会把它从会话目录读回来，
     * 删了等于没删。逐条结果如实返回，没删成的界面要说出来，不能假装删了。
     */
    async removeTasks(ids: string[]): Promise<DeleteTasksResult> {
      const res = await deleteTasksApi(ids);
      /* deleted = 已落盘删掉；missing = 会话本就不在（幽灵条目）。两者都不该再留在侧栏——
         否则下次 `refreshTasks` 又从本地持久化读回来，删了等于没删。
         临时条目（`t-`，还没落成会话文件）没有东西可删，本地剔除即可；
         真正失败（如被占用）的留在 skipped 里，绝不在这里假装删掉。 */
      const gone = new Set<string>([...res.deleted, ...res.missing]);
      const tempIds = ids.filter((id) => !isTsTaskId(id));
      for (const id of tempIds) gone.add(id);
      this.tasks = this.tasks.filter((t) => !gone.has(t.id));
      this.persist();
      // 对界面而言 missing 与 deleted 都是"这条没了"，一并回报，调用方好清理选中态与路由
      return { ...res, deleted: [...res.deleted, ...res.missing, ...tempIds] };
    },
  },
});
