// @ts-nocheck wx 全局类型 mock-first 缺失（CP-1 / M3 / M6.1 决策容忍）
import { loadJwt, saveJwt } from "./chat-storage.js";
import { cloudCall } from "./cloud-call.js";

/** 读 jwt。无 → 返 null（caller 决定是否重 login） */
export function getJwtToken(): string | null {
  return loadJwt();
}

/**
 * 确保本地有 jwt。无 → 调 wx.login 拿 code + 换 jwt + 写 storage。
 * 有 → 直接返（不重 login；M6.2 暂不验签，依赖 401 时 caller retry）。
 *
 * CP-6 P3.9：生产走 wx.cloud.callFunction（api-router 自动注入 userInfo.openid）。
 * 旧 HTTP 路径保留（如果传 fetchImpl）— 给单测 mock 用。
 *
 * 失败 throw Error 让 caller 处理（app.ts onLaunch 不 catch 阻塞启动）。
 */
export async function ensureJwt(
  _baseUrl?: string,        // 旧参数保留；callFunction 不需要 URL
  fetchImpl?: typeof fetch, // 旧参数保留；测试传 mock fetch
): Promise<string> {
  const existing = loadJwt();
  if (existing) return existing;

  // 1. 调 wx.login 拿 code
  const loginRes = await new Promise<{ code: string }>((resolve, reject) => {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.login({
      success: (res: { code: string }) => resolve(res),
      fail: (err: { errMsg: string }) => reject(new Error(err.errMsg ?? "wx.login failed")),
    });
  });

  if (fetchImpl) {
    // 旧 HTTP 路径（单测用）：返 { token }
    const baseUrl = _baseUrl ?? "http://localhost:8787";
    const res = await fetchImpl(`${baseUrl}/auth/wx-login`, {
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

  // 生产：callFunction 路径（CloudBase 自动注入 userInfo.openid）
  const res = await cloudCall({
    path: "/api-auth-wx-login",
    httpMethod: "POST",
    body: { code: loginRes.code },  // 调试用；handler 不读 body（只读 userInfo.openId）
  });

  if (res.statusCode !== 200) {
    const errBody = res.body && typeof res.body === "object"
      ? (res.body as { error?: string }).error
      : undefined;
    throw new Error(`/api-auth-wx-login ${res.statusCode}: ${errBody ?? "unknown"}`);
  }

  const data = res.body as { jwt: string };
  saveJwt(data.jwt);
  return data.jwt;
}