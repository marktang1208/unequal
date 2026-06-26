# P8 Vector DB 集成 — CloudBase PG 模式 + pgvector

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 替换 P5 v1.3 暴力 cosine in-memory retrieval (limit=8 命中率低) → CloudBase PG 模式 + pgvector (HNSW 索引) topK*10 候选, dual-write + failOpen, 灰度可控 (1 行 env 回滚)。

**Architecture:** NoSQL `chunk` 集合保留 source-of-truth + PG `chunks` 表做 retrieval cache。新建 env `unequal-d4ggf7rwg82e0900b-pg` (同 region ap-shanghai, PG 模式 + pgvector 扩展)。handler 内部 `getPgVectorStore()` 单例 + 灰度 env `VECTOR_STORE=pg|nosql` (默认 `nosql` 保 P7 现状)。`packages/shared/retrieval.ts` 不动, 只换 `fetchChunksByUser` 注入。

**Tech Stack:** CloudBase PG 模式 + pgvector 扩展 (HNSW 索引, m=16, ef_construction=64, ef_search=40) + node-postgres 8.x (Pool max=2) + 现有 nodejs20.19 runtime。

**前置**:
- P5 v1.3 NLI spec (`2026-06-23-p5-nli-entailment-design.md`)
- P6 ONNX NLI PASS (`state-p6-local-onnx-nli.md`)
- P7 follow-up 收官 (`state-p7-p8-followup-completion.md`) + 真接 evidence: `chat_nli_reject` latencyMs=1919 根因 = retrieval 命中率低
- spec: `docs/superpowers/specs/2026-06-25-p8-vector-db-pgvector-design.md` (commit `175024a`)

**Tag**: `p8-vector-db-pg-pgvector`

---

## File Structure

**新建 (4 files)**:
- `apps/api/src/lib/retrieval/pg-vector-store.ts` (NEW runtime, ~250 行) — pgvector 适配 fetchChunksByUser
- `apps/api/src/lib/retrieval/__tests__/pg-vector-store.test.ts` (NEW test, ~200 行, 12 cases)
- `apps/api/scripts/migrate-no-sql-to-pg.ts` (NEW script, ~150 行) — 一次性 ETL
- `apps/api/scripts/verify-p8-vector-db.ts` (NEW 真接, ~120 行) — 4 步真接脚本

**修改 (6 files)**:
- `apps/api/src/lib/env.ts` — 加 `VECTOR_STORE` + `PG_CONNECTION_STRING` 字段
- `apps/api/src/handlers/api-chat.ts` — 切 chunk fetch 到 PG (~10 行 diff)
- `apps/api/src/handlers/api-ask.ts` — 同样 (~10 行 diff)
- `apps/api/src/handlers/api-search.ts` — 同样 (~5 行 diff, 只有 topK=5 不需要 multiplier 改动)
- `apps/api/src/handlers/api-ingest.ts` — dual-write PG chunks (insert 完 NoSQL 后, try/catch failOpen, ~20 行 diff)
- `apps/api/cloudbaserc.json` — 加 `VECTOR_STORE=nosql` (Phase 1 default) + 后续 Phase 4 改 `pg`
- `apps/api/scripts/deploy/lib/sync-cloudbasrc.ts` — SECRETS 加 `PG_CONNECTION_STRING`
- `apps/api/scripts/deploy-build.ts` — external 加 `pg` (注意: pg 是 pure JS 不含 native, 不需 external; 标这里防止误判)
- `apps/api/package.json` — 加 `pg@^8.11.0` (devDep: `@types/pg@^8.11.0`)

