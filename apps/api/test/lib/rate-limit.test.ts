/**
 * M6.3a + M6.4 + M6.6 lib/rate-limit.ts 测试套件。
 *
 * M6.3a：6 用例（sha256 + checkRateLimit + recordAttempt）
 * M6.4：6 用例（readRateLimitConfig + checkRateLimit config 注入）
 * M6.6：11 用例（getClientIp 3 + sha256ClientIp 1 + checkRateLimitByIp 3 + checkRateLimitDual 4）
 *
 * 测试策略：spy-style fake D1（同 user.test.ts），不解析 SQL，不走 miniflare。
 * fake D1 内置支持 COUNT(*) / MIN(created_at) 两种 SQL — 满足 checkRateLimit / checkRateLimitByIp 调用。
 * 时间通过 recordAttempt / checkRateLimit 的 `now` 参数显式注入，避免 fake timer 复杂度。
 *
 * M6.6：fake D1 扩展按 SQL 关键字解析 filter column（identifier vs client_ip），
 * 旧 SQL `WHERE identifier = ?` 仍走 identifier 过滤；新 SQL `WHERE client_ip = ?` 走 client_ip 过滤。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  sha256Identifier,
  checkRateLimit,
  recordAttempt,
  readRateLimitConfig,
  DEFAULT_RATE_LIMIT_CONFIG,
  WINDOW_MS,
  getClientIp,
  sha256ClientIp,
  UNKNOWN_IP_HASH,
  checkRateLimitByIp,
  checkRateLimitDual,
} from "../../src/lib/rate-limit.js";

/* ---------- spy-style fake D1 ---------- */

type D1Handler = (params: unknown[]) => Promise<unknown>;
interface D1Call { sql: string; params: unknown[]; op: "first" | "all" | "run" }

interface FakeDBOptions {
  // 模拟 current rows of login_attempt（按 created_at DESC 排好序）
  // M6.6: 加 client_ip 可选字段（per-IP 限流数据源）
  rows?: { identifier: string; client_ip?: string; attempt_type: string; succeeded: number; created_at: number; id: string }[];
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
            // M6.6: 按 SQL 决定 filter column（identifier vs client_ip）
            const filterByClientIp = /client_ip\s*=\s*\?/i.test(sql);
            const filterCol = filterByClientIp ? "client_ip" : "identifier";
            // 默认：实现 COUNT(*) / MIN(created_at) 用于 checkRateLimit / checkRateLimitByIp
            if (/COUNT\(\*\)/i.test(sql)) {
              const val = params[0] as string;
              const type = params[1] as string;
              const since = params[2] as number;
              const count = rows.filter(
                (r) => r[filterCol] === val && r.attempt_type === type && r.succeeded === 0 && r.created_at > since,
              ).length;
              return { c: count } as T;
            }
            if (/MIN\(created_at\)/i.test(sql)) {
              const val = params[0] as string;
              const type = params[1] as string;
              const since = params[2] as number;
              const matches = rows.filter(
                (r) => r[filterCol] === val && r.attempt_type === type && r.succeeded === 0 && r.created_at > since,
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
              // M6.6 Task 2 改 recordAttempt 签名后变 6 列
              const [id, identifier, attempt_type, succeeded, client_ip, created_at] = params as [string, string, string, number, string, number];
              rows.push({ id, identifier, client_ip, attempt_type, succeeded, created_at });
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
      await recordAttempt(d1, "tokenhash", "admin", false, "ip1hash", 1_000_000 + i);
    }
    const result = await checkRateLimit(d1, "tokenhash", "admin", 1_000_000);
    expect(result.locked).toBe(false);
    expect(result.retry_after).toBe(0);
  });

  it("5 次失败锁 + retry_after > 0", async () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      await recordAttempt(d1, "tokenhash", "admin", false, "ip1hash", now + i);
    }
    const result = await checkRateLimit(d1, "tokenhash", "admin", now);
    expect(result.locked).toBe(true);
    expect(result.retry_after).toBeGreaterThan(0);
  });

  it("锁定后 16min（窗口外）→ 不锁", async () => {
    const startTime = 1_000_000;
    // 5 次失败记录在 startTime 时刻
    for (let i = 0; i < 5; i++) {
      await recordAttempt(d1, "tokenhash", "admin", false, "ip1hash", startTime + i);
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
      await recordAttempt(d1, "adminhash", "admin", false, "ip1hash", now + i);
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
    await recordAttempt(d1, "t", "admin", false, "ip1hash", oldest);
    await recordAttempt(d1, "t", "admin", false, "ip1hash", oldest + 1_000);
    await recordAttempt(d1, "t", "admin", false, "ip1hash", oldest + 2_000);
    await recordAttempt(d1, "t", "admin", false, "ip1hash", oldest + 3_000);
    await recordAttempt(d1, "t", "admin", false, "ip1hash", oldest + 4_000);
    // now = oldest + 10_000 → retry_after = ceil((oldest + 900_000 - (oldest + 10_000)) / 1000) = 890
    const now = oldest + 10_000;
    const result = await checkRateLimit(d1, "t", "admin", now);
    expect(result.locked).toBe(true);
    expect(result.retry_after).toBe(Math.ceil((oldest + WINDOW_MS - now) / 1000));
  });
});

