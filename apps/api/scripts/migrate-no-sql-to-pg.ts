/**
 * migrate-no-sql-to-pg.ts — 一次性 ETL: NoSQL chunk 集合 → PG chunks 表 (P8 Phase 2)
 *
 * 步骤:
 *   1. 拉所有 NoSQL chunk 集合 (分页 batchSize, 通过 noSqlAdapter.whereQuery)
 *   2. PG INSERT chunks (idempotent, ON CONFLICT (id) DO NOTHING)
 *   3. 进度报告 (migrated/total/failed)
 *   4. 失败 chunk 收集到 failedIds (审计/重跑)
 *
 * 决策:
 *   - 全局 idempotent: 重跑安全
 *   - 失败 chunk 3 次 retry (指数退避 retryDelay * attempt)
 *   - 默认 batchSize=100 chunks/批
 *   - log 默认空函数, 测试可注入
 *
 * CLI 入口待 Phase 2 末添加 (Keychain + cloudbase admin SDK)
 */

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

interface PgClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
  release: () => void;
}

interface PgAdapter {
  connect: () => Promise<PgClient>;
  end: () => Promise<void>;
}

export interface MigrateOpts {
  noSqlAdapter: NoSqlAdapter;
  pgAdapter: PgAdapter;
  batchSize?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  log?: (msg: string) => void;
}

export interface MigrateResult {
  total: number;
  migrated: number;
  failed: number;
  failedIds: string[];
}

export async function migrateNoSqlToPg(opts: MigrateOpts): Promise<MigrateResult> {
  const batchSize = opts.batchSize ?? 100;
  const retryAttempts = opts.retryAttempts ?? 3;
  const retryDelay = opts.retryDelayMs ?? 100;
  const log = opts.log ?? (() => {});
  const COLLECTION = "chunk";
  const result: MigrateResult = { total: 0, migrated: 0, failed: 0, failedIds: [] };

  const client = await opts.pgAdapter.connect();
  try {
    let offset = 0;
    while (true) {
      const { data } = await opts.noSqlAdapter.whereQuery(COLLECTION, {}, { limit: batchSize, offset });
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
      offset += batchSize;
      // 关键: 当返回数据少于 batchSize 时终止 (云 NoSQL 分页最后一页 < limit)
      if (data.length < batchSize) break;
    }
    log(`[ETL] DONE total=${result.total} migrated=${result.migrated} failed=${result.failed}`);
    return result;
  } finally {
    client.release();
    await opts.pgAdapter.end();
  }
}