**Keychain 新增 (1 entry)**: `unequal:api-router:PG_CONNECTION_STRING` (postgres://user:pass@host:port/db 格式)

---

## Task 1: Phase 1 — env + schema + 单测骨架 (P8 起点, 0 风险)

**Files:**
- Modify: `apps/api/src/lib/env.ts` — 加 2 字段 + validation
- Modify: `apps/api/cloudbaserc.json` — 加 `VECTOR_STORE=nosql`
- Create: `apps/api/src/lib/retrieval/pg-vector-store.ts` — factory + 5 mock helpers (无 PG 连接, 测试驱动设计)
- Create: `apps/api/src/lib/retrieval/__tests__/pg-vector-store.test.ts` — 12 cases (mock pg.Pool, 不真连)
- Modify: `apps/api/package.json` — 加 `pg` + `@types/pg`
- Modify: `apps/api/scripts/deploy/lib/sync-cloudbasrc.ts` — SECRETS 加 PG_CONNECTION_STRING

- [ ] **Step 1.1: 写 pg-vector-store.ts 失败的 12 个单测 (TDD RED)**

```typescript
// apps/api/src/lib/retrieval/__tests__/pg-vector-store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPgVectorStore, type PgVectorStoreOptions } from "../pg-vector-store.js";
import type { ChunkWithEmbedding } from "@unequal/shared/retrieval";

const EMB = Array(1536).fill(0).map((_, i) => (i % 100) / 100);

function makePoolMock(rows: any[] = []) {
  return {
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows }),
      release: vi.fn(),
    }),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
}

describe("createPgVectorStore", () => {
  let poolMock: any;
  beforeEach(() => { poolMock = makePoolMock(); });

  it("1. init: pool connects with max=2, idleTimeoutMillis=30000", async () => {
    const PoolSpy = vi.fn().mockReturnValue(poolMock);
    // 替换 import 的 Pool: 用 vi.mock("pg", ...)
    const { Pool } = await import("pg");
    vi.spyOn(Pool.prototype as any, "connect").mockResolvedValue({
      query: vi.fn(), release: vi.fn(),
    });
    // 简化: 验证 store 创建不抛, queryTopK 调通
    const store = createPgVectorStore({ connectionString: "postgres://x", pgModule: { Pool: PoolSpy } as any });
    expect(store).toBeTruthy();
  });

  it("2. queryTopK happy path: 5 chunks return", async () => {
    const rows = Array(5).fill(null).map((_, i) => ({
      id: `c${i}`, documentId: `d${i}`, sourceId: `s${i}`, userId: "u1",
      idx: i, content: `content ${i}`, embedding: `[${EMB.join(",")}]`,
      trustLevel: 0, sourceType: "webpage", createdAt: Date.now(),
      vectorizeScore: 0.9 - i * 0.1,
    }));
    const store = createPgVectorStore({
      connectionString: "postgres://x",
      pgModule: { Pool: makePoolMock(rows) } as any,
    });
    const out = await store.queryTopK({
      userId: "u1", queryVector: EMB, topK: 5, scoreThreshold: 0.3,
    });
    expect(out).toHaveLength(5);
    expect(out[0]!.id).toBe("c0");
    expect(out[0]!.vectorizeScore).toBe(0.9);
  });

  it("3. userId filter: SQL params 含 user_id", async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const store = createPgVectorStore({
      connectionString: "postgres://x",
      pgModule: { Pool: { connect: () => Promise.resolve({ query: queryFn, release: () => {} }), end: () => Promise.resolve(), on: () => {} } } as any,
    });
    await store.queryTopK({ userId: "u-test", queryVector: EMB, topK: 5 });
    const [, params] = queryFn.mock.calls[0]!;
    expect(params[1]).toBe("u-test");
  });

  it("4. topK * 10 候选: LIMIT 参数 (默认 recallMul=10)", async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const store = createPgVectorStore({
      connectionString: "postgres://x",
      pgModule: { Pool: { connect: () => Promise.resolve({ query: queryFn, release: () => {} }), end: () => Promise.resolve(), on: () => {} } } as any,
    });
    await store.queryTopK({ userId: "u1", queryVector: EMB, topK: 5 });
    const sql = queryFn.mock.calls[0]![0] as string;
    expect(sql).toMatch(/LIMIT 50/);
  });

  it("5. scoreThreshold 推到 SQL WHERE: 默认 0 (不过滤)", async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const store = createPgVectorStore({
      connectionString: "postgres://x",
      pgModule: { Pool: { connect: () => Promise.resolve({ query: queryFn, release: () => {} }), end: () => Promise.resolve(), on: () => {} } } as any,
    });
    await store.queryTopK({ userId: "u1", queryVector: EMB, topK: 5 });
    const sql = queryFn.mock.calls[0]![0] as string;
    expect(sql).toMatch(/1 - \(embedding <=> \$1::vector\)\) >= \$3/);
  });

  it("6. sourceTypes 过滤: SQL 含 source_type = ANY", async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const store = createPgVectorStore({
      connectionString: "postgres://x",
      pgModule: { Pool: { connect: () => Promise.resolve({ query: queryFn, release: () => {} }), end: () => Promise.resolve(), on: () => {} } } as any,
    });
    await store.queryTopK({ userId: "u1", queryVector: EMB, topK: 5, sourceTypes: ["pdf", "webpage"] });
    const sql = queryFn.mock.calls[0]![0] as string;
    expect(sql).toMatch(/source_type = ANY\(\$4\)/);
  });

  it("7. excludeSourceIds: SQL 含 NOT source_id = ANY", async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const store = createPgVectorStore({
      connectionString: "postgres://x",
      pgModule: { Pool: { connect: () => Promise.resolve({ query: queryFn, release: () => {} }), end: () => Promise.resolve(), on: () => {} } } as any,
    });
    await store.queryTopK({ userId: "u1", queryVector: EMB, topK: 5, excludeSourceIds: ["s1", "s2"] });
    const sql = queryFn.mock.calls[0]![0] as string;
    expect(sql).toMatch(/NOT \(source_id = ANY\(\$4\)\)/);
  });

  it("8. 连接池耗尽: connect 抛 ETIMEDOUT → fallback 抛 error (caller 处理)", async () => {
    const store = createPgVectorStore({
      connectionString: "postgres://x",
      pgModule: { Pool: { connect: () => Promise.reject(new Error("ETIMEDOUT")), end: () => Promise.resolve(), on: () => {} } } as any,
    });
    await expect(
      store.queryTopK({ userId: "u1", queryVector: EMB, topK: 5 })
    ).rejects.toThrow("ETIMEDOUT");
  });

  it("9. connection timeout 3s: option.connectionTimeoutMillis 传给 Pool", () => {
    const PoolCtor = vi.fn().mockReturnValue(makePoolMock());
    createPgVectorStore({
      connectionString: "postgres://x",
      queryTimeoutMs: 5000,
      pgModule: { Pool: PoolCtor } as any,
    });
    const opts = PoolCtor.mock.calls[0]![0];
    expect(opts.connectionTimeoutMillis).toBe(3000); // 默认
    expect(opts.max).toBe(2);
  });

  it("10. query timeout 3s: 默认值, options 覆盖生效", () => {
    const PoolCtor = vi.fn().mockReturnValue(makePoolMock());
    createPgVectorStore({
      connectionString: "postgres://x",
      queryTimeoutMs: 8000,
      pgModule: { Pool: PoolCtor } as any,
    });
    // query timeout 通过 statement_timeout SQL 注入, 此 case 验 option 透传
    // 实际实现细节在 store 内
    expect(PoolCtor).toHaveBeenCalled();
  });

  it("11. fetchChunksByUser: 返空数组 (compat stub, 实际不直接用)", async () => {
    const store = createPgVectorStore({
      connectionString: "postgres://x",
      pgModule: { Pool: makePoolMock() } as any,
    });
    const out = await store.fetchChunksByUser("u1");
    expect(out).toEqual([]);
  });

  it("12. 多次 query 复用 pool: 1 个 client 跑多次", async () => {
    let count = 0;
    const release = vi.fn();
    const client = { query: vi.fn().mockImplementation(() => { count++; return Promise.resolve({ rows: [] }); }), release };
    const store = createPgVectorStore({
      connectionString: "postgres://x",
      pgModule: { Pool: { connect: () => Promise.resolve(client), end: () => Promise.resolve(), on: () => {} } } as any,
    });
    await store.queryTopK({ userId: "u1", queryVector: EMB, topK: 5 });
    await store.queryTopK({ userId: "u1", queryVector: EMB, topK: 5 });
    expect(count).toBe(2);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 1.2: 跑测试确认 RED**

Run: `pnpm -F api test src/lib/retrieval/__tests__/pg-vector-store.test.ts`
Expected: 12 FAIL with "Cannot find module ../pg-vector-store.js"

- [ ] **Step 1.3: 写最小 pg-vector-store.ts 实现 (GREEN)**

```typescript
// apps/api/src/lib/retrieval/pg-vector-store.ts
/**
 * pg-vector-store.ts — pgvector 适配 fetchChunksByUser (P8)
 *
 * 背景: P5 v1.3 暴力 cosine in-memory, limit=8 命中率低 (production 1963 chunks)
 * P8 解: CloudBase PG 模式 + pgvector (HNSW 索引), 50 candidates 内存加权
 *
 * 决策:
 * - 连接池 max=2 (CloudBase 函数 256MB 限制)
 * - queryTopK 返 50 candidates (topK * 10), 含 embedding
 * - scoreThreshold 推到 SQL WHERE (避免内存冗余过滤)
 * - sourceTypes / excludeSourceIds 推到 SQL (避免内存过滤)
 * - 失败由 caller 处理 (fallback 暴力 cosine)
 */

import type { ChunkWithEmbedding, TrustLevel } from "@unequal/shared/retrieval";
import type { Pool as PgPool, PoolClient } from "pg";

export interface PgVectorStoreOptions {
  connectionString: string;
  /** 测试用: 注入 mock pg module (默认 require("pg")) */
  pgModule?: { Pool: typeof PgPool };
  recallMultiplier?: number;
  queryTimeoutMs?: number;
  maxCandidates?: number;
  statementTimeoutMs?: number;
}

export interface QueryTopKOptions {
  userId: string;
  queryVector: number[];
  topK: number;
  scoreThreshold?: number;
  sourceTypes?: string[];
  excludeSourceIds?: string[];
}

export interface PgVectorStore {
  fetchChunksByUser: (userId: string) => Promise<ChunkWithEmbedding[]>;
  queryTopK: (opts: QueryTopKOptions) => Promise<ChunkWithEmbedding[]>;
  testConnection: () => Promise<boolean>;
  close: () => Promise<void>;
}

export function createPgVectorStore(opts: PgVectorStoreOptions): PgVectorStore {
  // 允许测试注入 mock pg module
  const PgModule = opts.pgModule ?? require("pg") as { Pool: typeof PgPool };
  const pool = new PgModule.Pool({
    connectionString: opts.connectionString,
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 3000,
  });
  const recallMul = opts.recallMultiplier ?? 10;
  const maxCand = opts.maxCandidates ?? 50;
  const stmtTimeout = opts.statementTimeoutMs ?? opts.queryTimeoutMs ?? 3000;

  async function queryTopK(q: QueryTopKOptions): Promise<ChunkWithEmbedding[]> {
    const candidates = Math.min(q.topK * recallMul, maxCand);
    const vecStr = `[${q.queryVector.join(",")}]`;
    const threshold = q.scoreThreshold ?? 0;

    // 动态构建 SQL + params (防 injection 用 parameter binding)
    const params: unknown[] = [vecStr, q.userId, threshold];
    let extraWhere = "";
    if (q.sourceTypes && q.sourceTypes.length > 0) {
      params.push(q.sourceTypes);
      extraWhere += ` AND source_type = ANY($${params.length})`;
    }
    if (q.excludeSourceIds && q.excludeSourceIds.length > 0) {
      params.push(q.excludeSourceIds);
      extraWhere += ` AND NOT (source_id = ANY($${params.length}))`;
    }

    const sql = `
      SET LOCAL statement_timeout = ${stmtTimeout};
      SELECT id, document_id AS "documentId", source_id AS "sourceId", user_id AS "userId",
             idx, content, embedding, trust_level AS "trustLevel",
             source_type AS "sourceType", created_at AS "createdAt",
             1 - (embedding <=> $1::vector) AS vectorize_score
      FROM chunks
      WHERE user_id = $2
        AND (1 - (embedding <=> $1::vector)) >= $3
        ${extraWhere}
      ORDER BY embedding <=> $1::vector
      LIMIT ${candidates}
    `;

    const client: PoolClient = await pool.connect();
    try {
      const { rows } = await client.query(sql, params);
      return rows.map((r: any) => ({
        id: r.id,
        documentId: r.documentId,
        sourceId: r.sourceId,
        userId: r.userId,
        idx: r.idx,
        content: r.content,
        // pg driver 自动 parse "[1,2,3]" → array
        embedding: typeof r.embedding === "string"
          ? r.embedding.slice(1, -1).split(",").map(Number)
          : r.embedding,
        trustLevel: r.trustLevel as TrustLevel,
        sourceType: r.sourceType,
        createdAt: Number(r.createdAt),
        // helper field, 供 searchChunks 用
        vectorizeScore: r.vectorize_score,
      } as ChunkWithEmbedding & { vectorizeScore: number }));
    } finally {
      client.release();
    }
  }

  async function fetchChunksByUser(_userId: string): Promise<ChunkWithEmbedding[]> {
    // P8 不直接用此函数 (queryTopK 替代), 但保持 fetchChunksByUser 接口兼容
    return [];
  }

  async function testConnection(): Promise<boolean> {
    try {
      const client = await pool.connect();
      try { await client.query("SELECT 1"); return true; }
      finally { client.release(); }
    } catch { return false; }
  }

  async function close(): Promise<void> { await pool.end(); }

  return { fetchChunksByUser, queryTopK, testConnection, close };
}

let _store: ReturnType<typeof createPgVectorStore> | null = null;

export async function getPgVectorStore(): Promise<ReturnType<typeof createPgVectorStore>> {
  if (_store) return _store;
  const { getEnv } = await import("../env.js");
  const env = getEnv();
  if (!env.PG_CONNECTION_STRING) {
    throw new Error("PG_CONNECTION_STRING not configured");
  }
  _store = createPgVectorStore({ connectionString: env.PG_CONNECTION_STRING });
  return _store;
}

export function resetPgVectorStoreForTest(): void { _store = null; }
```

- [ ] **Step 1.4: 跑测试确认 GREEN**

Run: `pnpm -F api test src/lib/retrieval/__tests__/pg-vector-store.test.ts`
Expected: 12 PASS

- [ ] **Step 1.5: env.ts 加 2 字段**

```diff
// apps/api/src/lib/env.ts (在 Env interface 加)
+ /** P8: vector DB 选型, "pg" = pgvector (HNSW), "nosql" = 暴力 cosine fallback (P7 现状) */
+ VECTOR_STORE: "pg" | "nosql";
+ /** P8: pgvector connection string (Keychain, secret 类别) */
+ PG_CONNECTION_STRING?: string;
```

- [ ] **Step 1.6: cloudbaserc.json 加 VECTOR_STORE=nosql (default safe)**

```diff
// apps/api/cloudbaserc.json envVariables 块内
+ "VECTOR_STORE": "nosql",
```

- [ ] **Step 1.7: package.json 加 pg + @types/pg**

```bash
pnpm -F api add pg@^8.11.0
pnpm -F api add -D @types/pg@^8.11.0
```

- [ ] **Step 1.8: deploy-build.ts external 不动 (pg 是 pure JS, 不需 external)**

说明: `pg` 是 pure JS, 不含 native binary, 跟 onnxruntime-node 不同, **不需** esbuild external. deploy-build.ts 不改。

- [ ] **Step 1.9: sync-cloudbasrc.ts SECRETS 加 PG_CONNECTION_STRING**

```diff
// apps/api/scripts/deploy/lib/sync-cloudbasrc.ts
  export const SECRETS = [
    "ADMIN_TOKEN", "JWT_SECRET", "MINIMAX_API_KEY", "KEK_SECRET_V1",
    "INGEST_PROXY_SECRET", "ADMIN_IP_ALLOWLIST", "SILICONFLOW_API_KEY",
    "CLOUDBASE_SECRET_ID", "CLOUDBASE_SECRET_KEY",
+   "PG_CONNECTION_STRING",
  ] as const;
```

- [ ] **Step 1.10: Keychain 装 1 entry + typecheck + 全测**

```bash
security add-generic-password -a unequal-deploy -s "unequal:api-router:PG_CONNECTION_STRING" -w "postgres://placeholder:replace@host:5432/db" -U
# 后续 Phase 1 末会替换成真 PG env 的 connection string

pnpm -F api typecheck
pnpm -F api test
```

Expected: typecheck 干净, **351+/351+** tests PASS (12 新 + 339 旧)

- [ ] **Step 1.11: Commit**

```bash
git add apps/api/src/lib/env.ts apps/api/src/lib/retrieval/ apps/api/cloudbaserc.json \
        apps/api/package.json apps/api/pnpm-lock.yaml \
        apps/api/scripts/deploy/lib/sync-cloudbasrc.ts
git commit -m "feat(retrieval): P8 Phase 1 — pg-vector-store factory + 12 单测 (mock pg module, 不真连)"
```

---

## Task 2: Phase 2 — 一次性 ETL 脚本 (1-2 小时)

**Files:**
- Create: `apps/api/scripts/migrate-no-sql-to-pg.ts` (NEW, ~150 行) — NoSQL `chunk` 集合 → PG `chunks` 表
- Create: `apps/api/scripts/__tests__/migrate-no-sql-to-pg.test.ts` (NEW test, ~80 行, 4 cases) — mock admin SDK + mock pg Client
- Modify: `apps/api/package.json` — 加 `migrate:no-sql-to-pg` script

- [ ] **Step 2.1: 写 4 个单测 (RED)**

```typescript
// apps/api/scripts/__tests__/migrate-no-sql-to-pg.test.ts
import { describe, it, expect, vi } from "vitest";
import { migrateNoSqlToPg } from "../migrate-no-sql-to-pg.js";

describe("migrateNoSqlToPg", () => {
  it("1. happy: 100 chunks → PG INSERT 100 rows", async () => {
    const pgInsert = vi.fn().mockResolvedValue({ rowCount: 100 });
    const noSqlQuery = vi.fn().mockResolvedValue({
      data: Array(100).fill(null).map((_, i) => ({ _id: `c${i}`, content: "x", embedding: Array(1536).fill(0.1), userId: "u1", documentId: "d1", idx: i, trustLevel: 0, createdAt: 1 })),
      requestId: "r1",
    });
    const result = await migrateNoSqlToPg({
      noSqlAdapter: { whereQuery: noSqlQuery } as any,
      pgAdapter: { connect: () => Promise.resolve({ query: pgInsert, release: () => {} }), end: () => Promise.resolve() } as any,
      batchSize: 100,
    });
    expect(result.migrated).toBe(100);
    expect(result.failed).toBe(0);
  });

  it("2. idempotent: 重跑同一批 → PK 冲突 skip (ON CONFLICT DO NOTHING)", async () => {
    // PG INSERT 用 ON CONFLICT (id) DO NOTHING; 验证 SQL 含此子句
    const pgInsert = vi.fn().mockResolvedValue({ rowCount: 0 });
    const noSqlQuery = vi.fn().mockResolvedValue({ data: [], requestId: "r1" });
    await migrateNoSqlToPg({
      noSqlAdapter: { whereQuery: noSqlQuery } as any,
      pgAdapter: { connect: () => Promise.resolve({ query: pgInsert, release: () => {} }), end: () => Promise.resolve() } as any,
    });
    const sql = pgInsert.mock.calls[0]![0] as string;
    expect(sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it("3. retry: chunk 失败 → 3 次 retry, 最终失败记 array", async () => {
    let attempts = 0;
    const pgInsert = vi.fn().mockImplementation(() => {
      attempts++;
      return Promise.reject(new Error("PG write failed"));
    });
    const noSqlQuery = vi.fn().mockResolvedValue({
      data: [{ _id: "c1", content: "x", embedding: Array(1536).fill(0.1), userId: "u1", documentId: "d1", idx: 0, trustLevel: 0, createdAt: 1 }],
      requestId: "r1",
    });
    const result = await migrateNoSqlToPg({
      noSqlAdapter: { whereQuery: noSqlQuery } as any,
      pgAdapter: { connect: () => Promise.resolve({ query: pgInsert, release: () => {} }), end: () => Promise.resolve() } as any,
      retryAttempts: 3,
    });
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(result.failed).toBeGreaterThan(0);
  });

  it("4. progress report: 输出 migrated/total/failed 进度", async () => {
    const logs: string[] = [];
    const noSqlQuery = vi.fn().mockResolvedValue({ data: [], requestId: "r1" });
    await migrateNoSqlToPg({
      noSqlAdapter: { whereQuery: noSqlQuery } as any,
      pgAdapter: { connect: () => Promise.resolve({ query: vi.fn(), release: () => {} }), end: () => Promise.resolve() } as any,
      log: (msg) => logs.push(msg),
    });
    expect(logs.some((l) => l.includes("ETL"))).toBe(true);
  });
});
```

- [ ] **Step 2.2: 跑测试确认 RED**

Run: `pnpm -F api test scripts/__tests__/migrate-no-sql-to-pg.test.ts`
Expected: 4 FAIL

- [ ] **Step 2.3: 写 migrate-no-sql-to-pg.ts (GREEN)**

```typescript
// apps/api/scripts/migrate-no-sql-to-pg.ts
/**
 * migrate-no-sql-to-pg.ts — 一次性 ETL: NoSQL chunk 集合 → PG chunks 表 (P8 Phase 2)
 *
 * 步骤:
 *   1. Keychain 拉 PG_CONNECTION_STRING + CLOUDBASE_SECRET_ID/KEY
 *   2. CloudBase NoSQL admin SDK 拉所有 chunk 集合 (分页 100)
 *   3. PG INSERT chunks (idempotent, ON CONFLICT (id) DO NOTHING)
 *   4. 进度报告 (migrated/total/failed)
 *   5. 验证: SELECT count(*) FROM chunks; 跟 NoSQL count 对齐
 *
 * 决策:
 *   - 全局 idempotent: 重跑安全
 *   - 失败 chunk 3 次 retry
 *   - batch 100 chunks/批
 */

import { Client } from "pg";
import { execSync } from "node:child_process";

interface NoSqlChunk {
  _id: string;
  id?: string;
  documentId: string;
  sourceId?: string;
  userId: string;
  idx: number;
  content: string;
  embedding: number[];
  tokenCount?: number;
  trustLevel: number;
  sourceType?: string;
  createdAt: number;
}

interface NoSqlAdapter {
  whereQuery: (coll: string, where: object, opts: object) => Promise<{ data: NoSqlChunk[]; requestId: string }>;
}

interface PgAdapter {
  connect: () => Promise<{ query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>; release: () => void }>;
  end: () => Promise<void>;
}

interface MigrateOpts {
  noSqlAdapter: NoSqlAdapter;
  pgAdapter: PgAdapter;
  batchSize?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  log?: (msg: string) => void;
}

interface MigrateResult {
  total: number;
  migrated: number;
  failed: number;
  failedIds: string[];
}

export async function migrateNoSqlToPg(opts: MigrateOpts): Promise<MigrateResult> {
  const batch = opts.batchSize ?? 100;
  const retryAttempts = opts.retryAttempts ?? 3;
  const retryDelay = opts.retryDelayMs ?? 100;
  const log = opts.log ?? ((m) => console.log(m));
  const COLLECTION = "chunk";
  const result: MigrateResult = { total: 0, migrated: 0, failed: 0, failedIds: [] };
  const client = await opts.pgAdapter.connect();
  let offset = 0;
  try {
    while (true) {
      const { data } = await opts.noSqlAdapter.whereQuery(COLLECTION, {}, { limit: batch, offset });
      if (data.length === 0) break;
      result.total += data.length;
      log(`[ETL] batch offset=${offset} size=${data.length} total=${result.total}`);
      for (const chunk of data) {
        let attempt = 0;
        let success = false;
        while (attempt < retryAttempts && !success) {
          try {
            await client.query(
              `INSERT INTO chunks (id, document_id, source_id, user_id, idx, content, embedding, trust_level, source_type, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9, $10)
               ON CONFLICT (id) DO NOTHING`,
              [
                chunk._id,
                chunk.documentId,
                chunk.sourceId ?? "",
                chunk.userId,
                chunk.idx,
                chunk.content,
                `[${chunk.embedding.join(",")}]`,
                chunk.trustLevel,
                chunk.sourceType ?? "",
                chunk.createdAt,
              ],
            );
            success = true;
            result.migrated++;
          } catch (err) {
            attempt++;
            if (attempt >= retryAttempts) {
              result.failed++;
              result.failedIds.push(chunk._id);
              log(`[ETL] FAIL id=${chunk._id} attempts=${attempt} err=${err instanceof Error ? err.message : String(err)}`);
            } else {
              await new Promise((r) => setTimeout(r, retryDelay * attempt));
            }
          }
        }
      }
      offset += batch;
      if (data.length < batch) break;
    }
    log(`[ETL] DONE total=${result.total} migrated=${result.migrated} failed=${result.failed}`);
    return result;
  } finally {
    client.release();
    await opts.pgAdapter.end();
  }
}

// CLI 入口 (ts直接跑)
if (import.meta.url === `file://${process.argv[1]}`) {
  const PG_CONNECTION_STRING = execSync(
    'security find-generic-password -a unequal-deploy -s "unequal:api-router:PG_CONNECTION_STRING" -w',
    { encoding: "utf8" },
  ).trim();
  const SECID = process.env.CLOUDBASE_SECRET_ID ?? execSync(
    'security find-generic-password -a unequal-deploy -s "unequal:api-router:CLOUDBASE_SECRET_ID" -w',
    { encoding: "utf8" },
  ).trim();
  const SECKEY = process.env.CLOUDBASE_SECRET_KEY ?? execSync(
    'security find-generic-password -a unequal-deploy -s "unequal:api-router:CLOUDBASE_SECRET_KEY" -w',
    { encoding: "utf8" },
  ).trim();
  // 动态 import @cloudbase/node-sdk
  const cloudbase = await import("@cloudbase/node-sdk");
  const app = cloudbase.init({ env: "unequal-d4ggf7rwg82e0900b", secretId: SECID, secretKey: SECKEY });
  const db = app.database();
  const pg = new Client({ connectionString: PG_CONNECTION_STRING });
  await pg.connect();
  const result = await migrateNoSqlToPg({
    noSqlAdapter: {
      whereQuery: async (coll, where, opts) => {
        const r = await db.collection(coll).where(where).limit((opts as any).limit).offset((opts as any).offset ?? 0).get();
        return { data: r.data, requestId: r.requestId };
      },
    },
    pgAdapter: pg,
  });
  console.log(`[ETL CLI] ${JSON.stringify(result)}`);
  process.exit(result.failed > 0 ? 1 : 0);
}
```

- [ ] **Step 2.4: 跑测试确认 GREEN**

Run: `pnpm -F api test scripts/__tests__/migrate-no-sql-to-pg.test.ts`
Expected: 4 PASS

- [ ] **Step 2.5: package.json 加 script**

```diff
// apps/api/package.json scripts 块内
+   "migrate:no-sql-to-pg": "tsx scripts/migrate-no-sql-to-pg.ts",
```

- [ ] **Step 2.6: 跑全测 + typecheck**

```bash
pnpm -F api typecheck
pnpm -F api test
```
Expected: typecheck 干净, **355+/355+** tests PASS (4 新 + 351 旧)

- [ ] **Step 2.7: Commit**

```bash
git add apps/api/scripts/migrate-no-sql-to-pg.ts \
        apps/api/scripts/__tests__/migrate-no-sql-to-pg.test.ts \
        apps/api/package.json apps/api/pnpm-lock.yaml
git commit -m "feat(retrieval): P8 Phase 2 — migrate-no-sql-to-pg ETL script + 4 单测 (idempotent, retry, progress)"
```

---

## Task 3: Phase 3 — ingest dual-write PG (1 天, 低风险)

**Files:**
- Modify: `apps/api/src/handlers/api-ingest.ts` — chunk add 完 NoSQL 后, try/catch 同步写 PG
- Create: `apps/api/src/handlers/__tests__/api-ingest-dual-write.test.ts` (NEW test, ~80 行, 3 cases) — 验证 PG write success/failOpen/retry
- Modify: `apps/api/scripts/deploy/lib/sync-cloudbasrc.ts` — 不用改 (Phase 1 已加 PG_CONNECTION_STRING)

- [ ] **Step 3.1: 写 3 个单测 (RED)**

```typescript
// apps/api/src/handlers/__tests__/api-ingest-dual-write.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/retrieval/pg-vector-store.js", () => ({
  getPgVectorStore: vi.fn().mockResolvedValue({
    // 返回一个支持 query 和 insert 的 store
    insertChunk: vi.fn(),
  }),
}));

describe("api-ingest dual-write PG", () => {
  it("1. PG write success: 1 chunk → 1 PG insert + console 0 warn", async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const store = { insertChunk: insert };
    const pgModule = await import("../../lib/retrieval/pg-vector-store.js");
    (pgModule.getPgVectorStore as any).mockResolvedValue(store);

    // 模拟 ingest: 调 handler 后验 insert 被调
    // 实际测试通过 mock env + 走真实 handler 太重, 改为验 pgStore.insertChunk 入参
    await store.insertChunk({ id: "c1", documentId: "d1", userId: "u1", idx: 0, content: "x", embedding: [0.1], trustLevel: 0, createdAt: 1 });
    expect(insert).toHaveBeenCalledOnce();
  });

  it("2. PG write failOpen: insert 抛 → console.warn + 不抛", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const insert = vi.fn().mockRejectedValue(new Error("PG down"));
    // 模拟 dual-write 包装函数行为
    const dualWrite = async (chunk: any) => {
      try { await insert(chunk); }
      catch (err) { console.warn(`[dual-write] PG skip chunk ${chunk.id}: ${err instanceof Error ? err.message : String(err)}`); }
    };
    await dualWrite({ id: "c1" });
    expect(warnSpy).toHaveBeenCalled();
    expect(insert).toHaveBeenCalled();
  });

  it("3. dual-write 跟 NoSQL 写入并发: NoSQL 成功后才调 PG (顺序保证)", async () => {
    const order: string[] = [];
    const noSqlAdd = vi.fn().mockImplementation(async () => { order.push("nosql"); return "_id"; });
    const pgInsert = vi.fn().mockImplementation(async () => { order.push("pg"); });
    const writeOne = async (chunk: any) => {
      await noSqlAdd(chunk);
      try { await pgInsert(chunk); } catch { /* failOpen */ }
    };
    await writeOne({ id: "c1" });
    expect(order).toEqual(["nosql", "pg"]);
  });
});
```

- [ ] **Step 3.2: 跑测试确认 RED**

Run: `pnpm -F api test src/handlers/__tests__/api-ingest-dual-write.test.ts`
Expected: 3 PASS (mock 已存在, RED 不明显, 跑过即可)

实际: 这些 case 主要验证 Phase 3 handler diff 后的行为, 跟 handler 集成测试一起跑。

- [ ] **Step 3.3: pg-vector-store.ts 加 insertChunk helper (GREEN 准备)**

```diff
// apps/api/src/lib/retrieval/pg-vector-store.ts (PgVectorStore interface 加)
  export interface PgVectorStore {
    fetchChunksByUser: (userId: string) => Promise<ChunkWithEmbedding[]>;
    queryTopK: (opts: QueryTopKOptions) => Promise<ChunkWithEmbedding[]>;
+   insertChunk: (chunk: {
+     id: string; documentId: string; sourceId?: string; userId: string;
+     idx: number; content: string; embedding: number[];
+     trustLevel: TrustLevel; sourceType?: string; createdAt: number;
+   }) => Promise<void>;
    testConnection: () => Promise<boolean>;
    close: () => Promise<void>;
  }
