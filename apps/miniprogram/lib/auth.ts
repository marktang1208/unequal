/**
 * CP-7-A miniprogram jwt auth（spec §6.2 / plan Task 2）。
 *
 * ensureJwt 走 cloudCall（callFunction 路径，CloudBase 自动注入 userInfo.openId）。
 * 失败 throw ApiError 让 caller 处理（app.ts onLaunch 不 catch 阻塞启动）。
 *
 * 旧 _baseUrl / fetchImpl 参数已删（callFunction 不需要；spec §6.2 决策）。
 */
import { loadJwt, saveJwt } from "./chat-storage.js";
import { cloudCall } from "./cloud-call.js";

/** 读 jwt。无 → 返 null（caller 决定是否重 login） */
export function getJwtToken(): string | null {
  return loadJwt();
}

/**
 * 确保本地有 jwt。无 → 调 wx.login 拿 code + 换 jwt + 写 storage。
 * 有 → 直接返（不重 login；M6.2 暂不验签，依赖 401 时 cloudCall 透明 refresh）。
 *
 * 失败 throw ApiError 让 caller 处理（app.ts onLaunch catch 后 warn）。
 */
export async function ensureJwt(): Promise<string> {
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

  // 2. 调 cloudCall（callFunction 路径，CloudBase 自动注入 userInfo.openid）
  const data = await cloudCall<{ jwt: string }>({
    path: "/api-auth-wx-login",
    httpMethod: "POST",
    body: { code: loginRes.code },  // 调试用；handler 不读 body（只读 userInfo.openId）
  });

  saveJwt(data.jwt);
  return data.jwt;
}