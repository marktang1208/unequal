import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeCache, readCache, hashQ } from "../src/lib/cache.js";
import { splitSqlIntoStatements } from "./sql-split.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

/** In-memory Vectorize mock: 存储向量 + 简单 cosine 相似度 query */
class FakeVectorize {
  private store: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];

  async upsert(
    vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>,
  ): Promise<{ mutationId: string }> {
    for (const v of vectors) {
      const existing = this.store.findIndex((s) => s.id === v.id);
      if (existing >= 0) this.store[existing] = { id: v.id, values: v.values, metadata: v.metadata ?? {} };
      else this.store.push({ id: v.id, values: v.values, metadata: v.metadata ?? {} });
    }
    return { mutationId: "fake-mutation" };
  }

  async query(
    vector: number[],
    opts: { topK?: number; returnMetadata?: boolean; filter?: Record<string, unknown> },
  ): Promise<{
    matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }>;
  }> {
    const topK = opts.topK ?? 5;
    const scored = this.store
      .filter((s) => {
        if (!opts.filter) return true;
        return Object.entries(opts.filter).every(([k, v]) => {
          if (v && typeof v === "object" && "$gte" in (v as object)) {
            return Number(s.metadata[k]) >= Number((v as { $gte: number }).$gte);
          }
          return s.metadata[k] === v;
        });
      })
      .map((s) => ({
        id: s.id,
        score: cosine(vector, s.values),
        metadata: opts.returnMetadata ? s.metadata : undefined,
      }));
    scored.sort((a, b) => b.score - a.score);
    return { matches: scored.slice(0, topK) };
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("cache (Miniflare D1 + fake Vectorize)", () => {
  let mf: Miniflare;
  let d1: D1Database;
  const vectorize = new FakeVectorize();

  beforeAll(async () => {
    mf = new Miniflare({
      script: "export default { async fetch() { return new Response('ok'); } }",
      modules: true,
      compatibilityFlags: ["nodejs_compat"],
      compatibilityDate: "2025-01-01",
      d1Databases: ["DB"],
      d1Persist: false,
      bindings: {
        ADMIN_TOKEN: "test-token",
        MINIMAX_API_KEY: "test-key",
        MINIMAX_BASE_URL: "http://test.invalid",
        ENVIRONMENT: "test",
        ALLOWED_ORIGIN: "*",
      },
    } as unknown as ConstructorParameters<typeof Miniflare>[0]);
    d1 = await mf.getD1Database("DB");
    for (const f of ["0001_init.sql", "0002_dev_seed.sql", "0003_query_cache.sql"]) {
      const sql = await readFile(resolve(MIGRATIONS_DIR, f), "utf-8");
      for (const stmt of splitSqlIntoStatements(sql)) {
        await d1.exec(stmt);
      }
    }
  });

  afterAll(async () => {
    await mf.dispose();
  });

  it("hashQ: 同 q 同一 hash", () => {
    const h1 = hashQ("5个月宝宝发烧38.5");
    const h2 = hashQ("5个月宝宝发烧38.5");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{16}$/);
  });

  it("readCache: 无缓存 → null", async () => {
    const fakeVec = new Array(1024).fill(0).map((_, i) => Math.sin(i) * 0.01);
    const got = await readCache({
      d1,
      vectorize: vectorize as unknown as VectorizeIndex,
      userId: "01H0000000000000000000000",
      q: "完全没缓存的问题",
      qEmbedding: fakeVec,
    });
    expect(got).toBeNull();
  });

  it("writeCache → readCache: 命中", async () => {
    const fakeVec = new Array(1024).fill(0).map((_, i) => Math.sin(i) * 0.01);
    await writeCache({
      d1,
      vectorize: vectorize as unknown as VectorizeIndex,
      userId: "01H0000000000000000000000",
      q: "测试缓存的问题",
      qEmbedding: fakeVec,
      answer: "测试答案 + disclaimer",
      verified: [1, 3],
    });
    const got = await readCache({
      d1,
      vectorize: vectorize as unknown as VectorizeIndex,
      userId: "01H0000000000000000000000",
      q: "测试缓存的问题",
      qEmbedding: fakeVec,
    });
    expect(got).not.toBeNull();
    expect(got!.answer).toBe("测试答案 + disclaimer");
    expect(got!.verified).toEqual([1, 3]);
  });

  it("readCache: 过期（>30 天）→ null", async () => {
    const fakeVec = new Array(1024).fill(0).map((_, i) => Math.cos(i) * 0.01);
    const id = "01HCCCCCCCCCCCCCCCCCCCC00";
    // 直接 INSERT 过期行（expires_at=0 < now）
    await d1
      .prepare(
        `INSERT INTO query_cache (id, user_id, q, q_embedding, answer, verified, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        "01H0000000000000000000000",
        "过期问题",
        new Uint8Array(fakeVec.map((x) => Math.round(x * 1000))),
        "旧答案",
        "[]",
        0,
        0,
      )
      .run();
    // 还要把这个 vector 注入 fakeVectorize 让 readCache 能查到 top1
    await (vectorize as unknown as FakeVectorize).upsert([
      {
        id: `cache_${id}`,
        values: fakeVec,
        metadata: {
          is_cached: true,
          cache_id: id,
          user_id: "01H0000000000000000000000",
          q_hash: hashQ("过期问题"),
        },
      },
    ]);
    const got = await readCache({
      d1,
      vectorize: vectorize as unknown as VectorizeIndex,
      userId: "01H0000000000000000000000",
      q: "过期问题",
      qEmbedding: fakeVec,
    });
    expect(got).toBeNull();
  });
});