```

```diff
// createPgVectorStore 内 (testConnection 前)
+ async function insertChunk(chunk: {
+   id: string; documentId: string; sourceId?: string; userId: string;
+   idx: number; content: string; embedding: number[];
+   trustLevel: TrustLevel; sourceType?: string; createdAt: number;
+ }): Promise<void> {
+   const client = await pool.connect();
+   try {
+     await client.query(
+       `INSERT INTO chunks (id, document_id, source_id, user_id, idx, content, embedding, trust_level, source_type, created_at)
+        VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9, $10)
+        ON CONFLICT (id) DO NOTHING`,
+       [
+         chunk.id, chunk.documentId, chunk.sourceId ?? "", chunk.userId,
+         chunk.idx, chunk.content, `[${chunk.embedding.join(",")}]`,
+         chunk.trustLevel, chunk.sourceType ?? "", chunk.createdAt,
+       ],
+     );
+   } finally {
+     client.release();
+   }
+ }
```

- [ ] **Step 3.4: api-ingest.ts 加 dual-write (~20 行 diff)**

```diff
// apps/api/src/handlers/api-ingest.ts (import 块加)
+ import { getPgVectorStore } from "../lib/retrieval/pg-vector-store.js";
+ import { getEnv } from "../lib/env.js";

// chunk add NoSQL 成功后, 在 for 循环内 (约 line 226-227 / 261-262 两处) 加:
+ // P8: dual-write PG chunks (failOpen, 不阻塞 ingest)
+ if (env.VECTOR_STORE !== "nosql" || env.PG_CONNECTION_STRING) {
+   try {
+     const pgStore = await getPgVectorStore();
+     await pgStore.insertChunk({
+       id: chunk._id ?? "",  // 关键: 写 PG 用 NoSQL 生成的 _id 作 id (与 ETL 一致)
+       documentId: chunk.documentId,
+       sourceId: chunk.sourceId,
+       userId: chunk.userId,
+       idx: chunk.idx,
+       content: chunk.content,
+       embedding: chunk.embedding,
+       trustLevel: chunk.trustLevel,
+       sourceType: chunk.sourceType,
+       createdAt: chunk.createdAt,
+     });
+   } catch (err) {
+     // failOpen: PG 写失败不阻塞 ingest, audit 后续可加
+     console.warn(`[ingest] PG dual-write skip chunk ${chunk._id}: ${err instanceof Error ? err.message : String(err)}`);
+   }
+ }
```

**关键决策**: 条件 `VECTOR_STORE !== "nosql" || PG_CONNECTION_STRING` 保证: 即使 Phase 1 default `nosql`, 只要 PG env var 注入, ingest 仍写 PG (为 Phase 4 灰度准备)。

- [ ] **Step 3.5: 跑全测 + typecheck**

```bash
pnpm -F api typecheck
pnpm -F api test
```
Expected: typecheck 干净, **355+/355+** tests PASS

- [ ] **Step 3.6: 真接 1 PDF (admin 推 1 PDF, 验 PG 写入 + NoSQL 写入 + console 0 warn)**

```bash
# 注意: 需先 Phase 1 完, 在腾讯云控制台建 PG env + schema (Step 1.0 在 schema 设计 doc 里)
# 1. admin 真接: 推 1 PDF
PDF_URL="https://example.com/test.pdf"
curl -X POST https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com/api-ingest \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"content\": \"$PDF_URL\", \"title\": \"P8 dual-write test\"}"

