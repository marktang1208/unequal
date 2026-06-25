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
 * CLI 入口 (P8 真接 follow-up #6 收尾, 2026-06-25):
 *   - 读 PG_CONNECTION_STRING + CLOUDBASE_SECRET_ID/KEY from macOS Keychain
 *   - 连 NoSQL (CloudBase d4ggf7rwg82e0900b) + PG (vpc 内网)
 *   - 跑 migrateNoSqlToPg 一次性 ETL
 *   - 退出码: 0=全成功, 1=有失败
 *
 * 用法: pnpm -F api migrate:no-sql-to-pg
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

// CLI 入口 (P8 真接 follow-up #6, 2026-06-25)
if (import.meta.url === `file://${process.argv[1]}`) {
  const { execSync } = await import("node:child_process");
  const { default: pgPkg } = await import("pg");

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

  // 动态 import @cloudbase/node-sdk (避免 vitest 跑测试时执行 CLI)
  // 注: dynamic import 返 namespace object, 需 .default 取 default export
  const cloudbaseMod = await import("@cloudbase/node-sdk");
  const cloudbase = (cloudbaseMod as { default: typeof import("@cloudbase/node-sdk").default }).default;
  const app = cloudbase.init({ env: "unequal-d4ggf7rwg82e0900b", secretId: SECID, secretKey: SECKEY });
  const db = app.database();
  // 注: 不要预 connect — migrateNoSqlToPg 内部会调 pgAdapter.connect()
  // 重复 connect 会抛 "Client has already been connected"
  // 注2: pg.Client 没有 .release() (那是 Pool 用的), 加 shim 让 migrateNoSqlToPg finally 块能调
  const pg = new pgPkg.Client({ connectionString: PG_CONNECTION_STRING });

  console.log("[ETL CLI] start: NoSQL chunk → PG chunks (batch=100, retry=3)");
  const result = await migrateNoSqlToPg({
    noSqlAdapter: {
      whereQuery: async (coll, where, opts) => {
        // CloudBase NoSQL SDK query builder 用 .skip() 不用 .offset() (plan 漏)
        // 实际 db.ts 项目内代码也用 .skip() (见 src/lib/db.ts:line)
        const r = await db.collection(coll)
          .where(where)
          .limit((opts as { limit?: number }).limit ?? 100)
          .skip((opts as { offset?: number }).offset ?? 0)
          .get();
        return { data: r.data as never[], requestId: r.requestId };
      },
    },
    // 给 pg.Client 套一层适配 migrateNoSqlToPg 期望的 adapter 形状:
    //   - connect() 返 { query, release }
    //   - end() 关连接
    // pg.Client.connect() 返 client (无 .release), 加 shim
    pgAdapter: {
      connect: async () => {
        await pg.connect();
        return {
          query: (sql: string, params?: unknown[]) => pg.query(sql, params),
          release: () => {
            // pg.Client 无 release, 用 end() 代替
            return pg.end().catch(() => {});
          },
        };
      },
      end: async () => {
        try { await pg.end(); } catch { /* already ended */ }
      },
    } as any,
    log: (msg: string) => console.log(msg),
  });

  console.log(`[ETL CLI] DONE ${JSON.stringify({ total: result.total, migrated: result.migrated, failed: result.failed })}`);
  if (result.failed > 0) {
    console.error(`[ETL CLI] FAILED chunks (first 10): ${JSON.stringify(result.failedIds.slice(0, 10))}`);
    process.exit(1);
  }
  process.exit(0);
}