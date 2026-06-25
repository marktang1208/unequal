# P8 Vector DB 集成 — CloudBase PG 模式 + pgvector

**日期**: 2026-06-25
**作者**: Mark + Claude (brainstorming 协作)
**状态**: ⏸️ Design approved, pending user spec review
**Tag**: `p8-vector-db-pg-pgvector`
**前置**:
- P6 follow-up 全收官 + P8 v1.4 真接 (commit `270056e`) — state-p7-p8-followup-completion.md
- P5 v1.3 NLI spec `2026-06-23-p5-nli-entailment-design.md` — 真接 NLI reject 是本 PR 直接驱动
- 2026-06-23 ask-search-retrieval-limit spec `2026-06-23-ask-search-retrieval-limit-design.md` §6 — v2 留路 #3 "第三方向量 DB" 触发条件 (10K/100K chunks) 已达
- state-arch-v2.3.md — CloudBase 1MB / 5MB 限制事实稳定
- 真接 evidence: P7 #3 audit_log `chat_nli_reject` latencyMs=1919, reason=runtime_error 根因是 retrieval 命中率低 (top-5 chunks 不严格 match query)

---

## 0. TL;DR

P5 v1.3 NLI 真接 reject 主因是 retrieval limit=8/500 + 暴力 cosine, 命中率低, top-5 chunks 跟 query 不严格 match。P7 #3 真接 evidence (audit_log `latencyMs=1919` with `chat_nli_reject`) 证实。

**解法**: CloudBase **PG 模式 + pgvector** (HNSW 索引) 作为 retrieval 加速器, dual-write + failOpen, NoSQL 集合保留为 source-of-truth。

**核心收益**:
- retrieval 召回从 limit=8 → top-50 候选 (10x), trust + recency 加权后 top-5 真 match query
- P99 latency < 100ms (HNSW 1536 维, 2000 chunks/user)
- NLI 误判率预期下降 50%+ (top-5 真 match → pass path ↑, reject path ↓)
- 未来 10K+ chunks/user 不需重架构

**核心决策**:
- CloudBase PG 模式 = 新 env (`unequal-d4ggf7rwg82e0900b-pg`), 不动现有 MySQL/NoSQL
- dual-write pattern: NoSQL `chunk` source-of-truth + PG `chunks` retrieval cache
- failOpen: PG 写失败 console.warn + 不阻塞; PG 读失败 fallback 暴力 cosine
- env var `VECTOR_STORE=pg|nosql` 控制灰度, 1 行回滚

---

## 1. 决策摘要

| 决策点 | 选择 | 原因 |
|---|---|---|
| **Vector DB 类型** | CloudBase PG 模式 + pgvector | 腾讯云官方 RAG 路径, HNSW 内置, 标准 SQL, 长期可扩展 |
| **PG env 策略** | 新建 env (`-pg` 后缀) | PG 模式与 MySQL 互斥, 不污染现有 env; 独立回滚 |
| **数据双写** | NoSQL source-of-truth + PG retrieval cache | NoSQL admin ingest 链路不变; PG 是只读加速器; 迁移零风险 |
| **PG 写入失败** | console.warn + 跳过 (不阻塞 ingest) | 跟 P5 NLI failOpen 一致; PG 是加速器, 不是必要数据源 |
| **PG 读取失败** | fallback 暴力 cosine (limit=500) + audit `pg_retrieval_fallback` | 任何时候用户能用, 只是慢; 透明降级 |
| **chunk 表 schema** | 12 列: id, userId idx, documentId, idx, content, embedding vector(1536), trustLevel, sourceType, sourceId, createdAt | 跟 NoSQL chunk 字段对齐, 最小 diff |
| **HNSW 索引参数** | m=16, ef_construction=64, ef_search=40 | 2000 chunks/user 经验值; ef_search 越大越准越慢, 40 平衡 |
| **retrieval 改写** | 只换 `fetchChunksByUser` 注入 (handler main 逻辑不动) | searchChunks 纯函数不变, 测试不变, 风险最小 |
| **灰度** | env var `VECTOR_STORE=pg|nosql` 切流 | 1 行 env 切; 默认 `nosql` (P7 现状), admin opt-in `pg` |
| **迁移策略** | 4 phase (建 env/ETL/dual-write/灰度) | 风险最小化, 任意 phase 可暂停/回滚 |
| **真接验证** | 跟 P7 #3 对比 NLI reject 率, latency P99 < 100ms | evidence-based, 不靠口述 |