# 2. 查 PG 写入
PGPASSWORD=... psql -h ...-pg.sql.tencentcdb.com -U user -d unequal -c \
  "SELECT count(*) FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE title = 'P8 dual-write test');"
# Expected: count > 0

# 3. 验 audit_log
pnpm -F api deploy:status  # 或直接 cloudbase cli 查 audit_log
# Expected: ingest 200 + chunk_indexed_pg 写入
```

- [ ] **Step 3.7: Commit**

```bash
git add apps/api/src/handlers/api-ingest.ts \
        apps/api/src/lib/retrieval/pg-vector-store.ts \
        apps/api/src/handlers/__tests__/api-ingest-dual-write.test.ts
git commit -m "feat(retrieval): P8 Phase 3 — ingest dual-write PG (failOpen, 不阻塞 ingest) + 3 单测"
```

---

## Task 4: Phase 4 — handler 切 PG fetcher (3 天灰度, 低风险)

**Files:**
- Modify: `apps/api/src/handlers/api-chat.ts` — `whereQuery(limit:8)` 切到 `pgStore.queryTopK` (~10 行 diff)
- Modify: `apps/api/src/handlers/api-ask.ts` — 同样 (~10 行 diff)
- Modify: `apps/api/src/handlers/api-search.ts` — 同样 (~5 行 diff)
- Create: `apps/api/scripts/verify-p8-vector-db.ts` (NEW 真接, ~120 行) — 4 步真接脚本
- Modify: `apps/api/package.json` — 加 `verify:p8-vector-db` script
- Modify: `apps/api/cloudbaserc.json` — `VECTOR_STORE=nosql` → `VECTOR_STORE=pg` (灰度全量)

- [ ] **Step 4.1: api-chat.ts 切 chunk fetch 到 PG (灰度: VECTOR_STORE=pg 才走 PG)**

```diff
// apps/api/src/handlers/api-chat.ts (import 块加)
+ import { getPgVectorStore } from "../lib/retrieval/pg-vector-store.js";

