/**
 * 办公助理第三方绑定（T-034）。
 *
 * `oauth_ready=false` 表示这台机器上**真的绑不了**（缺开放平台应用与回调），
 * 界面据此把按钮说明清楚，而不是摆一个点了没反应的"去绑定"。
 *
 * 后端废弃后这里**走契约本来设计好的那条路**：一律 `oauth_ready=false` + 成句原因。
 * 第三方绑定要的是"有个服务端拿着应用凭证完成 OAuth 回调"，本地没有也不该有
 * 那些凭证——所以这不是降级凑合，就是这条契约的真实取值。
 */

export interface Integration {
  id: string;
  name: string;
  icon: string;
  status: string;
  oauth_ready: boolean;
  reason: string;
  needs: string[];
}

/** 没有服务端就没有可绑定的清单，如实给空列表（界面照契约显示"暂不支持"）。 */
export function fetchIntegrations(): Promise<{ items: Integration[] }> {
  return Promise.resolve({ items: [] });
}

export function bindIntegration(id: string): Promise<{ id: string; bound: boolean }> {
  return Promise.reject(
    new Error(`绑定暂不可用：需要服务端持有开放平台应用凭证完成 OAuth 回调（${id}）`),
  );
}
