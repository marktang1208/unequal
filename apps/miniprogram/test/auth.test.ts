/**
 * CP-7-A miniprogram auth (ensureJwt + getJwtToken) 测试。
 *
 * ensureJwt 走 cloudCall（callFunction 路径）。
 * Mock 用 __setCloudCallImpl，wx.login 全局 mock。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ensureJwt, getJwtToken } from "../lib/auth.js";
import { __setJwtStorageImpl } from "../lib/chat-storage.js";
import {
  ApiError,
  __setCloudCallImpl,
  __resetCloudCallImpl,
  __clearInflightRefresh,
  type CloudCallFn,
} from "../lib/cloud-call.js";

// Mock wx 全局（miniflare/node 没 wx；wx.login + removeStorageSync 都需 mock）
(globalThis as { wx?: unknown }).wx = {
  login: vi.fn(),
  removeStorageSync: vi.fn(),
};
// @ts-expect-error 测试桩类型
const mockWx = (globalThis as {
  wx: { login: ReturnType<typeof vi.fn>; removeStorageSync: ReturnType<typeof vi.fn> };
}).wx;

let storage: Record<string, string>;
let mockCloudCall: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __clearInflightRefresh();
  __resetCloudCallImpl();
  storage = {};
  __setJwtStorageImpl(
    (key) => storage[key] ?? "",
    (key, value) => { storage[key] = value; },
  );
  vi.clearAllMocks();
  mockWx.login.mockReset();
  mockWx.removeStorageSync.mockReset();
  mockCloudCall = vi.fn();
  __setCloudCallImpl(mockCloudCall as unknown as CloudCallFn);
});

afterEach(() => {
  vi.restoreAllMocks();
  __clearInflightRefresh();
  __resetCloudCallImpl();
});

describe("miniprogram ensureJwt (mock wx + mock cloudCall)", () => {
  it("冷启动无 jwt → 调 wx.login + cloudCall + 存 storage + 返 jwt", async () => {
    mockWx.login.mockImplementation(({ success }: any) => {
      success({ code: "test_code_081H1z" });
    });
    mockCloudCall.mockResolvedValue({
      statusCode: 200,
      body: { jwt: "eyJ.jwt.token" },
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
    expect(getJwtToken()).toBe("eyJ.jwt.token");
  });

  it("已存 jwt → 直接返（不调 wx.login / cloudCall）", async () => {
    storage["unequal:jwt"] = "existing_jwt_token";
    const token = await ensureJwt();
    expect(token).toBe("existing_jwt_token");
    expect(mockWx.login).not.toHaveBeenCalled();
    expect(mockCloudCall).not.toHaveBeenCalled();
  });

  it("500 → 抛 ApiError(statusCode=500, code) 让 caller 决定 fallback", async () => {
    mockWx.login.mockImplementation(({ success }: any) => {
      success({ code: "expired_code" });
    });
    mockCloudCall.mockRejectedValue(new ApiError(500, "INTERNAL_ERROR", "boom"));

    await expect(ensureJwt()).rejects.toBeInstanceOf(ApiError);
    await expect(ensureJwt()).rejects.toMatchObject({ statusCode: 500, code: "INTERNAL_ERROR" });
  });

  it("wx.login 抛错 → propagate（app.ts onLaunch 失败不 throw 阻塞启动）", async () => {
    mockWx.login.mockImplementation(({ fail }: any) => {
      fail({ errMsg: "wx.login fail" });
    });
    await expect(ensureJwt()).rejects.toThrow(/wx.login/);
    // cloudCall 不应被调（wx.login 先 fail）
    expect(mockCloudCall).not.toHaveBeenCalled();
  });

  it("cloudCall 5xx → ensureJwt 抛 ApiError 且不写 storage（避免返 500 token）", async () => {
    mockWx.login.mockImplementation(({ success }: any) => {
      success({ code: "valid_code_but_server_down" });
    });
    mockCloudCall.mockRejectedValue(new ApiError(500, "internal", "boom"));

    await expect(ensureJwt()).rejects.toMatchObject({ statusCode: 500, code: "internal" });
    expect(storage["unequal:jwt"]).toBeUndefined();
  });
});