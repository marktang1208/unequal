/**
 * M6.5 worker.scheduled handler 测试套件（spec §5.3 + §5.6 + plan §4 Task 2）。
 *
 * 2 用例：
 * 1. scheduled happy: 调 cleanupLoginAttempts + console.log "deleted=N"
 * 2. scheduled 错误: cleanup throws → console.error, 不 re-throw
 *
 * 测试策略：直接调 scheduled 函数 + vi.mock cleanup 模块。
 * miniflare 不模拟 CF Cron Triggers，CP-5 真接时验证触发时机。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// mock cleanup 模块（必须在 import scheduled 之前 hoisted）
vi.mock("../../src/lib/cleanup.js", () => ({
  cleanupLoginAttempts: vi.fn(),
  DEFAULT_CUTOFF_MS: 86_400_000,
}));

import { scheduled } from "../../src/scheduled.js";
import { cleanupLoginAttempts } from "../../src/lib/cleanup.js";
import type { Env } from "../../src/types.js";

const mockCleanup = vi.mocked(cleanupLoginAttempts);

function makeEnv(): Env {
  return {
    DB: {} as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    R2: {} as R2Bucket,
    ADMIN_TOKEN: "test-admin",
    MINIMAX_API_KEY: "test",
    MINIMAX_BASE_URL: "http://mock.local",
    ENVIRONMENT: "test",
    ALLOWED_ORIGIN: "*",
    AUTH_MODE: "admin_token",
    JWT_SECRET: "test-jwt-secret-32-bytes-long-please-please",
    WX_APP_ID: "wx_test",
    WX_APP_SECRET: "wx_test_secret",
    CRON_SECRET: "test-cron-secret",
  };
}

describe("scheduled handler (M6.5)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCleanup.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("happy: 调 cleanupLoginAttempts(env, DEFAULT_CUTOFF_MS=86_400_000) + console.log 'deleted=N'", async () => {
    mockCleanup.mockResolvedValue({ deleted: 5, cutoff: Date.now() - 86_400_000 });

    const fakeEvent = {
      cron: "0 3 * * *",
      scheduledTime: Date.now(),
      noRetry: () => {},
    } as unknown as ScheduledController;
    const fakeCtx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
      abort: () => {},
    } as unknown as ExecutionContext;

    await scheduled(fakeEvent, makeEnv(), fakeCtx);

    // 验证 mockCleanup 被调一次，参数 = (env, 86_400_000)
    expect(mockCleanup).toHaveBeenCalledTimes(1);
    const [envArg, cutoffArg] = mockCleanup.mock.calls[0]!;
    expect(envArg.ENVIRONMENT).toBe("test");
    expect(cutoffArg).toBe(86_400_000);

    // 验证 console.log 输出包含 "deleted=5"
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logMessage = logSpy.mock.calls[0]![0] as string;
    expect(logMessage).toContain("[cron] cleanup-login-attempts");
    expect(logMessage).toContain("deleted=5");

    // 不应调 console.error
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("错误: cleanup throws → console.error + 不 re-throw", async () => {
    mockCleanup.mockRejectedValue(new Error("D1 connection lost"));

    const fakeEvent = {
      cron: "0 3 * * *",
      scheduledTime: Date.now(),
      noRetry: () => {},
    } as unknown as ScheduledController;
    const fakeCtx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
      abort: () => {},
    } as unknown as ExecutionContext;

    // 不应 throw（scheduled handler 的 catch 兜底）
    await expect(scheduled(fakeEvent, makeEnv(), fakeCtx)).resolves.toBeUndefined();

    // 验证 console.error 被调 + 包含错误信息
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const errorCall = errorSpy.mock.calls[0]!;
    const errorMessage = errorCall[0] as string;
    const errorArg = errorCall[1];
    expect(errorMessage).toContain("[cron] cleanup-login-attempts failed");
    expect(String(errorArg)).toContain("D1 connection lost");

    // 不应调 console.log（因为 cleanup 失败）
    expect(logSpy).not.toHaveBeenCalled();
  });
});
