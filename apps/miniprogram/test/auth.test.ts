/**
 * M6.2 miniprogram auth (ensureJwt + getJwtToken) 测试。
 *
 * 4 用例：冷启动拿 jwt / 已存 jwt 直接返 / 401 重 login / wx.login 失败 throw。
 * Mock fetchImpl + Mock wx.login 通过 __setJwtStorageImpl 替换 storage。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureJwt, getJwtToken } from "../lib/auth.js";
import { __setJwtStorageImpl } from "../lib/chat-storage.js";

// Mock wx 全局（miniflare/node 没 wx）
(globalThis as { wx?: unknown }).wx = {
  login: vi.fn(),
  request: vi.fn(),
  getStorageSync: vi.fn(),
  setStorageSync: vi.fn(),
  removeStorageSync: vi.fn(),
};
// @ts-expect-error 测试桩类型
const mockWx = (globalThis as { wx: { login: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> } }).wx;

let storage: Record<string, string> = {};
beforeEach(() => {
  storage = {};
  __setJwtStorageImpl(
    (key) => storage[key] ?? "",
    (key, value) => { storage[key] = value; },
  );
  vi.clearAllMocks();
  mockWx.login.mockReset();
  mockWx.request.mockReset();
});

describe("miniprogram ensureJwt (mock wx + mock fetch)", () => {
  it("冷启动无 jwt → 调 wx.login + /auth/wx-login + 存 storage + 返 token", async () => {
    mockWx.login.mockImplementation(({ success }: any) => {
      success({ code: "test_code_081H1z" });
    });
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://localhost:8787/auth/wx-login");
      expect(JSON.parse(init?.body as string)).toEqual({ code: "test_code_081H1z" });
      return new Response(
        JSON.stringify({ token: "eyJ.jwt.token", user_id: "01HUSER", is_new_user: true, expires_in: 86400 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const token = await ensureJwt("http://localhost:8787", fakeFetch);
    expect(token).toBe("eyJ.jwt.token");
    expect(mockWx.login).toHaveBeenCalledTimes(1);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    // 写 storage
    expect(getJwtToken()).toBe("eyJ.jwt.token");
  });

  it("已存 jwt → 直接返（不调 wx.login / fetch）", async () => {
    storage["unequal:jwt"] = "existing_jwt_token";
    const token = await ensureJwt("http://localhost:8787", vi.fn());
    expect(token).toBe("existing_jwt_token");
    expect(mockWx.login).not.toHaveBeenCalled();
  });

  it("401 → 抛 Error 含 status + code（让 caller retry）", async () => {
    mockWx.login.mockImplementation(({ success }: any) => {
      success({ code: "expired_code" });
    });
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "INVALID_CODE" }), { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(ensureJwt("http://localhost:8787", fakeFetch)).rejects.toThrow(
      /\/auth\/wx-login 401.*INVALID_CODE/,
    );
  });

  it("wx.login 抛错 → propagate（app.ts onLaunch 失败不 throw 阻塞启动）", async () => {
    mockWx.login.mockImplementation(({ fail }: any) => {
      fail({ errMsg: "wx.login fail" });
    });
    await expect(ensureJwt("http://localhost:8787", vi.fn())).rejects.toThrow(
      /wx.login/,
    );
  });
});
