import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Miniflare } from "miniflare";
import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { build } from "esbuild";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { createRequire } from "module";
import { fixtureResponse, type FixtureName } from "./llm-fixtures.js";
import { splitSqlIntoStatements } from "./sql-split.js";
import type { SearchResult } from "@unequal/shared/retrieval";

// undici 装在 pnpm 根 node_modules；用 createRequire 避开 api 包 module resolution
const require = createRequire(import.meta.url);
const undici: any = require("undici");

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");
const SRC_ENTRY = resolve(__dirname, "../src/index.ts");
// ask.test 与 integration.test 并行跑，bundle 路径必须分开以避免 race condition
// （rm -rf .test-bundle 时另一个 suite 正在 load bundle → parse error）
const BUNDLE_DIR = resolve(__dirname, "../.test-bundle-ask");
const BUNDLE_PATH = join(BUNDLE_DIR, "worker.mjs");

const DEFAULT_USER_ID = "01H0000000000000000000000";
const VEC_DIM = 1024;
// 用 127.0.0.1 是真地址，会被 undici 解析成真连接；用 all-valid invalid TLD 不会真解析。
// 但 MockAgent 实际是按 origin 字符串比较，跟 TLD 真假无关；用 127.0.0.1 不行（会真打），
// 用 192.0.2.0/24 (TEST-NET-1) 也不可及。最稳是用一个名字不依赖 DNS 的占位符。
const MINIMAX_HOST = "http://mock-minimax.local";

/** 复用 4 个 fake hits，对应 0002 真实 seed chunk */
const FAKE_HITS: SearchResult[] = [
  { chunkId: "01HCCCAAAA00000000000001", vectorizeScore: 0.95, finalScore: 0.95 * 1.3, trustLevel: 3 },
  { chunkId: "01HCCCAAAA00000000000003", vectorizeScore: 0.90, finalScore: 0.90 * 1.1, trustLevel: 2 },
  { chunkId: "01HCCCAAAA00000000000002", vectorizeScore: 0.85, finalScore: 0.85 * 1.3, trustLevel: 3 },
  { chunkId: "01HCCCAAAA00000000000004", vectorizeScore: 0.80, finalScore: 0.80 * 1.1, trustLevel: 2 },
];

let currentFixture: FixtureName = "happy";

/** 4 个不同方向的 1024-dim 向量；让 query (seed=1) 偏向 chunk 1 */
function fakeVec(seed: number): number[] {
  const v = new Array(VEC_DIM);
  for (let i = 0; i < VEC_DIM; i++) {
    v[i] = Math.sin(i * 0.01 + seed) * 0.1 + (i === 0 ? seed * 0.1 : 0);
  }
  return v;
}

/**
 * M2 Task 8 v2 / 9 / 10: /ask 集成测试套件。
 * DI 重构后 runAsk(searchFn) 替代 searchChunks(env.VECTORIZE, …)，
 * 测试通过 body.__hits 注入 fake SearchResult[]；
 * undici MockAgent 拦截 worker 内 globalThis.fetch（生产路径不变）。
 */
