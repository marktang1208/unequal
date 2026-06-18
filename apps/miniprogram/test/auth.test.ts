/**
 * M6.2 miniprogram auth (ensureJwt + getJwtToken) 测试。
 *
 * CP-6 P3.9：ensureJwt 改走 wx.cloud.callFunction（不是 HTTP gateway）。
 * Mock 走 __setCloudCallImpl。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureJwt, getJwtToken } from "../lib/auth.js";
import { __setJwtStorageImpl } from "../lib/chat-storage.js";
import { __setCloudCallImpl, type CloudCallFn } from "../lib/cloud-call.js";

// Mock wx 全局（miniflare/node 没 wx）
(globalThis as { wx?: unknown }).wx = {
  login: vi.fn(),
  request: vi.fn(),
  cloud: { callFunction: vi.fn() },
  getStorageSync: vi.fn(),
  setStorageSync: vi.fn(),
  removeStorageSync: vi.fn(),
};
// @ts-expect-error 测试桩类型
const mockWx = (globalThis as {
  wx: { login: ReturnType<typeof vi.fn> };
}).wx;

let storage: Record<string, string> = {};
let mockCloudCall: ReturnType<typeof vi.fn>;
beforeEach(() => {
  storage = {};
  __setJwtStorageImpl(
    (key) => storage[key] ?? "",
    (key, value) => { storage[key] = value; },
  );
  vi.clearAllMocks();
  mockWx.login.mockReset();
  // 重置 cloudCall mock
  __setCloudCallImpl(null);
  mockCloudCall = vi.fn();
  __setCloudCallImpl(mockCloudCall as unknown as CloudCallFn);
});

describe("miniprogram ensureJwt (mock wx + mock cloudCall)", () => {
  it("冷启动无 jwt → 调 wx.login + cloudCall + 存 storage + 返 jwt", async () => {
    mockWx.login.mockImplementation(({ success }: any) => {
      success({ code: "test_code_081H1z" });
    });
    mockCloudCall.mockResolvedValue({
      statusCode: 200,
      body: { jwt: "eyJ.jwt.token", user_id: "01HUSER", is_new_user: true },
    });

    const token = await ensureJwt();
    expect(token).toBe("eyJ.jwt.token");
    expect(mockWx.login).toHaveBeenCalledTimes(1);
    expect(mockCloudCall).toHaveBeenCalledTimes(1);
    expect(mockCloudCall).toHaveBeenCalledWith({
      path: "/api-auth-wx-login",
      httpMethod: "POST",
      body: { code: "test_code_081H1z" },
    });
    // 写 storage
    expect(getJwtToken()).toBe("eyJ.jwt.token");
  });

  it("已存 jwt → 直接返（不调 wx.login / cloudCall）", async () => {
    storage["unequal:jwt"] = "existing_jwt_token";
    const token = await ensureJwt();
    expect(token).toBe("existing_jwt_token");
    expect(mockWx.login).not.toHaveBeenCalled();
    expect(mockCloudCall).not.toHaveBeenCalled();
  });

  it("500 → 抛 Error 含 status + code（让 caller 决定 fallback）", async () => {
    mockWx.login.mockImplementation(({ success }: any) => {
      success({ code: "expired_code" });
    });
    mockCloudCall.mockResolvedValue({
      statusCode: 500,
      body: { error: "INTERNAL_ERROR" },
    });

    await expect(ensureJwt()).rejects.toThrow(/\/api-auth-wx-login 500.*INTERNAL_ERROR/);
  });

  it("wx.login 抛错 → propagate（app.ts onLaunch 失败不 throw 阻塞启动）", async () => {
    mockWx.login.mockImplementation(({ fail }: any) => {
      fail({ errMsg: "wx.login fail" });
    });
    await expect(ensureJwt()).rejects.toThrow(/wx.login/);
  });

  it("cloudCall 5xx → ensureJwt 抛 Error 且不写 storage（避免返 500 token）", async () => {
    mockWx.login.mockImplementation(({ success }: any) => {
      success({ code: "valid_code_but_server_down" });
    });
    mockCloudCall.mockResolvedValue({
      statusCode: 500,
      body: { error: "internal", detail: "boom" },
    });

    await expect(ensureJwt()).rejects.toThrow(/\/api-auth-wx-login 500.*internal/);
    expect(storage["unequal:jwt"]).toBeUndefined();
  });
});