/* ---------- M6.4 readRateLimitConfig + checkRateLimit config 注入 ---------- */

describe("rate-limit.readRateLimitConfig (M6.4)", () => {
  it("env 缺省 → fallback DEFAULT_RATE_LIMIT_CONFIG", () => {
    expect(readRateLimitConfig({})).toEqual(DEFAULT_RATE_LIMIT_CONFIG);
  });

  it("env 注入 LOGIN_MAX_ATTEMPTS='3' → maxFailures=3（windowMs 不变）", () => {
    const config = readRateLimitConfig({ LOGIN_MAX_ATTEMPTS: "3" });
    expect(config.maxFailures).toBe(3);
    expect(config.windowMs).toBe(DEFAULT_RATE_LIMIT_CONFIG.windowMs);
  });

  it("env 注入 LOGIN_MAX_ATTEMPTS='abc'（非法）→ fallback 5", () => {
    expect(readRateLimitConfig({ LOGIN_MAX_ATTEMPTS: "abc" }).maxFailures).toBe(5);
  });

  it("env 注入 LOGIN_MAX_ATTEMPTS='0'（≤0）→ fallback 5（不 throw）", () => {
    expect(readRateLimitConfig({ LOGIN_MAX_ATTEMPTS: "0" }).maxFailures).toBe(5);
  });

  it("env 注入 LOGIN_WINDOW_MS='60000' → windowMs=60000", () => {
    expect(readRateLimitConfig({ LOGIN_WINDOW_MS: "60000" }).windowMs).toBe(60000);
  });
});

describe("rate-limit.checkRateLimit (M6.4) config 注入", () => {
  let fakeDB: ReturnType<typeof makeFakeDB>;
  let d1: D1Database;

  beforeEach(() => {
    fakeDB = makeFakeDB();
    d1 = fakeDB.db;
  });

  it("config maxFailures=2 → 1 次失败不锁 / 2 次失败锁", async () => {
    const now = 1_000_000;
    const config = { maxFailures: 2, windowMs: WINDOW_MS };
    // 1 次失败 → 不锁
    await recordAttempt(d1, "t", "admin", false, "ip1hash", now);
    const r1 = await checkRateLimit(d1, "t", "admin", now, config);
    expect(r1.locked).toBe(false);

    // 2 次失败 → 锁
    await recordAttempt(d1, "t", "admin", false, "ip1hash", now + 1);
    const r2 = await checkRateLimit(d1, "t", "admin", now + 1, config);
    expect(r2.locked).toBe(true);
  });

  it("不传 config → 用 DEFAULT_RATE_LIMIT_CONFIG（向后兼容）", async () => {
    const now = 1_000_000;
    // 4 次失败 → 不锁（default maxFailures=5）
    for (let i = 0; i < 4; i++) {
      await recordAttempt(d1, "t", "admin", false, "ip1hash", now + i);
    }
    const r = await checkRateLimit(d1, "t", "admin", now);   // 不传 config
    expect(r.locked).toBe(false);
  });
});

/* ---------- M6.6 per-IP 限流 helpers + checkRateLimitByIp + checkRateLimitDual ---------- */