---

## 2. 备选方案 (YAGNI 不实现)

| 方案 | 优势 | 劣势 | 触发条件 |
|---|---|---|---|
| **B: CloudBase MySQL 直连 + JSON + cosine UDF** | 不换 env, 迁移成本低 | 需 VPC + 自定义函数; 2000×1536 P99 未知; 无 HNSW; 长期不优 | 用户拒绝新建 env |
| **C: NoSQL + admin 侧 lancedb 预处理 top-K 缓存** | 零架构改动 | chat 实时 query 仍 limit=8, 只优化 fallback | 用户拒绝 PG 模式 |
| **D: 腾讯云独立 VectorDB enterprise** | 千万级 QPS, ms 延迟 | 需另接账号 + API key + 数据出 env 边界; 30 天免费后收费 | chunks/user > 100K |
| **E: 海外服务 Pinecone / Weaviate** | 完全 managed | 数据出 GFW (P5 China 网络限制已知); 月费高; 外部 account | chunks/user > 1M + 海外用户 |

---

## 3. 架构

### 3.1 高层图

```text
                    ┌────────────────────┐
                    │ CloudBase PG env    │  (新, ap-shanghai, pgvector 扩展)
                    │  chunks 表          │
                    │   - id PK           │
                    │   - userId idx      │
                    │   - documentId idx  │
                    │   - idx int         │
                    │   - content text    │
                    │   - embedding vector(1536) ← pgvector HNSW 索引
                    │   - trustLevel int  │
                    │   - sourceType text │
                    │   - sourceId text   │
                    │   - createdAt bigint│
                    │  HNSW (m=16,        │
                    │   ef_construction=64)│
                    └─────────┬───────────┘
                              │ node-postgres 直连 (VPC 内, env vars 注入 connection string)
                              │ <-> cosine distance operator (<=>)
                              │ <-> filter by userId + score threshold
                              │
                    ┌─────────▼───────────┐
                    │ apps/api/src/lib/   │
                    │ retrieval/          │  (新目录, 替代暴力 cosine)
                    │  pg-vector-store.ts │  ← fetchChunksByUser 适配
                    │  migrate-no-sql-    │
                    │  to-pg.ts (NEW)     │
                    └─────────┬───────────┘
                              │ SearchOptions {userId, queryVector, topK, scoreThreshold, sourceTypes, excludeSourceIds}
                              │
                    ┌─────────▼───────────┐
                    │ chat/ask/search     │  (handlers 不改 main 逻辑, 只换 fetchChunksByUser 注入)
                    │ handler →           │
                    │ searchChunks(...)   │  (packages/shared/retrieval.ts 不动, 复用)
                    └────────────────────┘
```

### 3.2 关键边界

- **NoSQL `chunk` 集合保留**: source-of-truth (admin 推 PDF/DOCX → ingest → NoSQL `chunk`)
- **PG `chunks` 表同步**: ingest 写 NoSQL 后, 同步写 PG (dual-write, failOpen: PG 失败不阻塞 ingest)
- **admin 真接脚本不变**: `verify:nli-*` 仍走 /api-chat HTTP 路径, 后端内部换 store
- **`packages/shared/retrieval.ts` 不动**: 复用纯函数 `cosineSimilarity` + `searchChunks`, 只换 `fetchChunksByUser` 注入 (生产实现从 PG 拉, 测试 mock 从内存拉)
- **PG 实例同 region (ap-shanghai)**: 跟 CloudBase 函数同 region, 低延迟; 跨 region 走 VPC peering

### 3.3 部署架构

