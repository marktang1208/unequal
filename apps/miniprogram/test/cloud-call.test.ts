/**
 * CP-7-A cloudCall<T>(req): Promise<T> 测试（spec §7.1 / plan Task 1）。
 *
 * 覆盖 10 个用例：
 * 1. happy: 200 → return body as T
 * 2. 401 + jwt + refresh 成功 + retry 200 → return retry body
 * 3. 401 + jwt + refresh 失败 → throw ApiError(401, REFRESH_FAILED)
 * 4. 401 + jwt + refresh 成功 + retry 仍 401 → throw ApiError(401, UNAUTHORIZED)
 * 5. 401 + 无 jwt → throw ApiError(401, MISSING_AUTH)
 * 6. 4xx → throw ApiError(statusCode, code, message)
 * 7. 5xx → throw ApiError(500, code, message)
 * 8. impl throw Error → throw ApiError(0, NETWORK_ERROR, msg)
 * 9. impl throw string → throw ApiError(0, NETWORK_ERROR, msg)
 * 10. inflight share: 3 并发 401 → ensureJwt 只调 1 次
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as authModule from "../lib/auth.js";
import {
  cloudCall,
  ApiError,
  __setCloudCallImpl,
  __resetCloudCallImpl,
  __clearInflightRefresh,
  type CloudCallFn,
} from "../lib/cloud-call.js";

// Mock wx 全局（saveJwt 内部调 wx.removeStorageSync）
(globalThis as { wx?: unknown }).wx = {
  removeStorageSync: vi.fn(),
};

let mockCloudCall: ReturnType<typeof vi.fn>;
let ensureJwtMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __clearInflightRefresh();
  __resetCloudCallImpl();
  mockCloudCall = vi.fn();
  __setCloudCallImpl(mockCloudCall as unknown as CloudCallFn);
  ensureJwtMock = vi.spyOn(authModule, "ensureJwt").mockResolvedValue("new_jwt");
});

afterEach(() => {
  vi.restoreAllMocks();
  __clearInflightRefresh();
  __resetCloudCallImpl();
});

describe("cloudCall (CP-7-A) — happy path", () => {
  it("200 → return body as T", async () => {
    mockCloudCall.mockResolvedValue({ statusCode: 200, body: { answer: "ok", id: "01HABC" } });
    const r = await cloudCall<{ answer: string; id: string }>({
      path: "/api-ask",
      httpMethod: "POST",
      body: { q: "test" },
      jwt: "tok",
    });
    expect(r.answer).toBe("ok");
    expect(r.id).toBe("01HABC");
    expect(mockCloudCall).toHaveBeenCalledTimes(1);
    expect(ensureJwtMock).not.toHaveBeenCalled();
  });
});

describe("cloudCall (CP-7-A) — 401 + jwt + refresh", () => {
  it("401 + jwt + refresh 成功 + retry 200 → return retry body", async () => {
    let callCount = 0;
    mockCloudCall.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { statusCode: 401, body: { error: "UNAUTHORIZED" } };
      return { statusCode: 200, body: { answer: "refreshed", id: "01HDEF" } };
    });
    const r = await cloudCall<{ answer: string; id: string }>({
      path: "/api-chat",
      httpMethod: "POST",
      body: { q: "test" },
      jwt: "old",
    });
    expect(r.answer).toBe("refreshed");
    expect(callCount).toBe(2);
    expect(ensureJwtMock).toHaveBeenCalledTimes(1);
  });

  it("401 + jwt + refresh 失败 → throw ApiError(401, REFRESH_FAILED)", async () => {
    mockCloudCall.mockResolvedValue({ statusCode: 401, body: null });
    ensureJwtMock.mockRejectedValueOnce(new Error("wx.login fail"));

    await expect(
      cloudCall({ path: "/api-ask", httpMethod: "POST", body: {}, jwt: "old" }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "REFRESH_FAILED",
      message: expect.stringContaining("wx.login"),
    });
  });

  it("401 + jwt + refresh 成功 + retry 仍 401 → throw ApiError(401, UNAUTHORIZED)", async () => {
    // mockCloudCall 永远返 401（refresh + retry 都 401，拒死循环）
    mockCloudCall.mockResolvedValue({ statusCode: 401, body: null });

    let err: unknown;
    try {
      await cloudCall({ path: "/api-ask", httpMethod: "POST", body: {}, jwt: "old" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.statusCode).toBe(401);
    expect(apiErr.code).toBe("UNAUTHORIZED");
    expect(apiErr.message).toMatch(/refresh/);
    // mockCloudCall 应被调 2 次（第一次 401 + refresh 后 retry 401），绝不超过 2
    expect(mockCloudCall.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("cloudCall (CP-7-A) — 401 无 jwt", () => {
  it("401 + 无 jwt → throw ApiError(401, MISSING_AUTH)", async () => {
    mockCloudCall.mockResolvedValue({ statusCode: 401, body: null });
    await expect(
      cloudCall({ path: "/api-ask", httpMethod: "POST", body: {} }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "MISSING_AUTH",
      message: expect.stringContaining("No JWT"),
    });
    // refresh 不调（无 jwt 不进 refresh 分支）
    expect(ensureJwtMock).not.toHaveBeenCalled();
  });
});

describe("cloudCall (CP-7-A) — 4xx / 5xx", () => {
  it("4xx → throw ApiError(statusCode, serverCode, msg)", async () => {
    mockCloudCall.mockResolvedValue({
      statusCode: 400,
      body: { error: "BAD_INPUT", message: "q missing" },
    });
    await expect(
      cloudCall({ path: "/api-ask", httpMethod: "POST", body: {}, jwt: "t" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BAD_INPUT",
      message: "q missing",
    });
  });

  it("5xx → throw ApiError(500, serverCode, msg)", async () => {
    mockCloudCall.mockResolvedValue({
      statusCode: 500,
      body: { error: "INTERNAL", message: "boom" },
    });
    await expect(
      cloudCall({ path: "/api-ask", httpMethod: "POST", body: {}, jwt: "t" }),
    ).rejects.toMatchObject({
      statusCode: 500,
      code: "INTERNAL",
      message: "boom",
    });
  });
});

describe("cloudCall (CP-7-A) — network error", () => {
  it("impl throw Error → throw ApiError(0, NETWORK_ERROR, msg)", async () => {
    mockCloudCall.mockRejectedValue(new Error("network down"));
    await expect(
      cloudCall({ path: "/api-ask", httpMethod: "POST", body: {}, jwt: "t" }),
    ).rejects.toMatchObject({
      statusCode: 0,
      code: "NETWORK_ERROR",
      message: "network down",
    });
  });

  it("impl throw string → throw ApiError(0, NETWORK_ERROR, msg)", async () => {
    mockCloudCall.mockRejectedValue("string error");
    await expect(
      cloudCall({ path: "/api-ask", httpMethod: "POST", body: {}, jwt: "t" }),
    ).rejects.toMatchObject({
      statusCode: 0,
      code: "NETWORK_ERROR",
      message: "string error",
    });
  });
});

describe("cloudCall (CP-7-A) — inflight share", () => {
  it("3 并发 401 → ensureJwt 只调 1 次", async () => {
    mockCloudCall.mockResolvedValue({ statusCode: 401, body: null });

    let resolveEnsureJwt: ((v: string) => void) | null = null;
    ensureJwtMock.mockImplementation(
      () => new Promise<string>((r) => { resolveEnsureJwt = r; }),
    );

    // 3 个并发 cloudCall（不 await，先让 3 个都进入 inflight await 状态）
    const p1 = cloudCall({ path: "/api-chat", httpMethod: "POST", body: {}, jwt: "old" }).catch(() => null);
    const p2 = cloudCall({ path: "/api-sessions-list", httpMethod: "GET", jwt: "old" }).catch(() => null);
    const p3 = cloudCall({ path: "/api-ask", httpMethod: "POST", body: {}, jwt: "old" }).catch(() => null);

    // 让 microtask queue 跑 — 3 个 cloudCall 都已触发 refresh 分支
    await new Promise((r) => setTimeout(r, 0));
    expect(ensureJwtMock).toHaveBeenCalledTimes(1);

    // resolve ensureJwt → inflight 完成 → 3 个 cloudCall 各自 retry（仍 401 → throw UNAUTHORIZED）
    resolveEnsureJwt!("new_jwt");
    await Promise.all([p1, p2, p3]);

    // 最终 ensureJwt 仍 1 次（inflight 共享）
    expect(ensureJwtMock).toHaveBeenCalledTimes(1);
  });
});