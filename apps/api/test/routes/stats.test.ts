/**
 * M6.5 GET /stats/login-attempts 测试套件（spec §6.1 + §9.3 + plan §4 Task 3a）。
 *
 * 7 用例：
 * 1. happy empty: 空表 → total 0 + by_hour 24 桶全 0
 * 2. happy mixed: 24h 内混合 admin/wx_code × failed/succeeded → 正确聚合
 * 3. 跨小时聚合: created_at 散落在 3 个不同 hour → by_hour 正确按 hour 分桶
 * 4. 401 missing token: 无 Authorization → 401
 * 5. hours clamp: hours=999 → 168; hours=0 → 1; hours=abc → 24
 * 6. hours=1 边界: by_hour 长度 === 1
 * 7. hours 缺省: 不传 query → 默认 24
 *
 * 测试策略：直接调 statsRoute.GET_LOGIN_ATTEMPTS + fakeDB (spy prepare/bind/all)。
 * 鉴权：admin_token 模式（test ADMIN_TOKEN），绕过 jwt 验签复杂度。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { statsRoute } from "../../src/routes/stats.js";
import type { Env } from "../../src/types.js";

const ADMIN_TOKEN = "test-admin-token-stats";

function makeFakeDB(
  byTypeRows: Array<{ attempt_type: string; failed: number; succeeded: number }>,
  byHourRows: Array<{ hour_ts: number; failed: number; succeeded: number }>,
) {
  let preparedSQLs: string[] = [];
  return {
    db: {
      prepare: (sql: string) => {
        preparedSQLs.push(sql);
        return {
          bind: (_cutoff: number) => ({
            all: async () => {
              // 第一次 prepare = by_type, 第二次 = by_hour
              if (sql.includes("GROUP BY attempt_type")) {
                return { results: byTypeRows, success: true };
              }
              if (sql.includes("GROUP BY hour_ts")) {
                return { results: byHourRows, success: true };
              }
              return { results: [], success: true };
            },
          }),
        };
      },
    } as unknown as D1Database,
    getPreparedSQLs: () => preparedSQLs,
  };
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    VECTORIZE: {} as VectorizeIndex,
    R2: {} as R2Bucket,
    ADMIN_TOKEN,
    MINIMAX_API_KEY: "test",
    MINIMAX_BASE_URL: "http://mock.local",
    ENVIRONMENT: "test",
    ALLOWED_ORIGIN: "*",
    AUTH_MODE: "admin_token",  // 测试用 admin_token 模式避免 jwt 验签
    JWT_SECRET: "test-jwt-secret-32-bytes-long-please-please",
    WX_APP_ID: "wx_test",
    WX_APP_SECRET: "wx_test_secret",
    CRON_SECRET: "test-cron-secret",
  };
}

function makeRequest(hours?: string): Request {
  const url = hours !== undefined
    ? `http://localhost/stats/login-attempts?hours=${hours}`
    : "http://localhost/stats/login-attempts";
  return new Request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
}

function currentHourTs(): number {
  return Math.floor(Date.now() / 3_600_000) * 3_600_000;
}

describe("statsRoute.GET_LOGIN_ATTEMPTS (M6.5)", () => {
  beforeEach(() => {
    // 每个 test 之间不共享状态
  });

  it("happy empty: 空表 → total 0 + by_type 全 0 + by_hour 24 桶全 0", async () => {
    const fake = makeFakeDB([], []);
    const res = await statsRoute.GET_LOGIN_ATTEMPTS(makeRequest("24"), makeEnv(fake.db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.window_hours).toBe(24);
    expect(body.total_failed).toBe(0);
    expect(body.total_succeeded).toBe(0);
    expect(body.by_type.admin).toEqual({ failed: 0, succeeded: 0 });
    expect(body.by_type.wx_code).toEqual({ failed: 0, succeeded: 0 });
    expect(body.by_hour).toHaveLength(24);
    for (const h of body.by_hour) {
      expect(h.failed).toBe(0);
      expect(h.succeeded).toBe(0);
      expect(typeof h.hour_ts).toBe("number");
    }
    // 第一个 hour_ts 是当前 UTC 整点 - 23h（24 桶从 23h ago 到 current）
    expect(body.by_hour[0].hour_ts).toBe(currentHourTs() - 23 * 3_600_000);
    expect(body.by_hour[23].hour_ts).toBe(currentHourTs());
  });

  it("happy mixed: 24h 内混合 admin/wx_code × failed/succeeded → 正确聚合", async () => {
    const fake = makeFakeDB(
      [
        { attempt_type: "admin", failed: 3, succeeded: 5 },
        { attempt_type: "wx_code", failed: 1, succeeded: 2 },
      ],
      // 3 个不同 hour 的数据
      [
        { hour_ts: currentHourTs() - 3 * 3_600_000, failed: 1, succeeded: 2 },
        { hour_ts: currentHourTs() - 1 * 3_600_000, failed: 2, succeeded: 3 },
        { hour_ts: currentHourTs(), failed: 1, succeeded: 2 },
      ],
    );
    const res = await statsRoute.GET_LOGIN_ATTEMPTS(makeRequest("24"), makeEnv(fake.db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.total_failed).toBe(4);   // 3 + 1
    expect(body.total_succeeded).toBe(7); // 5 + 2
    expect(body.by_type.admin).toEqual({ failed: 3, succeeded: 5 });
    expect(body.by_type.wx_code).toEqual({ failed: 1, succeeded: 2 });

    expect(body.by_hour).toHaveLength(24);
    // 验证 3 个非空桶
    const nonEmpty = body.by_hour.filter((h: any) => h.failed + h.succeeded > 0);
    expect(nonEmpty).toHaveLength(3);
  });

  it("跨小时聚合: created_at 散落在 3 个不同 hour → by_hour 按 hour 整点分桶", async () => {
    // SQL 负责 hour_ts = (created_at/3600000)*3600000 计算；
    // 这里直接测试 buildStats 的补 0 + 索引逻辑：给 3 个不同 hour 的桶
    const fake = makeFakeDB([], [
      { hour_ts: currentHourTs() - 5 * 3_600_000, failed: 4, succeeded: 0 },
      { hour_ts: currentHourTs() - 2 * 3_600_000, failed: 0, succeeded: 6 },
      { hour_ts: currentHourTs(), failed: 1, succeeded: 1 },
    ]);
    const res = await statsRoute.GET_LOGIN_ATTEMPTS(makeRequest("24"), makeEnv(fake.db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    // 验证特定 hour 桶的值
    const h5 = body.by_hour.find((h: any) => h.hour_ts === currentHourTs() - 5 * 3_600_000);
    expect(h5).toEqual({ hour_ts: currentHourTs() - 5 * 3_600_000, failed: 4, succeeded: 0 });

    const h2 = body.by_hour.find((h: any) => h.hour_ts === currentHourTs() - 2 * 3_600_000);
    expect(h2).toEqual({ hour_ts: currentHourTs() - 2 * 3_600_000, failed: 0, succeeded: 6 });

    // 缺失桶补 0
    const h10 = body.by_hour.find((h: any) => h.hour_ts === currentHourTs() - 10 * 3_600_000);
    expect(h10).toEqual({ hour_ts: currentHourTs() - 10 * 3_600_000, failed: 0, succeeded: 0 });
  });

  it("401 missing token: 无 Authorization → UNAUTHORIZED", async () => {
    const fake = makeFakeDB([], []);
    const req = new Request("http://localhost/stats/login-attempts?hours=24", { method: "GET" });
    const res = await statsRoute.GET_LOGIN_ATTEMPTS(req, makeEnv(fake.db));
    expect(res.status).toBe(401);
    // 401 时不应查询 DB
    expect(fake.getPreparedSQLs()).toHaveLength(0);
  });

  it("hours clamp: hours=999 → 168; hours=0 → 1; hours=-5 → 1; hours=abc → 24 fallback", async () => {
    const fake = makeFakeDB([], []);
    const env = makeEnv(fake.db);

    const r1 = await statsRoute.GET_LOGIN_ATTEMPTS(makeRequest("999"), env);
    expect((await r1.json() as any).window_hours).toBe(168);

    const r2 = await statsRoute.GET_LOGIN_ATTEMPTS(makeRequest("0"), env);
    expect((await r2.json() as any).window_hours).toBe(1);

    const r3 = await statsRoute.GET_LOGIN_ATTEMPTS(makeRequest("-5"), env);
    expect((await r3.json() as any).window_hours).toBe(1);

    const r4 = await statsRoute.GET_LOGIN_ATTEMPTS(makeRequest("abc"), env);
    expect((await r4.json() as any).window_hours).toBe(24);  // NaN fallback
  });

  it("hours=1 边界: by_hour 长度 === 1 (只当前 hour)", async () => {
    const fake = makeFakeDB([], []);
    const res = await statsRoute.GET_LOGIN_ATTEMPTS(makeRequest("1"), makeEnv(fake.db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.by_hour).toHaveLength(1);
    expect(body.by_hour[0].hour_ts).toBe(currentHourTs());
  });

  it("hours 缺省: 不传 query 参数 → 默认 24", async () => {
    const fake = makeFakeDB([], []);
    const res = await statsRoute.GET_LOGIN_ATTEMPTS(makeRequest(), makeEnv(fake.db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.window_hours).toBe(24);
    expect(body.by_hour).toHaveLength(24);
  });
});