describe("/ask integration (Miniflare + undici MockAgent + __hits DI)", () => {
  let mf: Miniflare;
  let mockAgent: InstanceType<typeof undici.MockAgent>;
  let prevDispatcher: ReturnType<typeof undici.getGlobalDispatcher>;

  beforeAll(async () => {
    // 1) bundle TS → ESM
    await rm(BUNDLE_DIR, { recursive: true, force: true });
    await mkdir(BUNDLE_DIR, { recursive: true });
    const NODE_BUILTINS = new Set([
      "fs",
      "http",
      "https",
      "url",
      "path",
      "stream",
      "buffer",
      "crypto",
      "zlib",
      "os",
      "util",
      "events",
    ]);
    const externalNodePlugin = {
      name: "external-node-builtins",
      setup(b: import("esbuild").PluginBuild) {
        b.onResolve({ filter: /^node:/ }, (args) => ({
          path: args.path,
          external: true,
        }));
        b.onResolve({ filter: /^[a-z]+$/ }, (args) => {
          if (NODE_BUILTINS.has(args.path)) {
            return { path: args.path, external: true };
          }
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

    // 2) undici MockAgent: 主进程拦截器；handler 闭包读 currentFixture
    mockAgent = new undici.MockAgent();
    mockAgent.disableNetConnect();
    prevDispatcher = undici.getGlobalDispatcher();
    undici.setGlobalDispatcher(mockAgent);
    // 永久拦截器：origin 一旦匹配，handler 总是读 currentFixture
    // MockAgent 内部对 origin 做 lowercase 比较；用小写 host 保证匹配。
    // undici MockAgent.reply 的 body 参数是 string/Buffer/object，不是 Response 对象。
    // fixtureResponse 返回的 Response 序列化为空对象 {}，必须 .text() 拿 JSON 串。
    const mockPool = mockAgent.get("http://mock-minimax.local");
    mockPool
      .intercept({ method: "POST", path: "/embeddings" })
      .reply(200, async () => {
        return JSON.stringify({ data: [{ embedding: fakeVec(1) }] });
      }, { headers: { "content-type": "application/json" } })
      .persist();
    mockPool
      .intercept({ method: "POST", path: "/v1/chat/completions" })
      .reply(200, async () => {
        return await fixtureResponse(currentFixture).text();
      }, { headers: { "content-type": "application/json" } })
      .persist();

    // 3) Miniflare: fetchMock = mockAgent；DI 重构后不需要 vectorize binding
    mf = new Miniflare({
      scriptPath: BUNDLE_PATH,
      modules: true,
      compatibilityFlags: ["nodejs_compat"],
      compatibilityDate: "2025-01-01",
      d1Databases: ["DB"],
      d1Persist: false,
      r2Buckets: ["R2"],
      fetchMock: mockAgent as any,
      bindings: {
        ADMIN_TOKEN: "test-token",
        MINIMAX_API_KEY: "test-key",
        MINIMAX_BASE_URL: MINIMAX_HOST,
        ENVIRONMENT: "test",
        ALLOWED_ORIGIN: "*",
      },
    } as unknown as ConstructorParameters<typeof Miniflare>[0]);

    // 4) 应用 0001 + 0002 migrations
    const d1 = await mf.getD1Database("DB");
    for (const f of ["0001_init.sql", "0002_dev_seed.sql"]) {
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

  beforeEach(() => {
    currentFixture = "happy";
  });

  it("happy: __hits 注入 4 chunk → verified=[1,3] + answer 含 [来源 1][来源 3] + disclaimer + cached=false", async () => {
    const res = await mf.dispatchFetch("http://localhost/ask", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({
        q: "5个月宝宝发烧38.5怎么办",
        __hits: FAKE_HITS,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answer: string;
      citations: Array<{ n: number }>;
      cached: boolean;
    };
    expect(body.answer).toContain("[来源 1]");
    expect(body.answer).toContain("[来源 3]");
    expect(body.citations.map((c) => c.n).sort()).toEqual([1, 3]);
    expect(body.answer).toContain("不构成医疗建议");
    expect(body.cached).toBe(false);
  });

  it("no_citation: LLM 不引用 → answer='未在知识库中找到可靠来源' + citations=[]", async () => {
    currentFixture = "no_citation";
    const res = await mf.dispatchFetch("http://localhost/ask", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ q: "5个月宝宝发烧38.5", __hits: FAKE_HITS }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; citations: unknown[] };
    expect(body.answer.startsWith("未在知识库中找到可靠来源")).toBe(true);
    expect(body.citations).toEqual([]);
    expect(body.answer).toContain("不构成医疗建议");
  });

  it("cite_mismatch: 文本引 1 但 JSON 引 2 → 降级", async () => {
    currentFixture = "cite_mismatch";
    const res = await mf.dispatchFetch("http://localhost/ask", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ q: "5个月宝宝发烧38.5", __hits: FAKE_HITS }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; citations: unknown[] };
    expect(body.answer.startsWith("未在知识库中找到可靠来源")).toBe(true);
    expect(body.citations).toEqual([]);
  });

  it("malformed_json: JSON 坏 → 降级", async () => {
    currentFixture = "malformed_json";
    const res = await mf.dispatchFetch("http://localhost/ask", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ q: "5个月宝宝发烧38.5", __hits: FAKE_HITS }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; citations: unknown[] };
    expect(body.answer.startsWith("未在知识库中找到可靠来源")).toBe(true);
    expect(body.citations).toEqual([]);
  });
});
