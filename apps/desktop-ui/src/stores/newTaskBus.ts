import { ref } from 'vue';

/** 侧栏点「新建任务」的信号：每次点击 +1，任务页据此清空当前会话并聚焦输入框。 */
export const newTaskSeq = ref(0);

/**
 * 为什么它是"信号"而不是 ui store 里的状态：
 * 同一路由再点一次不会产生导航（`/` → `/`），router-link 什么都不做，
 * 于是必须有个地方显式喊一嗓子；而这个值本身没有"当前是否在新任务页"的含义，
 * 做成 store 状态反而会被读错。
 */
export function requestNewTask(): void {
  newTaskSeq.value += 1;
}
