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

import type { ChunkWithEmbedding } from "@unequal/shared/retrieval";
import type { TrustLevel } from "@unequal/shared/types";
import type { Pool as PgPool, PoolClient } from "pg";

export interface PgVectorStoreOptions {
  connectionString: string;
  /** 测试用: 注入 mock pg module (默认 require("pg"))。
   *  支持两种形态: 1) `{ Pool: SomeConstructor }` — 走 new Pool(opts)
   *               2) `{ Pool: SomePoolInstance }` — 已是 pool 实例,直接复用 (test 用 connect/end/on) */
  pgModule?: { Pool: typeof PgPool | PgPool };
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
  const PgModule = opts.pgModule ?? require("pg") as { Pool: typeof PgPool | PgPool };

  // 兼容两种 mock 形态: 1) Pool 是 constructor → new 实例; 2) Pool 已是 instance → 直接复用
  let pool: PgPool;
  if (typeof PgModule.Pool === "function") {
    pool = new (PgModule.Pool as typeof PgPool)({
      connectionString: opts.connectionString,
      max: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000,
    });
  } else {
    // 已是 instance — 测试用例传对象 { connect, end, on } 时走这里
    pool = PgModule.Pool as PgPool;
  }
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