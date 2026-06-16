/**
 * M6.3c /user/nickname 路由测试（spec §5/§9）。
 *
 * 测试策略（混合 miniflare + unit）：与 auth.test.ts 相同的 miniflare bundle 模式。
 * - /user/nickname 走 miniflare bundle（无外网，纯本地逻辑）
 * - 测试用 /auth/wx-login 拿 jwt（mock fetchImpl 返 openid）
 *
 * 5 用例：
 * 1. PATCH 200: jwt 合法 + nickname 合法 → DB user.nickname 写入
 * 2. PATCH 401: 缺 Authorization header
 * 3. PATCH 400: 缺 nickname 字段
 * 4. PATCH 400: nickname 21 字符
 * 5. PATCH 400: nickname = "   " (trim 后空)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Miniflare } from "miniflare";
import { readFile, mkdir, rm } from "fs/promises";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
void createRequire(require.resolve("miniflare"));

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const SRC_ENTRY = resolve(__dirname, "../../src/index.ts");
const BUNDLE_DIR = resolve(__dirname, "../../.test-bundle-user");
const BUNDLE_PATH = join(BUNDLE_DIR, "worker.mjs");

const JWT_SECRET = "test-jwt-secret-at-least-32-bytes-long-xxx";
const ADMIN_TOKEN = "test-admin-token-please-change";
const FAKE_OPENID = "mock_openid_001";

async function applyMigrations(d1: D1Database) {
  const { splitSqlIntoStatements } = await import("../sql-split.js");
  // /user/nickname 需要 0001_init.sql（user 表）+ 0005_login_attempt.sql（M6.3a）+ 0006（M6.3b）
  for (const f of [
    "0001_init.sql",
    "0005_login_attempt.sql",
    "0006_user_session_key.sql",
  ]) {
    const sql = await readFile(resolve(MIGRATIONS_DIR, f), "utf-8");
    for (const stmt of splitSqlIntoStatements(sql)) {
      await d1.exec(stmt);
    }
  }
}

describe("/user/nickname route (Miniflare + D1 + mock fetchImpl)", () => {
  let mf: Miniflare;
  // mock fetch：拦截 jscode2session URL → 返 openid
  const mockFetch: typeof fetch = (async (
    url: string | URL | Request,
  ): Promise<Response> => {
    const u = typeof url === "string" ? new URL(url) : new URL((url as Request).url);
    if (u.hostname === "api.weixin.qq.com" && u.pathname === "/sns/jscode2session") {
      return new Response(
        JSON.stringify({ openid: FAKE_OPENID, session_key: "mock_session_key" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not mocked", { status: 404 });
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
        AUTH_MODE: "jwt",  // M6.3c 测 jwt 路径
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
    // 每个用例前清空 user 表
    const d1 = await mf.getD1Database("DB");
    await d1.exec("DELETE FROM user");
    await d1.exec("DELETE FROM login_attempt");
  });

  // helper: 直接 signJwt 拿 user token（绕开 /auth/wx-login，miniflare bundle
  // 模式 dispatchFetch 没传 fetchImpl binding，jscode2session 必失败）
  async function getWxJwt(userId: string = "01HUSER0000000000000000000"): Promise<string> {
    const { signJwt } = await import("../../src/lib/auth-jwt.js");
    return signJwt({ userId, isAdmin: false }, JWT_SECRET);
  }

  // helper: seed 1 fake user 到 D1（让 UPDATE WHERE id=? 命中 1 row）
  async function seedUser(userId: string = "01HUSER0000000000000000000"): Promise<void> {
    const d1 = await mf.getD1Database("DB");
    await d1
      .prepare(
        "INSERT INTO user (id, wx_openid, nickname, created_at) VALUES (?, ?, NULL, ?)",
      )
      .bind(userId, `openid_${userId}`, Date.now())
      .run();
  }

  it("PATCH /user/nickname 200: jwt 合法 + nickname 合法 → DB 写入", async () => {
    await seedUser();
    const jwt = await getWxJwt();
    const res = await mf.dispatchFetch("http://localhost/user/nickname", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ nickname: "张三" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nickname: string };
    expect(body.nickname).toBe("张三");

    // 验证 D1 user.nickname 写入
    const d1 = await mf.getD1Database("DB");
    const row = await d1
      .prepare("SELECT nickname FROM user WHERE id = ?")
      .bind("01HUSER0000000000000000000")
      .first<{ nickname: string | null }>();
    expect(row?.nickname).toBe("张三");
  });

  it("PATCH /user/nickname 401: 缺 Authorization → MISSING_BEARER", async () => {
    const res = await mf.dispatchFetch("http://localhost/user/nickname", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "李四" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MISSING_BEARER");
  });

  it("PATCH /user/nickname 400: body 缺 nickname → MISSING_NICKNAME", async () => {
    const jwt = await getWxJwt();
    const res = await mf.dispatchFetch("http://localhost/user/nickname", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MISSING_NICKNAME");
  });

  it("PATCH /user/nickname 400: nickname 21 字符 → NICKNAME_TOO_LONG", async () => {
    const jwt = await getWxJwt();
    const res = await mf.dispatchFetch("http://localhost/user/nickname", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ nickname: "a".repeat(21) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NICKNAME_TOO_LONG");
  });

  it("PATCH /user/nickname 400: nickname = '   ' (trim 后空) → NICKNAME_EMPTY", async () => {
    const jwt = await getWxJwt();
    const res = await mf.dispatchFetch("http://localhost/user/nickname", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ nickname: "   " }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NICKNAME_EMPTY");
  });
});
