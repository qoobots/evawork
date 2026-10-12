/**
 * 通用异步数据（T-050 基建）：统一加载 / 错误 / 重试三态。
 *
 * 关键细节：**响应竞态保护**。快速切换筛选条件时，先发出的请求可能后返回，
 * 若不丢弃过期响应，界面会被旧数据覆盖（表现为"筛选结果和条件对不上"）。
 */
import { ref, watch, type Ref } from 'vue';

export interface AsyncResult<T> {
  data: Ref<T | null>;
  loading: Ref<boolean>;
  error: Ref<string>;
  run: () => Promise<void>;
  reload: () => Promise<void>;
}

export function useAsyncData<T>(
  loader: () => Promise<T>,
  sources: Ref<unknown>[] = [],
): AsyncResult<T> {
  const data = ref<T | null>(null) as Ref<T | null>;
  const loading = ref(false);
  const error = ref('');
  let seq = 0;

  async function run(): Promise<void> {
    loading.value = true;
    error.value = '';
    const mine = ++seq;
    try {
      const result = await loader();
      if (mine === seq) data.value = result; // 只接受最新一次请求的结果
    } catch (e) {
      if (mine === seq) error.value = (e as Error).message;
    } finally {
      if (mine === seq) loading.value = false;
    }
  }

  if (sources.length) {
    watch(sources, () => void run(), { deep: true });
  }

  return { data, loading, error, run, reload: run };
}