describe("rate-limit.getClientIp (M6.6)", () => {
  it("有 CF-Connecting-IP header → 返该值", () => {
    const req = new Request("http://localhost/", {
      headers: { "CF-Connecting-IP": "1.2.3.4" },
    });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("缺 CF-Connecting-IP header → 返 'unknown'", () => {
    const req = new Request("http://localhost/");
    expect(getClientIp(req)).toBe("unknown");
  });

  it("大小写不敏感：header 名小写 'cf-connecting-ip' 也能读", () => {
    const req = new Request("http://localhost/", {
      headers: { "cf-connecting-ip": "5.6.7.8" },
    });
    expect(getClientIp(req)).toBe("5.6.7.8");
  });
});

describe("rate-limit.sha256ClientIp (M6.6)", () => {
  it("确定性输出 + 16 hex 字符；'unknown' 短路返 UNKNOWN_IP_HASH；不同 IP 返不同结果", async () => {
    // 确定性 + 16 hex
    const a = await sha256ClientIp("1.2.3.4");
    const b = await sha256ClientIp("1.2.3.4");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);

    // 'unknown' 短路
    expect(await sha256ClientIp("unknown")).toBe(UNKNOWN_IP_HASH);
    expect(UNKNOWN_IP_HASH).toMatch(/^.{16}$/);

    // 不同 IP 返不同结果
    const c = await sha256ClientIp("5.6.7.8");
    expect(c).not.toBe(a);
  });
});

describe("rate-limit.checkRateLimitByIp (M6.6)", () => {
  let fakeDB: ReturnType<typeof makeFakeDB>;
  let d1: D1Database;

  beforeEach(() => {
    fakeDB = makeFakeDB();
    d1 = fakeDB.db;
  });

  it("happy: 2 行 old + 1 行 new（同 clientIpHash）→ COUNT=2，not locked", async () => {
    const now = 1_000_000;
    // 直接 mock rows（Task 1 不动 recordAttempt 签名 — 用 opts.rows 注入）
    fakeDB = makeFakeDB({
      rows: [
        { id: "1", identifier: "t1", client_ip: "ip1hash", attempt_type: "admin", succeeded: 0, created_at: now + 1 },
        { id: "2", identifier: "t2", client_ip: "ip1hash", attempt_type: "admin", succeeded: 0, created_at: now + 2 },
      ],
    });
    d1 = fakeDB.db;

    const r = await checkRateLimitByIp(d1, "ip1hash", "admin", now + 100);
    expect(r.locked).toBe(false);
    expect(r.retry_after).toBe(0);
  });

  it("锁: 5 行 failed 都在窗口内 → COUNT=5，locked + retry_after > 0", async () => {
    const now = 1_000_000;
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      identifier: `t${i}`,
      client_ip: "ip1hash",
      attempt_type: "admin" as const,
      succeeded: 0,
      created_at: now + i,
    }));
    fakeDB = makeFakeDB({ rows });
    d1 = fakeDB.db;

    const r = await checkRateLimitByIp(d1, "ip1hash", "admin", now);
    expect(r.locked).toBe(true);
    expect(r.retry_after).toBeGreaterThan(0);
  });

  it("clientIpHash 不匹配 → 0 命中 not locked", async () => {
    const now = 1_000_000;
    fakeDB = makeFakeDB({
      rows: [
        { id: "1", identifier: "t1", client_ip: "ip1hash", attempt_type: "admin", succeeded: 0, created_at: now + 1 },
        { id: "2", identifier: "t2", client_ip: "ip2hash", attempt_type: "admin", succeeded: 0, created_at: now + 2 },
      ],
    });
    d1 = fakeDB.db;

    const r = await checkRateLimitByIp(d1, "ip3hash", "admin", now + 100);
    expect(r.locked).toBe(false);
    expect(r.retry_after).toBe(0);
  });
});

