/**
 * M6.2 + M6.3a /auth 路由测试（spec §3.3 + §3.4 + M6.3a §5.1/§5.2 + §9.1）。
 *
 * 测试策略（混合 miniflare + unit）：
 * - /auth/admin-login 走 miniflare bundle（不调外网，纯本地逻辑）
 * - /auth/wx-login 走 authRoute.WX_LOGIN 单测（miniflare 不支持把 fetchImpl 注入到 env bindings）
 *   → 测试代码直接构造 env { fetchImpl } 调用 route 处理器
 *
 * M6.2 5 用例：
 * - admin-login 3：200 happy / 401 错 token / 400 缺 admin_token
 * - wx-login 2：200 happy (单测) / 400 缺 code (单测)
 *
 * M6.3a +1 用例：
 * - admin-login 429：5 次错 token 后第 6 次（即使正确）→ 429 RATE_LIMITED 含 retry_after
 *   （wx-login 429 2 用例在 Task 4 添加）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Miniflare } from "miniflare";
import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { build } from "esbuild";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { createRequire } from "module";
import type { Env } from "../../src/types.js";

const require = createRequire(import.meta.url);
const miniflareRequire = createRequire(require.resolve("miniflare"));
// 占位以保 miniflare resolve chain；undici 不需要（不走外网）
void miniflareRequire;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const SRC_ENTRY = resolve(__dirname, "../../src/index.ts");
const BUNDLE_DIR = resolve(__dirname, "../../.test-bundle-auth");
const BUNDLE_PATH = join(BUNDLE_DIR, "worker.mjs");

const JWT_SECRET = "test-jwt-secret-at-least-32-bytes-long-xxx";
const ADMIN_TOKEN = "test-admin-token-please-change";
const FAKE_OPENID = "mock_openid_001";

async function applyMigrations(d1: D1Database) {
  const { splitSqlIntoStatements } = await import("../sql-split.js");
  // /auth 需要 0001_init.sql（user 表）+ 0005_login_attempt.sql（M6.3a rate limit）
  for (const f of ["0001_init.sql", "0005_login_attempt.sql"]) {
    const sql = await readFile(resolve(MIGRATIONS_DIR, f), "utf-8");
    for (const stmt of splitSqlIntoStatements(sql)) {
      await d1.exec(stmt);
    }
  }
}

describe("/auth route (Miniflare + D1 + mock fetchImpl)", () => {
  let mf: Miniflare;
  // mock fetch：拦截 jscode2session URL → 返 openid
  const mockFetch: typeof fetch = (async (
    url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const u = typeof url === "string" ? new URL(url) : new URL((url as Request).url);
    if (
      u.hostname === "api.weixin.qq.com" &&
      u.pathname === "/sns/jscode2session"
    ) {
      return new Response(
        JSON.stringify({ openid: FAKE_OPENID, session_key: "mock_session_key" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not mocked: " + u.pathname, { status: 404 });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    await rm(BUNDLE_DIR, { recursive: true, force: true });
    await mkdir(BUNDLE_DIR, { recursive: true });
    const NODE_BUILTINS = new Set([
      "fs", "http", "https", "url", "path", "stream", "buffer", "crypto", "zlib", "os", "util", "events",
    ]);
    const externalNodePlugin = {
      name: "external-node-builtins",
      setup(b: import("esbuild").PluginBuild) {
        b.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, external: true }));
        b.onResolve({ filter: /^[a-z]+$/ }, (args) => {
          if (NODE_BUILTINS.has(args.path)) return { path: args.path, external: true };
          return null;
        });
      },
    };
    await build({
      entryPoints: [SRC_ENTRY],
      outfile: BUNDLE_PATH,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      resolveExtensions: [".ts", ".js", ".mjs"],
      plugins: [externalNodePlugin],
      external: ["node:*"],
      sourcemap: "inline",
      logLevel: "warning",
    });

    // miniflare setup：仅 admin-login 走 bundle（无外网）
    mf = new Miniflare({
      scriptPath: BUNDLE_PATH,
      modules: true,
      compatibilityFlags: ["nodejs_compat"],
      compatibilityDate: "2025-01-01",
      d1Databases: ["DB"],
      d1Persist: false,
      r2Buckets: ["R2"],
      vectorize: ["VECTORIZE"],
      bindings: {
        ADMIN_TOKEN,
        MINIMAX_API_KEY: "test-key",
        MINIMAX_BASE_URL: "http://mock.local",
        ENVIRONMENT: "test",
        ALLOWED_ORIGIN: "*",
        AUTH_MODE: "admin_token",
        JWT_SECRET,
        WX_APP_ID: "wx_test_app_id",
        WX_APP_SECRET: "wx_test_app_secret",
      },
    } as unknown as ConstructorParameters<typeof Miniflare>[0]);

    const d1 = await mf.getD1Database("DB");
    await applyMigrations(d1);
  }, 60_000);

  afterAll(async () => {
    if (mf) await mf.dispose();
    await rm(BUNDLE_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // 每个用例前清空 user 表（wx-login 单测 create 走 user）+ login_attempt（rate limit 状态）
    const d1 = await mf.getD1Database("DB");
    await d1.exec("DELETE FROM user");
    await d1.exec("DELETE FROM login_attempt");
  });

  // ---------- /auth/admin-login (miniflare bundle) ----------

  it("POST /auth/admin-login 200: 正确 admin_token → 返 { token, user_id, is_admin: true, expires_in: 86400 }", async () => {
    const res = await mf.dispatchFetch("http://localhost/auth/admin-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admin_token: ADMIN_TOKEN }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      user_id: string;
      is_admin: boolean;
      expires_in: number;
    };
    expect(body.user_id).toBe("01H0000000000000000000000");
    expect(body.is_admin).toBe(true);
    expect(body.expires_in).toBe(86400);
    // JWT 形状：3 段 base64url
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("POST /auth/admin-login 401: 错 admin_token → 401 INVALID_ADMIN_TOKEN", async () => {
    const res = await mf.dispatchFetch("http://localhost/auth/admin-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admin_token: "wrong-token" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("INVALID_ADMIN_TOKEN");
  });

  it("POST /auth/admin-login 400: body 缺 admin_token", async () => {
    const res = await mf.dispatchFetch("http://localhost/auth/admin-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MISSING_TOKEN");
  });

  it("POST /auth/admin-login 429: 5 次同 wrong-token 失败后第 6 次 → 429 RATE_LIMITED 含 retry_after", async () => {
    // spec §6：identifier = sha256(admin_token).slice(0,16) — per-token rate limit
    // 5 次用同一 wrong-token → 同一 hash 累计 5 failed
    const WRONG_TOKEN = "wrong-token-xyz";
    for (let i = 0; i < 5; i++) {
      const failRes = await mf.dispatchFetch("http://localhost/auth/admin-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ admin_token: WRONG_TOKEN }),
      });
      expect(failRes.status).toBe(401);
    }
    // 第 6 次同 wrong-token → 应被 rate limit 拦截在 verifyAdminToken 之前
    const blocked = await mf.dispatchFetch("http://localhost/auth/admin-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admin_token: WRONG_TOKEN }),
    });
    expect(blocked.status).toBe(429);
    const blockedBody = (await blocked.json()) as {
      error: string;
      retry_after: number;
      message: string;
    };
    expect(blockedBody.error).toBe("RATE_LIMITED");
    expect(blockedBody.retry_after).toBeGreaterThan(0);
    expect(blockedBody.retry_after).toBeLessThanOrEqual(900);
  });

  // ---------- /auth/wx-login (单测 authRoute.WX_LOGIN，env.fetchImpl 注入) ----------

  it("POST /auth/wx-login 200: mock fetchImpl 返 openid → findOrCreateUser + signJwt", async () => {
    const d1 = await mf.getD1Database("DB");
    const env = {
      ADMIN_TOKEN,
      JWT_SECRET,
      WX_APP_ID: "wx_test_id",
      WX_APP_SECRET: "wx_test_secret",
      DB: d1,
      fetchImpl: mockFetch,
    } as unknown as Env;

    const { authRoute } = await import("../../src/routes/auth.js");
    const res = await authRoute.WX_LOGIN(
      new Request("https://do/auth/wx-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "test_code_081H1z" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      user_id: string;
      is_new_user: boolean;
      expires_in: number;
    };
    expect(body.user_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    expect(body.is_new_user).toBe(true);
    expect(body.expires_in).toBe(86400);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("POST /auth/wx-login 400: body 缺 code → 400 MISSING_CODE", async () => {
    const d1 = await mf.getD1Database("DB");
    const env = {
      ADMIN_TOKEN,
      JWT_SECRET,
      WX_APP_ID: "wx_test_id",
      WX_APP_SECRET: "wx_test_secret",
      DB: d1,
      fetchImpl: mockFetch,
    } as unknown as Env;

    const { authRoute } = await import("../../src/routes/auth.js");
    const res = await authRoute.WX_LOGIN(
      new Request("https://do/auth/wx-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MISSING_CODE");
  });

  // ---------- M6.3a wx-login rate limit (INVALID_CODE 路径) ----------

  it("POST /auth/wx-login 429: 5 次同 code INVALID_CODE 后第 6 次 → 429 RATE_LIMITED", async () => {
    const d1 = await mf.getD1Database("DB");
    // 注入 mock：返 errcode → 抛 INVALID_CODE
    const invalidCodeFetch: typeof fetch = (async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const u = typeof url === "string" ? new URL(url) : new URL((url as Request).url);
      if (u.hostname === "api.weixin.qq.com" && u.pathname === "/sns/jscode2session") {
        return new Response(
          JSON.stringify({ errcode: 40029, errmsg: "invalid code" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not mocked", { status: 404 });
    }) as unknown as typeof fetch;
    const env = {
      ADMIN_TOKEN,
      JWT_SECRET,
      WX_APP_ID: "wx_test_id",
      WX_APP_SECRET: "wx_test_secret",
      DB: d1,
      fetchImpl: invalidCodeFetch,
    } as unknown as Env;

    const { authRoute } = await import("../../src/routes/auth.js");
    const BAD_CODE = "bad_code_5xx";
    // 5 次 INVALID_CODE
    for (let i = 0; i < 5; i++) {
      const failRes = await authRoute.WX_LOGIN(
        new Request("https://do/auth/wx-login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: BAD_CODE }),
        }),
        env,
      );
      expect(failRes.status).toBe(401);
      const fb = (await failRes.json()) as { error: string };
      expect(fb.error).toBe("INVALID_CODE");
    }
    // 第 6 次同 code → 应被 rate limit pre-check 拦截
    const blocked = await authRoute.WX_LOGIN(
      new Request("https://do/auth/wx-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: BAD_CODE }),
      }),
      env,
    );
    expect(blocked.status).toBe(429);
    const blockedBody = (await blocked.json()) as {
      error: string;
      retry_after: number;
      message: string;
    };
    expect(blockedBody.error).toBe("RATE_LIMITED");
    expect(blockedBody.retry_after).toBeGreaterThan(0);
    expect(blockedBody.retry_after).toBeLessThanOrEqual(900);
  });

  it("POST /auth/wx-login 200 happy path: 成功不记 failed attempt（不污染 rate limit 计数）", async () => {
    const d1 = await mf.getD1Database("DB");
    const env = {
      ADMIN_TOKEN,
      JWT_SECRET,
      WX_APP_ID: "wx_test_id",
      WX_APP_SECRET: "wx_test_secret",
      DB: d1,
      fetchImpl: mockFetch, // 返 openid 的 happy path mock
    } as unknown as Env;

    const { authRoute } = await import("../../src/routes/auth.js");
    // 连发 10 次 happy path（同 code 不会撞 5/15min 上限 — 成功路径不计数）
    for (let i = 0; i < 10; i++) {
      const res = await authRoute.WX_LOGIN(
        new Request("https://do/auth/wx-login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "happy_code_xyz" }),
        }),
        env,
      );
      expect(res.status).toBe(200);
    }
    // 验证 login_attempt 表 0 行（spec §5.2：成功路径不记 attempt）
    const countRow = await d1
      .prepare("SELECT COUNT(*) AS c FROM login_attempt")
      .first<{ c: number }>();
    expect(countRow?.c ?? 0).toBe(0);
  });
});
