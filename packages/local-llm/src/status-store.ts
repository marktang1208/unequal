/**
 * P3-7 / Phase B: StatusStore — SQLite 暂存 + 状态机
 *
 * 迁移自 `apps/admin/server/status-store.ts`（CP-7-C 引入）。P3-7 抽到
 * `packages/local-llm/` 共享包（admin + crawler 共同写入同一份 SQLite，
 * 让 admin UI 能看到 crawler 暂存条目）。
 *
 * SQLite schema (spec §4.2)：
 *   - file_id (uuid) PRIMARY KEY
 *   - batch_id (uuid, 一组上传)
 *   - filename / ext / tmp_path (或 tmp_data blob for v1 in-memory)
 *   - status: pending | parsing | chunking | embedding | pushing | done | failed
 *   - progress 0-100
 *   - markdown_chars / chunks_count
 *   - markdown / chunks_json (缓存解析结果便于 retry)
 *   - error_code / error_message
 *   - cloud_source_id / cloud_document_id
 *   - retry_count / retryable (0/1)
 *   - created_at / updated_at
 *
 * 用 better-sqlite3（同步库 + WAL mode = 多读单写不冲突）
 *
 * P3-7 增量：
 *   - create() 接受 markdown / chunks_json / metadata / markdown_chars / chunks_count 可选参数
 *     （crawler 路径直接带 markdown 入库，避免重解析）
 *   - T3 阶段会再加 `source` 列（区分 upload vs crawler）和 `metadata TEXT` 列
 *     本文件暂保留 metadata 作为 create 参数但不持久化（schema 暂无列）
 *   - zhenjie6: 加 `chunks_with_emb_json` 列（持久化 chunks + embeddings 1536 floats）
 *     retry 时直接读，跳过 parse/chunk/embed 全流程（仅重 push）
 *     1520 chunks ≈ 19MB/record（大但可接受；只在 push 成功后写，failed 不污染）
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type FileStatus = "pending" | "parsing" | "chunking" | "embedding" | "pushing" | "done" | "failed";
export type IngestSource = "upload" | "crawler";

export interface IngestRecord {
  file_id: string;
  batch_id: string;
  filename: string;
  ext: string;
  status: FileStatus;
  progress: number;
  tmp_data: Buffer | null;
  markdown: string | null;
  chunks_json: string | null;
  /** zhenjie6: 持久化 chunks + embeddings 1536 floats，retry 跳过 parse/chunk/embed */
  chunks_with_emb_json: string | null;
  markdown_chars: number | null;
  chunks_count: number | null;
  error_code: string | null;
  error_message: string | null;
  cloud_source_id: string | null;
  cloud_document_id: string | null;
  retry_count: number;
  retryable: 0 | 1;
  created_at: number;
  updated_at: number;
  /** P3-7 / Phase C: 区分 upload vs crawler（admin-upload 默认 'upload'，crawler 写 'crawler'） */
  source: IngestSource;
  /** P3-7 / Phase C: crawler metadata JSON 序列化（crawl_depth/source_domain/crawled_at/parent_url） */
  metadata: string | null;
  /** P3-7 / Phase C: 信任级 0-3（admin-upload multipart 传，crawler 默认 1，handleManualPush 可 override） */
  trust_level: 0 | 1 | 2 | 3;
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS local_ingest (
  file_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  ext TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER DEFAULT 0,
  tmp_data BLOB,
  markdown TEXT,
  chunks_json TEXT,
  markdown_chars INTEGER,
  chunks_count INTEGER,
  error_code TEXT,
  error_message TEXT,
  cloud_source_id TEXT,
  cloud_document_id TEXT,
  retry_count INTEGER DEFAULT 0,
  retryable INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batch ON local_ingest(batch_id);
CREATE INDEX IF NOT EXISTS idx_status ON local_ingest(status);
`;

/** P3-7 / Phase C: 增量 ALTER（existing rows 自动填 source='upload'） */
const SCHEMA_MIGRATIONS = [
  `ALTER TABLE local_ingest ADD COLUMN source TEXT NOT NULL DEFAULT 'upload'`,
  `ALTER TABLE local_ingest ADD COLUMN metadata TEXT`,
  `ALTER TABLE local_ingest ADD COLUMN trust_level INTEGER DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_source_status ON local_ingest(source, status)`,
];

/** zhenjie6: chunks_with_emb_json 持久化（retry 跳过 parse/chunk/embed） */
const SCHEMA_MIGRATION_ZHENJIE6 = [
  `ALTER TABLE local_ingest ADD COLUMN chunks_with_emb_json TEXT`,
];

function getTableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function applyMigrations(db: Database.Database): void {
  const columns = getTableColumns(db, "local_ingest");
  if (!columns.has("source")) {
    db.exec(SCHEMA_MIGRATIONS[0]!);
  }
  if (!columns.has("metadata")) {
    db.exec(SCHEMA_MIGRATIONS[1]!);
  }
  // P3-7: trust_level 列原 admin-upload 没存表（admin-upload spec §3.3 multipart 收但没持久化）。
  // 这次加上：handleManualPush 推送时需要读 record.trust_level。
  if (!columns.has("trust_level")) {
    db.exec(SCHEMA_MIGRATIONS[2]!);
  }
  // idx_source_status 用 CREATE INDEX IF NOT EXISTS 幂等创建
  db.exec(SCHEMA_MIGRATIONS[3]!);
  // zhenjie6: chunks_with_emb_json
  if (!columns.has("chunks_with_emb_json")) {
    for (const stmt of SCHEMA_MIGRATION_ZHENJIE6) db.exec(stmt);
  }
}

export class StatusStore {
  private db: Database.Database;

  constructor(dbPath: string = ".tmp/unequal.db") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA_V1);
    applyMigrations(this.db);
  }

  create(input: {
    file_id: string;
    batch_id: string;
    filename: string;
    ext: string;
    tmp_data?: Buffer | null;
    /** P3-7 / Phase B: crawler 路径直接带 markdown 入库（避免重解析） */
    markdown?: string | null;
    chunks_json?: string | null;
    /** zhenjie6: 持久化 chunks + embeddings 1536 floats，retry 跳过 parse/chunk/embed */
    chunks_with_emb_json?: string | null;
    markdown_chars?: number | null;
    chunks_count?: number | null;
    /** P3-7 / Phase B/C: crawler metadata（crawl_depth/source_domain/crawled_at/parent_url） JSON 序列化 */
    metadata?: string | null;
    /** P3-7 / Phase C: source 区分 upload/crawler；默认 'upload'（admin-upload 路径） */
    source?: IngestSource;
    /** P3-7 / Phase C: 信任级 0-3；admin-upload 默认 0，crawler 默认 1（trigger.ts 显式传） */
    trust_level?: 0 | 1 | 2 | 3;
    status?: FileStatus;
    progress?: number;
    retry_count?: number;
    retryable?: 0 | 1;
    created_at?: number;
    updated_at?: number;
  }): IngestRecord {
    const now = input.created_at ?? Date.now();
    const record: IngestRecord = {
      file_id: input.file_id,
      batch_id: input.batch_id,
      filename: input.filename,
      ext: input.ext,
      status: input.status ?? "pending",
      progress: input.progress ?? 0,
      tmp_data: input.tmp_data ?? null,
      markdown: input.markdown ?? null,
      chunks_json: input.chunks_json ?? null,
      chunks_with_emb_json: input.chunks_with_emb_json ?? null,
      markdown_chars: input.markdown_chars ?? null,
      chunks_count: input.chunks_count ?? null,
      error_code: null,
      error_message: null,
      cloud_source_id: null,
      cloud_document_id: null,
      retry_count: input.retry_count ?? 0,
      retryable: input.retryable ?? 0,
      created_at: now,
      updated_at: input.updated_at ?? now,
      source: input.source ?? "upload",
      metadata: input.metadata ?? null,
      trust_level: input.trust_level ?? 0,
    };
    this.db.prepare(`
      INSERT INTO local_ingest (
        file_id, batch_id, filename, ext, status, progress,
        tmp_data, markdown, chunks_json, chunks_with_emb_json, markdown_chars, chunks_count,
        error_code, error_message, cloud_source_id, cloud_document_id,
        retry_count, retryable, created_at, updated_at,
        source, metadata, trust_level
      ) VALUES (
        @file_id, @batch_id, @filename, @ext, @status, @progress,
        @tmp_data, @markdown, @chunks_json, @chunks_with_emb_json, @markdown_chars, @chunks_count,
        @error_code, @error_message, @cloud_source_id, @cloud_document_id,
        @retry_count, @retryable, @created_at, @updated_at,
        @source, @metadata, @trust_level
      )
    `).run(record);
    return record;
  }

  update(fileId: string, patch: Partial<Omit<IngestRecord, "file_id" | "batch_id" | "created_at">>): IngestRecord | null {
    const existing = this.getByFileId(fileId);
    if (!existing) return null;
    const fields = Object.keys(patch);
    if (fields.length === 0) return existing;
    const setClause = fields.map((f) => `${f} = @${f}`).join(", ");
    const stmt = this.db.prepare(`UPDATE local_ingest SET ${setClause}, updated_at = @updated_at WHERE file_id = @file_id`);
    const params: Record<string, unknown> = { file_id: fileId, updated_at: Date.now() };
    for (const f of fields) {
      params[f] = (patch as Record<string, unknown>)[f];
    }
    stmt.run(params);
    return this.getByFileId(fileId);
  }

  getByFileId(fileId: string): IngestRecord | null {
    const row = this.db.prepare("SELECT * FROM local_ingest WHERE file_id = ?").get(fileId) as IngestRecord | undefined;
    return row ?? null;
  }

  listByBatch(batchId: string): IngestRecord[] {
    return this.db.prepare("SELECT * FROM local_ingest WHERE batch_id = ? ORDER BY created_at ASC").all(batchId) as IngestRecord[];
  }

  /** P3-7 / Phase C: 按 source + 可选 status 过滤 */
  listBySource(source: IngestSource, status?: FileStatus, limit?: number): IngestRecord[] {
    if (status) {
      return this.db.prepare(
        "SELECT * FROM local_ingest WHERE source = ? AND status = ? ORDER BY created_at ASC" + (limit ? " LIMIT ?" : ""),
      ).all(...(limit ? [source, status, limit] : [source, status])) as IngestRecord[];
    }
    return this.db.prepare(
      "SELECT * FROM local_ingest WHERE source = ? ORDER BY created_at ASC" + (limit ? " LIMIT ?" : ""),
    ).all(...(limit ? [source, limit] : [source])) as IngestRecord[];
  }

  /** P3-7 / Phase C: 列所有 pending record（不限 source） */
  listPending(limit?: number): IngestRecord[] {
    return this.db.prepare(
      "SELECT * FROM local_ingest WHERE status = 'pending' ORDER BY created_at ASC" + (limit ? " LIMIT ?" : ""),
    ).all(...(limit ? [limit] : [])) as IngestRecord[];
  }

  /** P3-7 / Phase C: 按 batch_id 查（admin UI 启动爬虫后用） */
  getByBatchId(batchId: string): IngestRecord[] {
    return this.listByBatch(batchId);
  }

  /** P3-7 / Phase C: 按 batch_id 计数（crawler 子进程用） */
  countByBatchId(batchId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM local_ingest WHERE batch_id = ?").get(batchId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  listRetryable(): IngestRecord[] {
    return this.db.prepare("SELECT * FROM local_ingest WHERE retryable = 1 AND status = 'failed'").all() as IngestRecord[];
  }

  resetForRetry(fileId: string): IngestRecord | null {
    return this.update(fileId, {
      status: "pending",
      progress: 0,
      error_code: null,
      error_message: null,
      retry_count: 0,
      updated_at: Date.now(),
    });
  }

  markFailed(fileId: string, code: string, message: string, retryable: boolean): IngestRecord | null {
    const existing = this.getByFileId(fileId);
    if (!existing) return null;
    return this.update(fileId, {
      status: "failed",
      progress: 0,
      error_code: code,
      error_message: message,
      retryable: retryable ? 1 : 0,
      retry_count: existing.retry_count + 1,
    });
  }

  markDone(fileId: string, sourceId: string, documentId: string): IngestRecord | null {
    return this.update(fileId, {
      status: "done",
      progress: 100,
      cloud_source_id: sourceId,
      cloud_document_id: documentId,
      error_code: null,
      error_message: null,
    });
  }

  setStatus(fileId: string, status: FileStatus, progress: number): IngestRecord | null {
    return this.update(fileId, { status, progress });
  }

  close(): void {
    this.db.close();
  }
}
