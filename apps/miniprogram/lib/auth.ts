// @ts-nocheck wx 全局类型 mock-first 缺失（CP-1 / M3 / M6.1 决策容忍）
import { loadJwt, saveJwt } from "./chat-storage.js";

/** 读 jwt。无 → 返 null（caller 决定是否重 login） */
export function getJwtToken(): string | null {
  return loadJwt();
}

/**
 * 确保本地有 jwt。无 → 调 wx.login 拿 code + /auth/wx-login 换 jwt + 写 storage。
 * 有 → 直接返（不重 login；M6.2 暂不验签，依赖 401 时 caller retry）。
 *
 * 参数 fetchImpl 是测试桩；不传走 wx.request 真路径。
 * 失败 throw Error 让 caller 处理（app.ts onLaunch 不 catch 阻塞启动）。
 */
export async function ensureJwt(
  baseUrl: string = "http://localhost:8787",
  fetchImpl?: typeof fetch,
): Promise<string> {
  const existing = loadJwt();
  if (existing) return existing;

  // 调 wx.login 拿 code（runtime 真路径）
  const loginRes = await new Promise<{ code: string }>((resolve, reject) => {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.login({
      success: (res: { code: string }) => resolve(res),
      fail: (err: { errMsg: string }) => reject(new Error(err.errMsg ?? "wx.login failed")),
    });
  });

  // 调 /auth/wx-login
  // 优先级：fetchImpl > wx.request > globalThis.fetch
  const f = (fetchImpl
    // @ts-expect-error wx 全局类型 mock-first 缺失
    ?? (typeof wx !== "undefined" && typeof wx.request === "function" ? wxRequestAsFetch : fetch)) as typeof fetch;

  const res = await f(`${baseUrl}/auth/wx-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: loginRes.code }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`/auth/wx-login ${res.status}: ${body.error ?? "unknown"}`);
  }

  const data = (await res.json()) as { token: string };
  saveJwt(data.token);
  return data.token;
}

/** 调 wx.request 包装的 fetch 兼容 Promise 接口（与 api.ts 同样的 helper） */
function wxRequestAsFetch(
  input: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.request({
      url: input,
      method: (init.method ?? "GET") as any,
      header: init.headers as any,
      data: init.body as any,
      success: (res: { statusCode: number; data: unknown }) => {
        const bodyText = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
        resolve(
          new Response(bodyText, {
            status: res.statusCode,
            headers: { "content-type": "application/json" },
          }),
        );
      },
      fail: (err: { errMsg: string }) => reject(new Error(err.errMsg ?? "wx.request failed")),
    });
  });
}