describe("rate-limit.checkRateLimitDual (M6.6)", () => {
  let fakeDB: ReturnType<typeof makeFakeDB>;
  let d1: D1Database;

  beforeEach(() => {
    fakeDB = makeFakeDB();
    d1 = fakeDB.db;
  });

  it("双层未锁: per-token COUNT=2 / per-ip COUNT=2 → not locked", async () => {
    const now = 1_000_000;
    // 2 行同 identifier + 2 行同 client_ip（部分重叠）
    fakeDB = makeFakeDB({
      rows: [
        { id: "1", identifier: "token1", client_ip: "ip1", attempt_type: "admin", succeeded: 0, created_at: now + 1 },
        { id: "2", identifier: "token1", client_ip: "ip2", attempt_type: "admin", succeeded: 0, created_at: now + 2 },
      ],
    });
    d1 = fakeDB.db;

    const r = await checkRateLimitDual(d1, "token1", "ip1", "admin", now + 100);
    expect(r.locked).toBe(false);
    expect(r.retry_after).toBe(0);
  });

  it("per-token 锁: per-token COUNT=5 / per-ip COUNT=2 → locked, retry_after = per-token 的", async () => {
    const now = 1_000_000;
    const tokenRows = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`,
      identifier: "token1",
      client_ip: `ip${i}`,
      attempt_type: "admin" as const,
      succeeded: 0,
      created_at: now + i,
    }));
    fakeDB = makeFakeDB({ rows: tokenRows });
    d1 = fakeDB.db;

    const r = await checkRateLimitDual(d1, "token1", "ip99", "admin", now);
    expect(r.locked).toBe(true);
    // per-token oldest = now + 0 → retry_after = ceil((now + 0 + 900_000 - now) / 1000) = 900
    expect(r.retry_after).toBe(900);
  });

  it("per-IP 锁: per-token COUNT=2 / per-ip COUNT=5 → locked, retry_after = per-IP 的", async () => {
    const now = 1_000_000;
    const ipRows = Array.from({ length: 5 }, (_, i) => ({
      id: `i${i}`,
      identifier: `t${i}`,
      client_ip: "ip1",
      attempt_type: "admin" as const,
      succeeded: 0,
      created_at: now + i,
    }));
    fakeDB = makeFakeDB({ rows: ipRows });
    d1 = fakeDB.db;

    const r = await checkRateLimitDual(d1, "t99", "ip1", "admin", now);
    expect(r.locked).toBe(true);
    // per-IP oldest = now + 0 → retry_after = 900
    expect(r.retry_after).toBe(900);
  });

  it("双层都锁: per-token COUNT=5 / per-ip COUNT=5 → locked, retry_after = max(两维度)", async () => {
    const now = 1_000_000;
    // per-token: 5 行 identifier="token1", client_ip 各不同
    // per-ip: 5 行 client_ip="ip1", identifier 各不同
    // 共享 1 行: identifier="token1", client_ip="ip1"
    const rows = [
      { id: "1", identifier: "token1", client_ip: "ip1", attempt_type: "admin" as const, succeeded: 0, created_at: now + 0 },
      { id: "2", identifier: "token1", client_ip: "ip2", attempt_type: "admin" as const, succeeded: 0, created_at: now + 1 },
      { id: "3", identifier: "token1", client_ip: "ip3", attempt_type: "admin" as const, succeeded: 0, created_at: now + 2 },
      { id: "4", identifier: "token1", client_ip: "ip4", attempt_type: "admin" as const, succeeded: 0, created_at: now + 3 },
      { id: "5", identifier: "token1", client_ip: "ip5", attempt_type: "admin" as const, succeeded: 0, created_at: now + 4 },
      { id: "6", identifier: "t2", client_ip: "ip1", attempt_type: "admin" as const, succeeded: 0, created_at: now + 5 },
      { id: "7", identifier: "t3", client_ip: "ip1", attempt_type: "admin" as const, succeeded: 0, created_at: now + 6 },
      { id: "8", identifier: "t4", client_ip: "ip1", attempt_type: "admin" as const, succeeded: 0, created_at: now + 7 },
      { id: "9", identifier: "t5", client_ip: "ip1", attempt_type: "admin" as const, succeeded: 0, created_at: now + 8 },
    ];
    fakeDB = makeFakeDB({ rows });
    d1 = fakeDB.db;

    const r = await checkRateLimitDual(d1, "token1", "ip1", "admin", now);
    expect(r.locked).toBe(true);
    // per-token oldest = now + 0 → retry_after = 900
    // per-IP oldest = now + 0 → retry_after = 900
    // max = 900
    expect(r.retry_after).toBe(900);
  });
});
