/**
 * M6.3a lib/rate-limit.ts 测试套件（spec §5.1 + §6 + §9.1）。
 *
 * 6 用例覆盖：
 * 1. sha256 一致性（同样 input → 同样 hex 16 字符）
 * 2. 4 次失败不锁（< 5 阈值）
 * 3. 5 次失败锁 + retry_after > 0
 * 4. 锁定后 16min（窗口外）→ 不锁
 * 5. wx_code 同表独立计数（admin 失败 5 不影响 wx_code）
 * 6. retry_after = ceil((oldest + WINDOW - now) / 1000)
 *
 * 测试策略：spy-style fake D1（同 user.test.ts），不解析 SQL，不走 miniflare。
 * fake D1 内置支持 COUNT(*) 和 MIN(created_at) 两种 SQL — 满足 checkRateLimit 调用。
 * 时间通过 recordAttempt / checkRateLimit 的 `now` 参数显式注入，避免 fake timer 复杂度。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  sha256Identifier,
  checkRateLimit,
  recordAttempt,
  WINDOW_MS,
} from "../../src/lib/rate-limit.js";

/* ---------- spy-style fake D1 ---------- */

type D1Handler = (params: unknown[]) => Promise<unknown>;
interface D1Call { sql: string; params: unknown[]; op: "first" | "all" | "run" }

interface FakeDBOptions {
  // 模拟 current rows of login_attempt（按 created_at DESC 排好序）
  rows?: { identifier: string; attempt_type: string; succeeded: number; created_at: number; id: string }[];
  // "global" hooks
  first?: D1Handler;
  all?: D1Handler;
  run?: D1Handler;
}

function makeFakeDB(opts: FakeDBOptions = {}) {
  const calls: D1Call[] = [];
  // 复制 rows（避免测试间共享）
  let rows = (opts.rows ?? []).map((r) => ({ ...r }));
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => {
        const record = (op: D1Call["op"]): D1Call => ({ sql, params, op });
        return {
          first: async <T>(): Promise<T | null> => {
            calls.push(record("first"));
            if (opts.first) return (await opts.first(params)) as T;
            // 默认：实现 COUNT(*) / MIN(created_at) 用于 checkRateLimit
            if (/COUNT\(\*\)/i.test(sql)) {
              const id = params[0] as string;
              const type = params[1] as string;
              const since = params[2] as number;
              const count = rows.filter(
                (r) => r.identifier === id && r.attempt_type === type && r.succeeded === 0 && r.created_at > since,
              ).length;
              return { c: count } as T;
            }
            if (/MIN\(created_at\)/i.test(sql)) {
              const id = params[0] as string;
              const type = params[1] as string;
              const since = params[2] as number;
              const matches = rows.filter(
                (r) => r.identifier === id && r.attempt_type === type && r.succeeded === 0 && r.created_at > since,
              );
              const minCreated = matches.length > 0 ? Math.min(...matches.map((m) => m.created_at)) : null;
              return minCreated !== null ? ({ m: minCreated } as T) : (null as T);
            }
            return null;
          },
          all: async <T>(): Promise<{ results: T[] }> => {
            calls.push(record("all"));
            if (opts.all) return (await opts.all(params)) as { results: T[] };
            return { results: [] };
          },
          run: async (): Promise<void> => {
            calls.push(record("run"));
            if (opts.run) {
              await opts.run(params);
              return;
            }
            // 默认：实现 INSERT login_attempt
            if (/INSERT INTO login_attempt/i.test(sql)) {
              const [id, identifier, attempt_type, succeeded, created_at] = params as [string, string, string, number, number];
              rows.push({ id, identifier, attempt_type, succeeded, created_at });
            }
          },
        };
      },
    }),
    // 测试 helper：dump current rows
    _rows: () => rows,
  };
  return { db: db as unknown as D1Database, calls };
}

describe("rate-limit.sha256Identifier", () => {
  it("sha256 一致性 + 16 hex 字符：同 input 两次 → 同 output（hex 16 字符）", async () => {
    const a = await sha256Identifier("test-admin-token");
    const b = await sha256Identifier("test-admin-token");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("rate-limit.checkRateLimit / recordAttempt (spy-style fake D1)", () => {
  let fakeDB: ReturnType<typeof makeFakeDB>;
  let d1: D1Database;

  beforeEach(() => {
    fakeDB = makeFakeDB();
    d1 = fakeDB.db;
  });

  it("4 次失败不锁（< MAX_FAILURES=5）", async () => {
    for (let i = 0; i < 4; i++) {
      await recordAttempt(d1, "tokenhash", "admin", false, 1_000_000 + i);
    }
    const result = await checkRateLimit(d1, "tokenhash", "admin", 1_000_000);
    expect(result.locked).toBe(false);
    expect(result.retry_after).toBe(0);
  });

  it("5 次失败锁 + retry_after > 0", async () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      await recordAttempt(d1, "tokenhash", "admin", false, now + i);
    }
    const result = await checkRateLimit(d1, "tokenhash", "admin", now);
    expect(result.locked).toBe(true);
    expect(result.retry_after).toBeGreaterThan(0);
  });

  it("锁定后 16min（窗口外）→ 不锁", async () => {
    const startTime = 1_000_000;
    // 5 次失败记录在 startTime 时刻
    for (let i = 0; i < 5; i++) {
      await recordAttempt(d1, "tokenhash", "admin", false, startTime + i);
    }
    // 16min 后 — 5 个 attempts 全部出窗口
    const after16min = startTime + WINDOW_MS + 1;
    const result = await checkRateLimit(d1, "tokenhash", "admin", after16min);
    expect(result.locked).toBe(false);
    expect(result.retry_after).toBe(0);
  });

  it("wx_code 独立计数：admin 失败 5 不影响 wx_code 阈值", async () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      await recordAttempt(d1, "adminhash", "admin", false, now + i);
    }
    // admin 已锁
    const adminResult = await checkRateLimit(d1, "adminhash", "admin", now);
    expect(adminResult.locked).toBe(true);
    // wx_code 同一 identifier（hash 撞概率 2^-64）也不锁（attempt_type 不同）
    const wxResult = await checkRateLimit(d1, "adminhash", "wx_code", now);
    expect(wxResult.locked).toBe(false);
  });

  it("retry_after = ceil((oldest + WINDOW - now) / 1000)", async () => {
    const oldest = 1_000_000;
    // oldest 时刻 + 后续 4 个 attempts
    await recordAttempt(d1, "t", "admin", false, oldest);
    await recordAttempt(d1, "t", "admin", false, oldest + 1_000);
    await recordAttempt(d1, "t", "admin", false, oldest + 2_000);
    await recordAttempt(d1, "t", "admin", false, oldest + 3_000);
    await recordAttempt(d1, "t", "admin", false, oldest + 4_000);
    // now = oldest + 10_000 → retry_after = ceil((oldest + 900_000 - (oldest + 10_000)) / 1000) = 890
    const now = oldest + 10_000;
    const result = await checkRateLimit(d1, "t", "admin", now);
    expect(result.locked).toBe(true);
    expect(result.retry_after).toBe(Math.ceil((oldest + WINDOW_MS - now) / 1000));
  });
});