```text
CloudBase (ap-shanghai)
├── env: unequal-d4ggf7rwg82e0900b (现有, MySQL+NoSQL)
│   ├── cloud function: api-router (Nodejs20.19, 256MB)
│   ├── NoSQL collections: chunk, document, chatSession, user, audit_log
│   ├── COS: nli-model/* (P6)
│   └── Keychain: JWT_SECRET, MINIMAX_API_KEY, ... (9 secrets)
│
└── env: unequal-d4ggf7rwg82e0900b-pg (新, PG 模式 + pgvector)
    └── relational DB: chunks 表 + HNSW 索引
```

---

## 4. 组件

### 4.1 `apps/api/src/lib/retrieval/pg-vector-store.ts` (NEW runtime, ~250 行)

```typescript
/**
 * pg-vector-store.ts — pgvector 适配 fetchChunksByUser (P8)
 *
 * 背景 (P5 v1.3 限制):
 *   - chat/ask handler 用暴力 cosine in-memory
 *   - limit=8 (chat) / limit=500 (search) 召回太少 / 太多但慢
 *   - production 1963 chunks/user, top-5 命中率低
 *
 * P8 解法:
 *   - CloudBase PG 模式 + pgvector (HNSW 索引)
 *   - 跑 cosine distance 在 DB (向量 DB 算), 不在内存
 *   - handler 调 queryTopK, 返 topK * 10 候选 (50), 内存再算 trust/recency 加权
 *
 * 决策:
 *   - 连接池 max=2 (CloudBase 函数 256MB 限制; 1 user 1 query 串行)
 *   - query timeout 3s, 超时 fallback 暴力 cosine
 *   - 不实现 trust/recency 加权 (复用 searchChunks 内存算, 简单)
 */

import { Pool, type PoolClient } from "pg";
import type { ChunkWithEmbedding, SearchOptions } from "@unequal/shared/retrieval";

export interface PgVectorStoreOptions {
  connectionString: string;
  /** 候选倍数 (默认 10, 覆盖 trust 加权 + 过滤 + 留余量) */
  recallMultiplier?: number;
  /** query timeout (默认 3000ms) */
  queryTimeoutMs?: number;
  /** 候选返回的 max (默认 50, 防极端 trust 加权吃光) */
  maxCandidates?: number;
}

export interface PgVectorStore {
  fetchChunksByUser: (userId: string) => Promise<ChunkWithEmbedding[]>;
  queryTopK: (opts: { userId: string; queryVector: number[]; topK: number; scoreThreshold?: number; sourceTypes?: string[]; excludeSourceIds?: string[] }) => Promise<ChunkWithEmbedding[]>;
  testConnection: () => Promise<boolean>;
  close: () => Promise<void>;
}

export function createPgVectorStore(opts: PgVectorStoreOptions): PgVectorStore {
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 3000,
  });
  const recallMul = opts.recallMultiplier ?? 10;
  const maxCand = opts.maxCandidates ?? 50;
  const timeout = opts.queryTimeoutMs ?? 3000;

  async function queryTopK(q: {
    userId: string;
    queryVector: number[];
    topK: number;
    scoreThreshold?: number;
    sourceTypes?: string[];
    excludeSourceIds?: string[];
  }): Promise<ChunkWithEmbedding[]> {
    const candidates = Math.min(q.topK * recallMul, maxCand);
    const vecStr = `[${q.queryVector.join(",")}]`;

    // pgvector cosine distance: 1 - cosine_similarity, 越小越相似
    // 返 1 - distance 作为 vectorizeScore (跟 searchChunks 一致)
    // 只做向量召回 (按 user + cosine distance), trust/recency 加权走 searchChunks 内存算
    const sql = `
      SELECT id, document_id AS "documentId", source_id AS "sourceId", user_id AS "userId",
             idx, content, embedding, trust_level AS "trustLevel",
             source_type AS "sourceType", created_at AS "createdAt",
             1 - (embedding <=> $1::vector) AS vectorize_score
      FROM chunks
      WHERE user_id = $2
        AND (1 - (embedding <=> $1::vector)) >= $3  -- scoreThreshold 推到 SQL
        ${q.sourceTypes ? "AND source_type = ANY($4)" : ""}
        ${q.excludeSourceIds ? `AND NOT (source_id = ANY($${q.sourceTypes ? 5 : 4}))` : ""}
      ORDER BY embedding <=> $1::vector
      LIMIT ${candidates}
    `;
    // ... 实际实现用 pg driver parameter binding (防 SQL injection)
    // 返 ChunkWithEmbedding[] (50 candidates, 含 embedding 数组, searchChunks 复用做 trust/recency 加权)
  }

  async function fetchChunksByUser(userId: string): Promise<ChunkWithEmbedding[]> {
    // 兼容 P7 searchChunks 签名, 但实际不直接用 (queryTopK 替代)
    // 仅 admin 真接脚本可能调
    // ...
  }

  return { fetchChunksByUser, queryTopK, testConnection, close };
}

let _store: PgVectorStore | null = null;
export async function getPgVectorStore(): Promise<PgVectorStore> {
  if (_store) return _store;
  const env = getEnv();
  if (!env.PG_CONNECTION_STRING) {
    throw new Error("PG_CONNECTION_STRING not configured");
  }
  _store = createPgVectorStore({ connectionString: env.PG_CONNECTION_STRING });
  return _store;
}
```

