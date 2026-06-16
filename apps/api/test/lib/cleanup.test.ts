/**
 * M6.5 cleanup 函数测试套件（spec §5.6 + plan §4 Task 1）。
 *
 * 4 用例：
 * 1. happy path: 3-old-2-new → { deleted: 3 }
 * 2. 空表 → { deleted: 0 }
 * 3. cutoffMs 边界: cutoff=0 删全部, cutoff=Infinity 删 0
 * 4. D1 throws → cleanup throws
 *
 * 测试策略：直接调 cleanupLoginAttempts 函数 + fakeDB（不依赖 miniflare）。
 *
 * 与 cron.test.ts 关系：
 * - cleanup.test.ts 测函数本身（cutoffMs 边界 + D1 throws），不涉及 HTTP auth
 * - cron.test.ts 测 HTTP path（auth + 调 cleanup），fakeDB 端到端
 */
import { describe, it, expect } from "vitest";
import { cleanupLoginAttempts, DEFAULT_CUTOFF_MS } from "../../src/lib/cleanup.js";
import type { Env } from "../../src/types.js";

function makeFakeDB(rows: { created_at: number }[]) {
  let currentRows = [...rows];
  let lastBindParam: number | null = null;
  return {
    db: {
      prepare: (_sql: string) => ({
        bind: (...params: unknown[]) => {
          lastBindParam = params[0] as number;
          return {
            run: async (): Promise<D1ExecResult> => {
              const cutoff = params[0] as number;
              const before = currentRows.length;
              currentRows = currentRows.filter((r) => r.created_at >= cutoff);
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
          };
        },
      }),
    } as unknown as D1Database,
    getRowCount: () => currentRows.length,
    getLastBindParam: () => lastBindParam,
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
    CRON_SECRET: "test-cron-secret",
  };
}

function nowMinusHours(hours: number): number {
  return Date.now() - hours * 60 * 60 * 1000;
}

describe("cleanupLoginAttempts (M6.5)", () => {
  it("happy path: 3-old-2-new → { deleted: 3 } + bind 参数 = cutoff", async () => {
    const fake = makeFakeDB([
      { created_at: nowMinusHours(48) },
      { created_at: nowMinusHours(36) },
      { created_at: nowMinusHours(25) },
      { created_at: nowMinusHours(12) },
      { created_at: nowMinusHours(1) },
    ]);
    const before = Date.now();
    const result = await cleanupLoginAttempts(makeEnv(fake.db), DEFAULT_CUTOFF_MS);
    const after = Date.now();

    expect(result.deleted).toBe(3);
    expect(fake.getRowCount()).toBe(2);

    // 验证 bind 参数（cutoff）大致是 now - 24h
    const bindParam = fake.getLastBindParam()!;
    expect(bindParam).toBeGreaterThan(before - DEFAULT_CUTOFF_MS - 100);
    expect(bindParam).toBeLessThan(after - DEFAULT_CUTOFF_MS + 100);
  });

  it("空表 → { deleted: 0 }（不报错）", async () => {
    const fake = makeFakeDB([]);
    const result = await cleanupLoginAttempts(makeEnv(fake.db), DEFAULT_CUTOFF_MS);
    expect(result.deleted).toBe(0);
    expect(fake.getRowCount()).toBe(0);
  });

  it("cutoffMs 边界: cutoffMs=0 → cutoff=now → 全部 deleted", async () => {
    // cutoff = Date.now() - 0 = Date.now()，所以所有 created_at < now 都删
    // 任何 created_at < Date.now() 的行都被删（包括 created_at = 0）
    const fake = makeFakeDB([
      { created_at: 0 },           // 极早
      { created_at: nowMinusHours(1) },  // 1 小时前
      { created_at: nowMinusHours(100) }, // 100 小时前
    ]);
    const result = await cleanupLoginAttempts(makeEnv(fake.db), 0);
    expect(result.deleted).toBe(3); // 全部 < now
    expect(fake.getRowCount()).toBe(0);
  });

  it("cutoffMs 边界: cutoffMs=Number.POSITIVE_INFINITY → cutoff=-Infinity → 0 deleted", async () => {
    // cutoff = Date.now() - Infinity = -Infinity，任何 created_at < -Infinity 都不成立
    const fake = makeFakeDB([
      { created_at: 0 },
      { created_at: nowMinusHours(1) },
    ]);
    const result = await cleanupLoginAttempts(makeEnv(fake.db), Number.POSITIVE_INFINITY);
    expect(result.deleted).toBe(0);
    expect(fake.getRowCount()).toBe(2);
  });

  it("D1 throws → cleanup throws（向上抛，不静默）", async () => {
    const throwingDB = {
      prepare: (_sql: string) => ({
        bind: () => ({
          run: async () => {
            throw new Error("D1 connection lost");
          },
        }),
      }),
    } as unknown as D1Database;

    await expect(
      cleanupLoginAttempts(makeEnv(throwingDB), DEFAULT_CUTOFF_MS),
    ).rejects.toThrow("D1 connection lost");
  });

  it("DEFAULT_CUTOFF_MS = 24h (86_400_000 ms)", () => {
    expect(DEFAULT_CUTOFF_MS).toBe(24 * 60 * 60 * 1000);
  });
});
