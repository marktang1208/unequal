/**
 * M6.1 /chat route 集成测试（spec §3.2）。
 *
 * 策略：用 miniflare bundle 整个 src/index.ts（跟 ask.test.ts 一致），
 * 走真实路由层 + verifyAuth + runChat，验证 HTTP 状态码 + 错误码 + ChatResponse 形状。
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
import type { SearchResult } from "@unequal/shared/retrieval";

const require = createRequire(import.meta.url);
const miniflareRequire = createRequire(require.resolve("miniflare"));
const undici: any = miniflareRequire("undici");

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const SRC_ENTRY = resolve(__dirname, "../../src/index.ts");
// 独立 bundle 路径避免与 ask.test.ts race condition
const BUNDLE_DIR = resolve(__dirname, "../../.test-bundle-chat");
const BUNDLE_PATH = join(BUNDLE_DIR, "worker.mjs");

const VEC_DIM = 1024;
const MINIMAX_HOST = "http://mock-minimax.local";

const FAKE_HITS: SearchResult[] = [
  { chunkId: "01HCCCAAAA00000000000001", vectorizeScore: 0.95, finalScore: 0.95 * 1.3, trustLevel: 3 },
  { chunkId: "01HCCCAAAA00000000000002", vectorizeScore: 0.9, finalScore: 0.9 * 1.1, trustLevel: 2 },
];

const ANSWER_TEXT =
  '5个月宝宝腋温 38.5°C 建议先物理降温 [来源 1] [来源 2]\n\n{"citations":[1,2]}\n\n不构成医疗建议';

function fakeVec(seed: number): number[] {
  const v = new Array(VEC_DIM);
  for (let i = 0; i < VEC_DIM; i++) {
    v[i] = Math.sin(i * 0.01 + seed) * 0.1 + (i === 0 ? seed * 0.1 : 0);
  }
  return v;
}

describe("/chat route (Miniflare + undici MockAgent)", () => {
  let mf: Miniflare;
  let mockAgent: InstanceType<typeof undici.MockAgent>;
  let prevDispatcher: ReturnType<typeof undici.getGlobalDispatcher>;

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
    const pool = mockAgent.get(MINIMAX_HOST);
    pool
      .intercept({ method: "POST", path: "/embeddings" })
      .reply(200, async () => {
        return JSON.stringify({ data: [{ embedding: fakeVec(1) }] });
      }, { headers: { "content-type": "application/json" } })
      .persist();
    pool
      .intercept({ method: "POST", path: "/v1/chat/completions" })
      .reply(200, async () => {
        return JSON.stringify({ choices: [{ message: { content: ANSWER_TEXT } }] });
      }, { headers: { "content-type": "application/json" } })
      .persist();

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
        MINIMAX_BASE_URL: MINIMAX_HOST,
        ENVIRONMENT: "test",
        ALLOWED_ORIGIN: "*",
        AUTH_MODE: "admin_token",
      },
    } as unknown as ConstructorParameters<typeof Miniflare>[0]);

    // 应用 0001-0004 migrations
    const d1 = await mf.getD1Database("DB");
    const { splitSqlIntoStatements } = await import("../sql-split.js");
    for (const f of ["0001_init.sql", "0002_dev_seed.sql", "0003_query_cache.sql", "0004_chat_session.sql"]) {
      const sql = await readFile(resolve(MIGRATIONS_DIR, f), "utf-8");
      for (const stmt of splitSqlIntoStatements(sql)) {
        await d1.exec(stmt);
      }
    }
  }, 60_000);

  afterAll(async () => {
    if (mf) await mf.dispose();
    if (prevDispatcher) undici.setGlobalDispatcher(prevDispatcher);
    if (mockAgent) await mockAgent.close();
    await rm(BUNDLE_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // 清空 chat_session 表（每个 test 独立）
    const d1 = await mf.getD1Database("DB");
    await d1.exec("DELETE FROM chat_session");
  });

  it("200 happy: POST /chat → 返 ChatResponse 含 session_id", async () => {
    const res = await mf.dispatchFetch("http://localhost/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ q: "5个月宝宝发烧38.5怎么办？", __hits: FAKE_HITS, __noCache: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answer: string;
      citations: unknown[];
      session_id: string;
      is_new_session: boolean;
    };
    expect(body.session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.is_new_session).toBe(true);
    expect(body.answer).toContain("不构成医疗建议");
  });

  it("401: 缺 Authorization header", async () => {
    const res = await mf.dispatchFetch("http://localhost/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "test" }),
    });
    expect(res.status).toBe(401);
  });

  it("401: 错 token", async () => {
    const res = await mf.dispatchFetch("http://localhost/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ q: "test" }),
    });
    expect(res.status).toBe(401);
  });

  it("400: body 缺 q", async () => {
    const res = await mf.dispatchFetch("http://localhost/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MISSING_Q");
  });
});
