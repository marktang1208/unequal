/**
 * M6.4 cron cleanup 测试套件（spec §5.3 + plan §4 Task 3）。
 *
 * 3 用例：
 * 1. happy: Bearer CRON_SECRET + DELETE 5 行 → 返 { deleted: 5, cutoff }
 * 2. 401: 缺 Authorization header
 * 3. 401: Bearer 错 secret
 *
 * 测试策略：直接调 cronRoute.CLEANUP_LOGIN_ATTEMPTS 函数 + cronFakeDB（单测，不走 miniflare）。
 * 简化：cron handler 逻辑很简单（鉴权 + 1 个 DELETE），不需要完整 miniflare bundle。
 */
import { describe, it, expect } from "vitest";
import { cronRoute } from "../../src/routes/cron.js";
import type { Env } from "../../src/types.js";

const CRON_SECRET = "test-cron-secret-please-change";

function makeCronFakeDB(
  rows: { id: string; created_at: number; identifier: string; attempt_type: string; succeeded: number }[],
) {
  let currentRows = [...rows];
  let lastDeleteCutoff: number | null = null;
  return {
    db: {
      prepare: (_sql: string) => ({
        bind: (...params: unknown[]) => ({
          run: async (): Promise<D1ExecResult> => {
            const cutoff = params[0] as number;
            lastDeleteCutoff = cutoff;
            const before = currentRows.length;
            currentRows = currentRows.filter((r) => r.created_at >= cutoff);
            // D1ExecResult.meta.changes 是实际 D1 返回的字段；workers-types 类型未显式包含 meta，
            // 但 runtime 存在；用 as unknown 兼容类型 + 不破坏断言。
            return {
              meta: {
                changes: before - currentRows.length,
                duration: 0,
                last_row_id: 0,
                changed_db: true,
                size_after: 0,
                rows_read: 0,
                rows_written: 0,
              },
              success: true,
            } as unknown as D1ExecResult;
          },
        }),
      }),
    } as unknown as D1Database,
    getRowCount: () => currentRows.length,
    getLastCutoff: () => lastDeleteCutoff,
  };
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
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
    CRON_SECRET,
  };
}

function nowMinusHours(hours: number): number {
  return Date.now() - hours * 60 * 60 * 1000;
}

describe("cronRoute.CLEANUP_LOGIN_ATTEMPTS (M6.4)", () => {
  it("happy: Bearer CRON_SECRET + 3 行老 + 2 行新 → DELETE 老 3 行 → 返 { deleted: 3 }", async () => {
    // 3 行老（> 24h 前）+ 2 行新（< 24h 前）
    const fake = makeCronFakeDB([
      { id: "r1", created_at: nowMinusHours(48), identifier: "a", attempt_type: "admin", succeeded: 0 },
      { id: "r2", created_at: nowMinusHours(36), identifier: "a", attempt_type: "admin", succeeded: 0 },
      { id: "r3", created_at: nowMinusHours(25), identifier: "b", attempt_type: "wx_code", succeeded: 0 },
      { id: "r4", created_at: nowMinusHours(12), identifier: "c", attempt_type: "admin", succeeded: 1 },
      { id: "r5", created_at: nowMinusHours(1), identifier: "d", attempt_type: "admin", succeeded: 0 },
    ]);
    const req = new Request("http://localhost/cron/cleanup-login-attempts", {
      method: "POST",
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    const res = await cronRoute.CLEANUP_LOGIN_ATTEMPTS(req, makeEnv(fake.db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; cutoff: number };
    expect(body.deleted).toBe(3);
    // cutoff 约 = now - 24h
    expect(body.cutoff).toBeGreaterThan(nowMinusHours(24) - 1000);
    expect(body.cutoff).toBeLessThan(nowMinusHours(24) + 1000);
    expect(fake.getRowCount()).toBe(2);  // 剩 2 行（r4 + r5）
    // 验证 DELETE SQL 用了正确的 cutoff
    expect(fake.getLastCutoff()).toBe(body.cutoff);
  });

  it("happy: 表空 → DELETE 0 行 → 返 { deleted: 0 }（不报错）", async () => {
    const fake = makeCronFakeDB([]);
    const req = new Request("http://localhost/cron/cleanup-login-attempts", {
      method: "POST",
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    const res = await cronRoute.CLEANUP_LOGIN_ATTEMPTS(req, makeEnv(fake.db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(0);
  });

  it("401: 缺 Authorization header → UNAUTHORIZED", async () => {
    const fake = makeCronFakeDB([]);
    const req = new Request("http://localhost/cron/cleanup-login-attempts", {
      method: "POST",
    });
    const res = await cronRoute.CLEANUP_LOGIN_ATTEMPTS(req, makeEnv(fake.db));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("UNAUTHORIZED");
    // DELETE 不应被调
    expect(fake.getRowCount()).toBe(0);
    expect(fake.getLastCutoff()).toBeNull();
  });

  it("401: Bearer 错 secret → UNAUTHORIZED", async () => {
    const fake = makeCronFakeDB([
      { id: "r1", created_at: nowMinusHours(48), identifier: "a", attempt_type: "admin", succeeded: 0 },
    ]);
    const req = new Request("http://localhost/cron/cleanup-login-attempts", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-secret" },
    });
    const res = await cronRoute.CLEANUP_LOGIN_ATTEMPTS(req, makeEnv(fake.db));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("UNAUTHORIZED");
    expect(fake.getRowCount()).toBe(1);  // 数据未变
    expect(fake.getLastCutoff()).toBeNull();
  });
});