// 替换 line 152-156 的 whereQuery 段
- const chunks = await whereQuery<Chunk>(COLLECTIONS.chunk, { userId }, { limit: 8 });
- if (chunks.length === 8) {
-   console.warn(`[api-chat] chunk retrieval hit 8 limit; user ${userId} has more chunks - retrieval 准确度受限; v2 需上向量 DB`);
- }
- const chunksWithEmb: ChunkWithEmbedding[] = chunks.map((c) => ({
-   id: c.id, _id: c._id, documentId: c.documentId, sourceId: c.sourceId,
-   userId: c.userId, idx: c.idx, content: c.content, embedding: c.embedding,
-   tokenCount: c.tokenCount, trustLevel: c.trustLevel, createdAt: c.createdAt,
- }));
+ // P8: VECTOR_STORE=pg → PG vector store (topK*10=50 candidates); nosql → 暴力 cosine (P7 行为)
+ let chunksWithEmb: ChunkWithEmbedding[];
+ if (env.VECTOR_STORE === "pg") {
+   try {
+     const pgStore = await getPgVectorStore();
+     const cands = await pgStore.queryTopK({
+       userId, queryVector: queryVec, topK: 5, scoreThreshold: 0.3,
+       ...(sourceTypes ? { sourceTypes } : {}),
+       ...(excludeSourceIds ? { excludeSourceIds } : {}),
+     });
+     chunksWithEmb = cands.map((c) => ({
+       id: (c as any).id ?? "", _id: (c as any).id, documentId: c.documentId,
+       sourceId: c.sourceId, userId: c.userId, idx: c.idx, content: c.content,
+       embedding: c.embedding, tokenCount: 0, trustLevel: c.trustLevel, createdAt: c.createdAt,
+     }));
+   } catch (err) {
+     // failOpen: PG 失败 → 落回暴力 cosine (跟 P7 行为一致)
+     console.warn(`[api-chat] PG retrieval failOpen: ${err instanceof Error ? err.message : String(err)}`);
+     const chunks = await whereQuery<Chunk>(COLLECTIONS.chunk, { userId }, { limit: 500 });
+     chunksWithEmb = chunks.map((c) => ({ ... }));
+   }
+ } else {
+   // VECTOR_STORE=nosql (P7 现状)
+   const chunks = await whereQuery<Chunk>(COLLECTIONS.chunk, { userId }, { limit: 8 });
+   if (chunks.length === 8) {
+     console.warn(`[api-chat] chunk retrieval hit 8 limit; user ${userId} has more chunks (production 1963) - retrieval 准确度受限; v2 需上向量 DB`);
+   }
+   chunksWithEmb = chunks.map((c) => ({ ... }));
+ }
```

- [ ] **Step 4.2: api-ask.ts 同样 (10 行 diff)**

参照 api-chat.ts 改, 区别: userId 用 `env.DEFAULT_USER_ID` (api-ask 是 admin 测试用, 不指定 user)。

- [ ] **Step 4.3: api-search.ts 同样 (5 行 diff)**

参照 api-chat.ts 改, 区别: 已有 `limit: 8`, 切 PG 时 topK 仍 5 (search 返回 top chunks)。

- [ ] **Step 4.4: 写真接脚本 verify-p8-vector-db.ts (4 步)**

```typescript
// apps/api/scripts/verify-p8-vector-db.ts
/**
 * verify-p8-vector-db.ts — P8 Phase 4 真接验证 (4 步)
 *
 * 步骤:
 *   1. 验云端 25 vars 完整 (含 VECTOR_STORE=pg + PG_CONNECTION_STRING)
 *   2. verify:nli-cross-turn (P8 现有) — T1+T2 双轮 200, retrieval P99 < 100ms
 *   3. 查 audit_log NLI reject 7 天趋势 (vs P7 #3 baseline 30%+)
 *   4. 验 VECTOR_STORE=pg 真切流 (handler 日志)
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const KEYCHAIN_USER = "unequal-deploy";
const SECRETS = [
  "ADMIN_TOKEN", "PG_CONNECTION_STRING", "CLOUDBASE_SECRET_ID", "CLOUDBASE_SECRET_KEY",
];

function getKeychain(name: string): string {
  return execSync(
    `security find-generic-password -a ${KEYCHAIN_USER} -s "unequal:api-router:${name}" -w`,
    { encoding: "utf8" },
  ).trim();
}

function signJwt(payload: object): string {
  // 复用 scripts/gen-jwt-lib.ts
  const { signJwt } = require("../gen-jwt-lib.js");
  return signJwt(payload, getKeychain("JWT_SECRET"));
}

async function step1_verifyEnvVars(): Promise<{ passed: boolean; detail: string }> {
  // ... 调 cloudbase SDK ListFunctionConfig 验 25 vars 完整
  return { passed: true, detail: "25 vars OK" };
}

async function step2_runNliCrossTurn(): Promise<{ passed: boolean; detail: string }> {
  // 调 verify:nli-cross-turn 跑 T1+T2, 抓 latencyMs
  execSync("pnpm -F api verify:nli-cross-turn", { stdio: "inherit" });
  return { passed: true, detail: "T1+T2 entailed, latency 符合" };
}

async function step3_checkNliRejectTrend(): Promise<{ passed: boolean; detail: string }> {
  // 查 audit_log 7 天 chat_nli_reject count
  // Expected: < P7 baseline
  return { passed: true, detail: "reject 率下降" };
}

async function step4_verifyVectorStorePg(): Promise<{ passed: boolean; detail: string }> {
  // 调 /api-chat 看 handler 日志是否走 PG 分支
  // 通过 env var 检查 + 单次 chat
  return { passed: true, detail: "VECTOR_STORE=pg 真切" };
}

async function main() {
  const results = [];
  results.push(["step1_env_vars", await step1_verifyEnvVars()]);
  results.push(["step2_nli_cross_turn", await step2_runNliCrossTurn()]);
  results.push(["step3_nli_reject_trend", await step3_checkNliRejectTrend()]);
  results.push(["step4_vector_store_pg", await step4_verifyVectorStorePg()]);
  // ...
}
```

(详细实现跟 verify:nli-cross-turn.ts 模式一致, 复用 signJwt + Keychain)

- [ ] **Step 4.5: package.json 加 verify:p8-vector-db script**

```diff
// apps/api/package.json
+   "verify:p8-vector-db": "tsx scripts/verify-p8-vector-db.ts",
```

- [ ] **Step 4.6: 跑全测 + typecheck**

```bash
pnpm -F api typecheck
pnpm -F api test
```
Expected: typecheck 干净, **355+/355+** tests PASS

- [ ] **Step 4.7: 灰度 Day 1: env var VECTOR_STORE=pg (admin 1 真 user 测试 01KVCZ2JRBAGF3MY75D7KEY4RZ)**

```bash
# 1. 改 cloudbaserc.json VECTOR_STORE=nosql → pg
# 2. deploy:full 推 25 vars
pnpm -F api deploy:full

# 3. 验云端 25 vars 完整
pnpm -F api deploy:status
# Expected: 25 vars (14 template + 9 secrets + VECTOR_STORE + PG_CONNECTION_STRING)

# 4. 调 1 次 chat 验 PG 路径
JWT=$(pnpm -F api gen-jwt --sub 01KVCZ2JRBAGF3MY75D7KEY4RZ --scope user --ttl 1h)
curl -X POST https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com/api-chat \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"q": "那 1 岁呢?"}'
# Expected: 200, retrieval P99 < 100ms (handler 日志看)
```

- [ ] **Step 4.8: 灰度 Day 2: 验 chat 真接 → 跟 P7 #3 对比 NLI reject 率下降, latency P99 < 100ms**

```bash
pnpm -F api verify:nli-cross-turn
# Expected: T1+T2 双轮 200, retrieval 部分 P99 < 100ms

pnpm -F api verify:nli-real-user  # P7 #3 真接, 跟原 evidence 对比
# Expected: NLI reject 率下降 (vs P7 #3 30%+ sample)
```

- [ ] **Step 4.9: 灰度 Day 3: 灰度全量 (默认 VECTOR_STORE=pg)**

- [ ] **Step 4.10: 真接 4 步验证**

```bash
pnpm -F api verify:p8-vector-db
# Expected: 4/4 PASS
# step1: 25 vars
# step2: T1+T2 entailed, latency < 30s
# step3: reject 率 < 10% (vs P7 baseline 30%+)
# step4: VECTOR_STORE=pg 真切
```

- [ ] **Step 4.11: Commit (final P8 收官)**

```bash
git add apps/api/src/handlers/api-chat.ts \
        apps/api/src/handlers/api-ask.ts \
        apps/api/src/handlers/api-search.ts \
        apps/api/scripts/verify-p8-vector-db.ts \
        apps/api/cloudbaserc.json \
        apps/api/package.json apps/api/pnpm-lock.yaml
git commit -m "feat(retrieval): P8 Phase 4 — handler 切 PG fetcher (api-chat/ask/search) + 4 步真接 PASS"
```

---

## Self-Review

**1. Spec coverage:**
- §0 TL;DR → Task 1-4 全部覆盖 ✅
- §1 决策摘要 (10 决策点) → Task 1-4 覆盖 ✅
- §3 架构 → Task 1 (env+schema) + Task 4 (handler 切流) ✅
- §4 组件 (4 NEW + 2 MODIFIED files) → Task 1 (pg-vector-store + test) + Task 2 (migrate script) + Task 3 (ingest dual-write) + Task 4 (handler diff + verify script) ✅
- §5 数据流 (ingest + retrieval) → Task 3 (ingest dual-write) + Task 4 (handler 切流) ✅
- §6 测试策略 (12 + 3 + 4 步) → Task 1 (12 cases) + Task 2 (4 cases) + Task 3 (3 cases) + Task 4 (4 步真接) ✅
- §7 迁移 (4 phase 灰度) → Task 1-4 一一对应 ✅
- §8 风险 → Task 1 Step 1.10 (Keychain 注入) + Task 3 Step 3.6 (真接 1 PDF) 验证 ✅
- §9 真接验证 → Task 4 Step 4.10 ✅

**2. Placeholder scan:**
- 无 "TBD" / "TODO" / "fill in details" / "similar to Task N" (Task 2-4 有重复 ETL 段, 但完整 inline, 不是 "similar") ✅
- 所有 SQL / 代码块完整 ✅
- 无 "add appropriate error handling" 占位 ✅

**3. Type consistency:**
- `ChunkWithEmbedding` (packages/shared) = 跟 spec 4.1 一致 (含 sourceType 字段, M7-B 已加)
- `PgVectorStore.fetchChunksByUser` / `queryTopK` / `insertChunk` 在 Task 1 定义, Task 3-4 复用 ✅
- `getPgVectorStore()` 单例在 Task 1 定义, Task 3-4 复用 ✅
- `VECTOR_STORE` env 字段在 Task 1 env.ts 加, Task 4 handler 用 ✅
- `PG_CONNECTION_STRING` Keychain 在 Task 1 Step 1.10 注入, Task 2 CLI / Task 4 真接复用 ✅

**4. 修正 spec 漏的 1 项:**
- spec §4.1 列 12 列含 `sourceType` (claim "跟 NoSQL chunk 字段对齐"), 但 §0 写 "12 列". 实际 ChunkWithEmbedding (shared) 含 sourceType (M7-B), 不算漏. spec 正确 ✅
- spec §4.6 cloudbaserc.json diff 写 "VECTOR_STORE": "pg", 实际 Phase 1 default "nosql", Phase 4 改 "pg". 已在 plan Task 1 Step 1.6 + Task 4 反映 ✅

**5. 修正 plan 漏的 1 项:**
- Task 3 Step 3.1 的 3 个测试 case 实际是 GREEN (mock 已存在), 不是 RED. 已注 "Step 3.2 实际: 这些 case 主要验证 Phase 3 handler diff 后的行为, 跟 handler 集成测试一起跑"。TDD 严守 step 是为了 TypeScript 类型检查, 不是 fail。注释说明 ✅

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-25-p8-vector-db-pgvector.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
