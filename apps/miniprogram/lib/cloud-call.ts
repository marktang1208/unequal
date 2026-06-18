/**
 * CP-6 P3.9：miniprogram → api-router 走 wx.cloud.callFunction
 *
 * 背景：wx-login handler 读 event.userInfo.openId；该字段只通过 CloudBase
 * callFunction 由 gateway 自动注入，HTTP trigger 拿不到。所以 wx-login
 * 必须走 callFunction；其他 endpoint 暂保留 HTTP（admin scope 已 smoke 通）。
 *
 * 设计：
 * - 默认 impl：wx.cloud.callFunction({ name: "api-router", data: {httpMethod, path, headers, queryString, body} })
 * - 测试桩：__setCloudCallImpl(mock) 注入 mock 后所有 cloudCall() 走 mock
 * - 永远不抛同步错；fail 走 reject（caller 决定 mock-first fallback）
 */

export interface CloudCallRequest {
  path: string;
  httpMethod: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string>;
  jwt?: string;
}

export interface CloudCallResult {
  statusCode: number;
  body: unknown;
}

export type CloudCallFn = (req: CloudCallRequest) => Promise<CloudCallResult>;

let impl: CloudCallFn | null = null;

/** 测试桩注入；传 null 清空恢复默认 */
export function __setCloudCallImpl(next: CloudCallFn | null): void {
  impl = next;
}

export function cloudCall(req: CloudCallRequest): Promise<CloudCallResult> {
  if (impl) return impl(req);
  // @ts-expect-error wx 全局类型 mock-first 缺失
  if (typeof wx === "undefined" || typeof wx.cloud?.callFunction !== "function") {
    return Promise.reject(
      new Error("[cloudCall] wx.cloud.callFunction unavailable; set impl via __setCloudCallImpl"),
    );
  }
  return new Promise((resolve, reject) => {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.cloud.callFunction({
      name: "api-router",
      data: {
        httpMethod: req.httpMethod,
        path: req.path,
        headers: {
          "content-type": "application/json",
          ...(req.jwt ? { authorization: `Bearer ${req.jwt}` } : {}),
        },
        queryString: req.query ?? {},
        body: req.body !== undefined ? JSON.stringify(req.body) : null,
        isBase64Encoded: false,
      },
      success: (res: { result?: { statusCode?: number; body?: string } }) => {
        const r = res.result ?? {};
        let body: unknown;
        try {
          body = JSON.parse(r.body ?? "");
        } catch {
          body = r.body;
        }
        resolve({ statusCode: r.statusCode ?? 0, body });
      },
      fail: (err: { errMsg?: string }) =>
        reject(new Error(err.errMsg ?? "wx.cloud.callFunction failed")),
    });
  });
}