### 4.2 `apps/api/scripts/migrate-no-sql-to-pg.ts` (NEW script, ~150 行)

```typescript
/**
 * migrate-no-sql-to-pg.ts — 一次性 ETL: NoSQL chunk → PG chunks (P8 Phase 2)
 *
 * 步骤:
 *   1. Keychain 拉 PG_CONNECTION_STRING + CLOUDBASE_SECRET_ID/KEY
 *   2. CloudBase NoSQL admin SDK 拉所有 chunk 集合 (分页 100)
 *   3. PG INSERT chunks (idempotent, PK 冲突 skip)
 *   4. 进度报告 (count/total/失败)
 *   5. 验证: SELECT count(*) FROM chunks; == NoSQL count
 *
 * 决策:
 *   - 全局 idempotent: 重跑安全 (ON CONFLICT (id) DO NOTHING)
 *   - 失败 chunk 单条 retry 3 次, 最终失败记 audit
 *   - batch 100 chunks/批 (PG prepared statement)
 */

import { execSync } from "node:child_process";
import { Client } from "pg";
// ... see file
```

### 4.3 `apps/api/src/lib/retrieval/__tests__/pg-vector-store.test.ts` (NEW test, ~200 行, 12 cases)

| Case | 覆盖 |
|---|---|
| 1 | 连接 init (mock pg.Pool) |
| 2 | queryTopK happy path (mock 5 chunks return) |
| 3 | userId filter (验证 SQL `user_id = $2` 在 params) |
| 4 | topK * 10 候选 (LIMIT 计算正确) |
| 5 | scoreThreshold (PG 不实现, searchChunks 内存过滤) |
| 6 | sourceTypes 过滤 (ANY($3) in SQL) |
| 7 | excludeSourceIds 排除 (NOT source_id = ANY) |
| 8 | 连接池耗尽 (mock queue.acquire timeout) |
| 9 | connection timeout 3s (mock 触发) |
| 10 | query timeout 3s (mock 触发) |
| 11 | failOpen: PG 失败 → 返 fallback (暴力 cosine mock) |
| 12 | 多次 query 复用 pool (1 个 client 跑多次) |

### 4.4 `apps/api/src/handlers/api-chat.ts` (MODIFIED, ~10 行 diff)

