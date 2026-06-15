import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Miniflare } from "miniflare";
import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { build } from "esbuild";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { fixtureResponse, type FixtureName } from "./llm-fixtures.js";
import { splitSqlIntoStatements } from "./sql-split.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");
const SRC_ENTRY = resolve(__dirname, "../src/index.ts");
const BUNDLE_DIR = resolve(__dirname, "../.test-bundle");
const BUNDLE_PATH = join(BUNDLE_DIR, "worker.mjs");

const DEFAULT_USER_ID = "01H0000000000000000000000";
const VEC_DIM = 1024;
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
 * M2 Task 8: /ask happy 集成测试 — fetch mock + Vectorize fixture 验证 verifyCitations 通过路径。
 *
 * KNOWN ISSUE: Miniflare v3.20250718.3 不支持 Vectorize local mock：
 * - 没有 `mf.getVectorize()` 方法
 * - Vectorize plugin 不在 dist 中（README 明确说不支持 Analytics Engine / Vectorize 等）
 * - 因此测试套件无法在 setup 阶段 upsert fixture chunks，runAsk 检索会返回 0 hits
 *
 * 真正的解法需要 orchestrator 做架构决策之一：
 * (a) 升级到 Miniflare v4 (4.20260611.0+) — v4 添加了 Vectorize plugin；但需要 Node >=22
 *     且 workerd / wrangler 都要联动升级，pnpm-lock.yaml 会变化
 * (b) 在 src/index.ts 加一个 ENVIRONMENT=test-only 的 /test-seed-vectorize endpoint，
 *     让 Worker 内部调用 VECTORIZE.upsert；这污染产品代码但不需要 lockfile 变化
 * (c) 改 searchChunks 让 vectorize 参数可注入（DI），测试注入一个 in-memory mock；
 *     最干净但属于产品代码重构
 *
 * 当前套件保留完整测试桩（esbuild bundle + D1 migration + fetch mock + dispatchFetch）
 * 给 Task 9 (3 降级测试) 和 Task 10 (鉴权 + 400) 共用：它们都需要同一套 Miniflare + D1
 * setup，只有 Vectorize upsert 这一步在 Task 8 才会被调用。
 */
describe("/ask integration (Miniflare + fetch mock)", () => {
  let mf: Miniflare;
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    originalFetch = globalThis.fetch;

    // mock fetch: /embeddings 返回 query vec，/chat 返回 fixture
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("MiniMax") && url.includes("/embeddings")) {
        return new Response(
          JSON.stringify({ data: [{ embedding: fakeVec(1) }] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("MiniMax") && url.includes("/chat/completions")) {
        return fixtureResponse(currentFixture);
      }
      return originalFetch(input, init);
    };

    // bundle TS → ESM（workerd 不理解 import type）
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

    mf = new Miniflare({
      scriptPath: BUNDLE_PATH,
      modules: true,
      compatibilityFlags: ["nodejs_compat"],
      compatibilityDate: "2025-01-01",
      d1Databases: ["DB"],
      d1Persist: false,
      vectorize: { VECTORIZE: { dimensions: VEC_DIM } },
      r2Buckets: ["R2"],
      bindings: {
        ADMIN_TOKEN: "test-token",
        MINIMAX_API_KEY: "test-key",
        MINIMAX_BASE_URL: "http://MiniMax.invalid",
        ENVIRONMENT: "test",
        ALLOWED_ORIGIN: "*",
      },
    } as unknown as ConstructorParameters<typeof Miniflare>[0]);

    // 应用 0001 + 0002 migrations
    const d1 = await mf.getD1Database("DB");
    for (const f of ["0001_init.sql", "0002_dev_seed.sql"]) {
      const sql = await readFile(resolve(MIGRATIONS_DIR, f), "utf-8");
      for (const stmt of splitSqlIntoStatements(sql)) {
        await d1.exec(stmt);
      }
    }

    // BLOCKED: Vectorize upsert in setup
    // Miniflare v3.20250718.3 不暴露 getVectorize()。Vectorize 必须由 Worker
    // 内部通过 binding 访问；外部无法 upsert fixture chunks。
    // 待 orchestrator 决定升级 Miniflare v4 或注入测试 endpoint 后再启用：
    //
    // const v = await mf.getVectorize("VECTORIZE");
    // await v.upsert([
    //   { id: "01HCCCAAAA00000000000001", values: fakeVec(1), metadata: { ... } },
    //   ...
    // ]);
  }, 60_000);

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    if (mf) await mf.dispose();
    await rm(BUNDLE_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    currentFixture = "happy";
  });

  // BLOCKED: blocked by Vectorize local mock missing in Miniflare v3.20250718.3
  // (see file header). When unblocked, this test should:
  //   1. /ask POST { q: "5个月宝宝发烧38.5" }
  //   2. expect 200, answer 含 [来源 1] [来源 3], citations=[1,3], cached=false
  it.todo("happy: 答案含 [来源 1]/[来源 3] + verified=[1,3] + disclaimer 末尾");
});