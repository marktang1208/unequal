/**
 * M6.1 /sessions 路由测试（spec §3.3）。
 *
 * miniflare + bundle + undici（同 chat.test.ts setup），覆盖 4 个 endpoint + 鉴权。
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

const require = createRequire(import.meta.url);
const miniflareRequire = createRequire(require.resolve("miniflare"));
const undici: any = miniflareRequire("undici");

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const SRC_ENTRY = resolve(__dirname, "../../src/index.ts");
const BUNDLE_DIR = resolve(__dirname, "../../.test-bundle-sessions");
const BUNDLE_PATH = join(BUNDLE_DIR, "worker.mjs");

const USER_ID = "01H0000000000000000000000";

async function applyMigrations(d1: D1Database) {
  const { splitSqlIntoStatements } = await import("../sql-split.js");
  for (const f of ["0001_init.sql", "0002_dev_seed.sql", "0003_query_cache.sql", "0004_chat_session.sql"]) {
    const sql = await readFile(resolve(MIGRATIONS_DIR, f), "utf-8");
    for (const stmt of splitSqlIntoStatements(sql)) {
      await d1.exec(stmt);
    }
  }
}

describe("/sessions route (Miniflare + D1)", () => {
  let mf: Miniflare;
  let mockAgent: InstanceType<typeof undici.MockAgent>;
  let prevDispatcher: ReturnType<typeof undici.getGlobalDispatcher>;
  const SESSION_ID = "01HTEST000000000000000000";

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

    mockAgent = new undici.MockAgent();
    mockAgent.disableNetConnect();
    prevDispatcher = undici.getGlobalDispatcher();
    undici.setGlobalDispatcher(mockAgent);

    mf = new Miniflare({
      scriptPath: BUNDLE_PATH,
      modules: true,
      compatibilityFlags: ["nodejs_compat"],
      compatibilityDate: "2025-01-01",
      d1Databases: ["DB"],
      d1Persist: false,
      r2Buckets: ["R2"],
      vectorize: ["VECTORIZE"],
      fetchMock: mockAgent as any,
      bindings: {
        ADMIN_TOKEN: "test-token",
        MINIMAX_API_KEY: "test-key",
        MINIMAX_BASE_URL: "http://mock.local",
        ENVIRONMENT: "test",
        ALLOWED_ORIGIN: "*",
        AUTH_MODE: "admin_token",
      },
    } as unknown as ConstructorParameters<typeof Miniflare>[0]);

    const d1 = await mf.getD1Database("DB");
    await applyMigrations(d1);
  }, 60_000);

  afterAll(async () => {
    if (mf) await mf.dispose();
    if (prevDispatcher) undici.setGlobalDispatcher(prevDispatcher);
    if (mockAgent) await mockAgent.close();
    await rm(BUNDLE_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const d1 = await mf.getD1Database("DB");
    await d1.exec("DELETE FROM chat_session");
  });

  it("GET /sessions 200: 返 sessions 列表（先 seed 2 条）", async () => {
    const d1 = await mf.getD1Database("DB");
    const now = Date.now();
    await d1
      .prepare(
        `INSERT INTO chat_session (id, user_id, title, created_at, last_active_at, degraded_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .bind(SESSION_ID, USER_ID, "宝宝发烧", now - 1000, now)
      .run();
    await d1
      .prepare(
        `INSERT INTO chat_session (id, user_id, title, created_at, last_active_at, degraded_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .bind("01HSECOND0000000000000000", USER_ID, "辅食添加", now - 2000, now - 100)
      .run();

    const res = await mf.dispatchFetch("http://localhost/sessions", {
      method: "GET",
      headers: { authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ id: string; title: string }> };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]!.id).toBe(SESSION_ID); // last_active_at DESC
    expect(body.sessions[0]!.title).toBe("宝宝发烧");
  });

  it("PATCH /sessions/:id 200: 改 title", async () => {
    const d1 = await mf.getD1Database("DB");
    const now = Date.now();
    await d1
      .prepare(
        `INSERT INTO chat_session (id, user_id, title, created_at, last_active_at, degraded_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .bind(SESSION_ID, USER_ID, "旧标题", now, now)
      .run();

    const res = await mf.dispatchFetch(`http://localhost/sessions/${SESSION_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ title: "新标题" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // verify DB
    const row = await d1
      .prepare(`SELECT title FROM chat_session WHERE id = ?`)
      .bind(SESSION_ID)
      .first<{ title: string }>();
    expect(row!.title).toBe("新标题");
  });

  it("DELETE /sessions/:id 200: 标 degraded_at", async () => {
    const d1 = await mf.getD1Database("DB");
    const now = Date.now();
    await d1
      .prepare(
        `INSERT INTO chat_session (id, user_id, title, created_at, last_active_at, degraded_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .bind(SESSION_ID, USER_ID, "待删", now, now)
      .run();

    const res = await mf.dispatchFetch(`http://localhost/sessions/${SESSION_ID}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // verify DB 标 degraded_at
    const row = await d1
      .prepare(`SELECT degraded_at FROM chat_session WHERE id = ?`)
      .bind(SESSION_ID)
      .first<{ degraded_at: number | null }>();
    expect(row!.degraded_at).not.toBeNull();
  });

  it("GET /sessions 401: 缺 token", async () => {
    const res = await mf.dispatchFetch("http://localhost/sessions", { method: "GET" });
    expect(res.status).toBe(401);
  });
});