```diff
- // CloudBase 单次回包 1MB 上限；chunk 平均 87KB → limit=8 安全；暴力 cosine 在 production 1963 chunks 下不 work — v2 上向量 DB
- const chunks = await whereQuery<Chunk>(COLLECTIONS.chunk, { userId }, { limit: 8 });
- if (chunks.length === 8) {
-   console.warn(`[api-chat] chunk retrieval hit 8 limit; user ${userId} has more chunks (production 1963) - retrieval 准确度受限; v2 需上向量 DB`);
- }
- const chunksWithEmb: ChunkWithEmbedding[] = chunks.map((c) => ({ ... }));
+ // P8: PG vector store 替换暴力 cosine (limit=8 瓶颈, 命中率低)
+ // VECTOR_STORE=pg 走 PG, VECTOR_STORE=nosql 走 P7 暴力 cosine (灰度回滚)
+ const pgStore = await getPgVectorStore();  // ← 单例, lazy init (PG 连接池)
+ // queryTopK 返 50 candidates (topK * 10), 含 embedding 数组
+ // scoreThreshold 在 SQL WHERE 推; trust/recency 加权走 searchChunks 内存算
+ const chunksWithEmb: ChunkWithEmbedding[] = await pgStore.queryTopK({
+   userId, queryVector: queryVec, topK: 5, scoreThreshold: 0.3,
+   ...(sourceTypes ? { sourceTypes } : {}),
+   ...(excludeSourceIds ? { excludeSourceIds } : {}),
+ });
  const top = await searchChunks({
-   fetchChunksByUser: async () => chunksWithEmb,
+   // fetchChunksByUser 仍 inject, 但 chunksWithEmb 现在来自 PG (50 candidates)
+   fetchChunksByUser: async () => chunksWithEmb,
    userId, queryVector: queryVec, topK: 5, scoreThreshold: 0.3,
    ...(sourceTypes ? { sourceTypes } : {}),
    ...(excludeSourceIds ? { excludeSourceIds } : {}),
  });
```

**关键**: searchChunks `scoreThreshold` 参数跟 queryTopK 的 scoreThreshold 是同一过滤 (PG SQL + 内存). 内存二次过滤是 redundant 但无害 (PG 已过滤 0.3+, 内存再过滤等价).

(`api-ask.ts` + `api-search.ts` 同样 5-10 行 diff, 同样 pattern)

### 4.5 ingest 路径 (MODIFIED, 找现有 ingest handler)

需要找到现有 ingest handler 位置 + 验证是否可 dual-write。

### 4.6 `apps/api/cloudbaserc.json` + Keychain (MODIFIED, 1 env var 加)

```diff
  "envVariables": {
    ...
    "NLI_MIN_ANSWER_LEN": "100",
    "LLM_MAX_TOKENS": "2048",
+   "VECTOR_STORE": "pg",  // P8: "pg" | "nosql", 灰度控制 (default nosql for safe rollout)
  }
```

Keychain 加 1 个 entry: `unequal:api-router:PG_CONNECTION_STRING` (postgres://... 格式).

### 4.7 `apps/api/src/lib/env.ts` (MODIFIED, 1 field + 1 validation)

```diff
  NLI_LOCAL_TMP_DIR?: string;
+ /** P8: vector DB 选型, "pg" = pgvector (HNSW), "nosql" = 暴力 cosine fallback */
+ VECTOR_STORE: "pg" | "nosql";
+ /** P8: pgvector connection string (Keychain, secret 类别) */
+ PG_CONNECTION_STRING?: string;
```

---

## 5. 数据流

### 5.1 ingest (admin 推 PDF/DOCX)

```text
[1] Admin 推 PDF → ingest proxy (api-router)
   ↓
[2] ingest handler 解析 + embed (MiniMax embo-01) + chunk split
   ↓
[3] for each chunk:
    a. write NoSQL chunk (source-of-truth)       ← 同步, 必须成功
    b. write PG chunks row (dual-write)          ← 同步, 但 try/catch, failOpen
       - 失败: console.warn + 跳过 (retrieval 暂时查不到这条, 但 ingest 不失败)
       - 成功: audit log "chunk_indexed_pg"
   ↓
[4] ingest 完成 → admin 收到 200
```

### 5.2 retrieval (用户 chat)

```text
[1] 用户 chat → api-chat handler
   ↓
[2] JWT auth + parse body + find/create session (不变)
   ↓
[3] embed query (MiniMax embo-01, ~1s)
   ↓
[4] VECTOR_STORE=pg → getPgVectorStore() → queryTopK
   VECTOR_STORE=nosql → 现有 whereQuery(limit=500) + 暴力 cosine (P7 行为)
   ↓
[5] searchChunks({fetchChunksByUser, userId, queryVector, topK: 5, ...})
   ↓
[6] top 5 chunks → LLM chat + P5 NLI v1.4 后置 (不变)
```

### 5.3 错误处理表

| 失败场景 | 行为 | 用户可见 | Audit |
|---|---|---|---|
| **PG 连接失败** (cold start / network) | fallback 到暴力 cosine (limit=500) + console.warn | chat 正常返 (略慢) | `pg_retrieval_fallback` + reason=connect_timeout/connect_refused |
| **PG query 超时** (>3s) | fallback + console.warn | chat 正常返 (略慢) | `pg_retrieval_fallback` + reason=query_timeout |
| **PG HNSW 索引损坏** (罕见) | fallback 到暴力全表扫 (无索引) + console.error | chat 正常 (慢) | `pg_retrieval_fallback` + reason=index_corrupted |
| **ingest dual-write PG 失败** | console.warn + 跳过 (不阻塞 ingest) | admin 收 200 | `chunk_pg_write_skip` (per chunk) |
| **PG 写超 max 50MB 单 chunk embedding** | 不会发生 (1536 floats × 8 bytes = 12KB OK) | n/a | 无 |

---

## 6. 测试策略

### 6.1 单元测试 (vitest, 12 cases)

`apps/api/src/lib/retrieval/__tests__/pg-vector-store.test.ts`:
1. 连接 init (mock pg.Pool)
2. queryTopK happy path (mock 5 chunks return)
3. userId filter (验证 SQL `user_id = $2` 在 params)
4. topK * 10 候选 (LIMIT 计算正确)
5. scoreThreshold (PG 不实现, searchChunks 内存过滤)
6. sourceTypes 过滤 (ANY($3) in SQL)
7. excludeSourceIds 排除 (NOT source_id = ANY)
8. 连接池耗尽 (mock queue.acquire timeout)
9. connection timeout 3s (mock 触发)
10. query timeout 3s (mock 触发)
11. failOpen: PG 失败 → 返 fallback (暴力 cosine mock)
12. 多次 query 复用 pool (1 个 client 跑多次)

### 6.2 集成测试 (handler test, 3 cases, one per handler)

`apps/api/test/handlers/api-chat.test.ts` 等:
- api-chat / api-ask / api-search 接 pgStore, 验证 topK=5 正常返, fetchChunksByUser 真被调
- mock pgStore (不真连 PG)
- 复用现有 339 tests pattern (mock 替换)

### 6.3 真接验证 (verify scripts, 4 步)

`scripts/verify-p8-vector-db.ts` (NEW):

| 步 | 命令 | 预期 |
|---|---|---|
| 1 | `pnpm -F api deploy:full` | ✅ 24 vars atomic set, 包含 VECTOR_STORE=pg + PG_CONNECTION_STRING |
| 2 | `pnpm -F api verify:nli-cross-turn` (P8 真接脚本) | ✅ T1 + T2 双轮 200, retrieval P99 < 100ms (新增 latency 字段) |
| 3 | 查 audit_log NLI reject 7 天趋势 | 期待 NLI reject 率从 P7 #3 evidence 30% sample 降至 < 10% |
| 4 | `pnpm -F api deploy:status` | ✅ 25 vars 完整: 14 template + 9 secrets + VECTOR_STORE + PG_CONNECTION_STRING |

### 6.4 成功标准 (vs P7 #3 baseline)

| 指标 | P7 #3 baseline | P8 目标 |
|---|---|---|
| chat 长问 latency | 26.4s (P6 实测) | < 30s (略升可接受, retrieval 50ms + 切换) |
| retrieval P99 latency | ~50ms (暴力 cosine 500 chunks) | < 100ms (PG HNSW 2000 chunks) |
| NLI reject rate | 30%+ sample (P7 #3 evidence) | < 10% (top-5 真 match) |
| audit_log 噪声 | 偶尔 reject | 显著减少 reject 写入 |
| handler 单元测试 | 339/339 | 351+ (12 新 PG cases) |

---

## 7. 迁移 (4 phase, 灰度)

### Phase 1: 建 PG env + schema (1 天, 0 风险)

1. 腾讯云 CloudBase 控制台开 PG 模式 (新建 env `unequal-d4ggf7rwg82e0900b-pg`, 同 region ap-shanghai)
2. `CREATE EXTENSION vector;`
3. `CREATE TABLE chunks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, document_id TEXT NOT NULL, idx INT NOT NULL, content TEXT NOT NULL, embedding vector(1536) NOT NULL, trust_level INT NOT NULL, source_type TEXT, source_id TEXT, created_at BIGINT NOT NULL);`
4. `CREATE INDEX chunks_user_id_idx ON chunks (user_id);`
5. `CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);`
6. `CREATE INDEX chunks_document_id_idx ON chunks (document_id);`
7. env var 加 `VECTOR_STORE=nosql` (default safe) + `PG_CONNECTION_STRING` (Keychain)
8. typecheck + 单元测试 (12 cases) PASS
9. 不动现有 ingest, 不动现有 handler, deploy 24 vars 推云 (P7 #1 验证过)

**回滚**: 删 PG env (独立 env, 不影响其他)

### Phase 2: ETL 一次性迁移 (1-2 小时, 中等风险)

1. `pnpm -F api migrate-no-sql-to-pg`
2. 扫 NoSQL `chunk` 集合所有 user (admin SDK + 分页 100) → 写 PG (`ON CONFLICT (id) DO NOTHING` 幂等)
3. 进度报告: 已迁 / 总数 / 失败
4. 验证: `SELECT count(*) FROM chunks;` 跟 NoSQL count 对齐 (期望 1963 = 真用户 01KVCZ2JRBAGF3MY75D7KEY4RZ 的 chunks)
5. 抽样 5 chunks 人工核对 content + embedding 正确

**回滚**: 不动 (PG 是只读新库, 不影响 NoSQL)

### Phase 3: dual-write ingest (1 天, 低风险)

1. 找现有 ingest handler 位置 (admin 推 PDF/DOCX 入口)
2. 加 PG write step (after NoSQL chunk write, try/catch failOpen)
3. 单元测试: ingest 加 3 cases (PG write success / failOpen / retry)
4. 真接: admin 推 1 PDF, 验 PG 写入 + NoSQL 写入 + console 0 warn
5. 灰度: 不需要 (ingest 写 PG 是 best-effort, 不影响主流程)

**回滚**: 删 PG write step (5 行 diff revert)

### Phase 4: handler 切 PG fetcher (3 天, 灰度)

| Day | 步骤 | 风险 |
|---|---|---|
| Day 1 | env var `VECTOR_STORE=pg` (admin 1 真 user 测试 `01KVCZ2JRBAGF3MY75D7KEY4RZ`) | 低 (单 user) |
| Day 2 | 验 chat 真接 → 跟 P7 #3 对比 NLI reject 率下降, latency P99 < 100ms | 中 (需量化对比) |
| Day 3 | 灰度全量 (默认 VECTOR_STORE=pg, 移除 nosql 兼容代码) | 低 (fallback 已验证) |

**回滚**: env var `VECTOR_STORE=nosql` → handler 用暴力 cosine fallback (1 行 env)

---

## 8. 风险 / 边界

| 风险 | Likelihood | Impact | Mitigation |
|---|---|---|---|
| CloudBase PG 模式不支持 pgvector HNSW (版本问题) | LOW | HIGH | Phase 1 验证: 建表 + HNSW 索引, 跑 1 个 query 看 latency |
| PG connection string 暴露 (审计风险) | MEDIUM | HIGH | 走 Keychain (跟其他 9 secrets 一致); env var 不进 audit_log |
| dual-write PG 失败导致检索缺数据 | MEDIUM | MEDIUM | failOpen warn + 监控; 提供 PG backfill 脚本 (migrate 重跑 idempotent) |
| 1963 chunks migration 时间 > 2h (PG 写入慢) | LOW | LOW | batch 100 + 进度报告; 失败可重跑 |
| 跨 region 延迟 (PG 不同 region) | LOW | MEDIUM | PG env 同 region (ap-shanghai, 跟 CloudBase 函数) |
| HNSW ef_search 调优 | MEDIUM | LOW | 默认 40, 真接看 P99; 调优加 env var `PG_EF_SEARCH` |
| chunks/user > 10K 时 HNSW 性能退化 | LOW | MEDIUM | 实测 P99, 不优则改 m=32 或换 IVF 索引; 监控 |
| pgvector 版本 bug (已知有 0.5.0 segment fault) | LOW | HIGH | 锁版本 ≥ 0.7.0; 监控 PG 端 errors |
| PG 实例计费 (PG 模式 CloudBase 计费) | LOW | LOW | 调研确认 PG 模式价格; 用户接受新 PG env 增量成本 |
| 跨 env 数据同步 (admin ingest → PG env) | LOW | MEDIUM | dual-write 在 api-router 函数内 (同 VPC); Phase 3 验证 |

### 已知限制

1. **PG env 与现有 env 独立**: 跨 env 数据访问需走函数内 dual-write, 不能 SQL join
2. **pgvector 不支持中文分词 / BM25**: 纯向量召回, 不做 hybrid search (YAGNI)
3. **HNSW 不可变**: 索引 build 一次性, 大量 insert 需 `REINDEX` (日常 1963 chunks 不触发)
4. **max=2 connection pool**: 高并发场景会 queue (CloudBase 函数 256MB 限制), 但单 user 串行够用
5. **schema 升级需 migration**: 加列需 `ALTER TABLE`, 不像 NoSQL 弹性

---

## 9. 真接验证 (post-Phase 4)

| 验证 | 命令 | 通过标准 |
|---|---|---|
| **基础** | `pnpm -F api test` | 351+/351+ tests PASS (12 新 PG cases) |
| **基础** | `pnpm -F api typecheck` | 干净 |
| **部署** | `pnpm -F api deploy:full` | 25 vars atomic set, audit diff +2 -0 ~0 |
| **真接** | `pnpm -F api verify:nli-cross-turn` (P8 现有) | T1 + T2 双轮 200, latency P99 < 100ms (retrieval 部分) |
| **真接** | `pnpm -F api verify:nli-real-user` (P7 #3) | 长问 NLI reject rate 下降 (跟 P7 #3 audit_log 对比) |
| **真接** | 7 天 audit_log 趋势 | `chat_nli_reject` action 数量减少 50%+ vs P7 7 天基线 |
| **状态** | `pnpm -F api deploy:status` | 25 vars 完整: 14 template + 9 secrets + VECTOR_STORE + PG_CONNECTION_STRING |

---

## 10. 关联

- **P5 v1.3 NLI spec** (`2026-06-23-p5-nli-entailment-design.md`) — 本 PR 解决 NLI 真接 reject 主因
- **P6 ONNX NLI spec** (`2026-06-25-p6-local-onnx-nli-design.md`) — NLI 推理本地化, 本 PR 解决 NLI 输入端 (retrieval)
- **2026-06-23 ask-search-retrieval-limit spec** (`2026-06-23-ask-search-retrieval-limit-design.md`) — §6 v2 留路 #3 触发
- **P7 follow-up 收官** (`state-p7-p8-followup-completion.md`) — 当前状态基线
- **state-arch-v2.3.md** — CloudBase 限制事实稳定

---

## 11. References

- 腾讯云 CloudBase PG 模式: https://docs.cloudbase.net/database/pg
- pgvector 文档: https://github.com/pgvector/pgvector
- pgvector HNSW 索引: https://github.com/pgvector/pgvector#hnsw
- node-postgres 8.x: https://node-postgres.com/
- CloudBase 跨 env 集成: https://docs.cloudbase.net/ai/cloudbase-ai-toolkit/mcp-tools
- Tencent Cloud VectorDB 对比: https://intl.cloud.tencent.com/products/vdb
