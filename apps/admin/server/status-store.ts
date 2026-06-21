/**
 * CP-7-C: StatusStore — SQLite 暂存 + 6 状态机
 *
 * SQLite schema: spec §4.2
 * - file_id (uuid) PRIMARY KEY
 * - batch_id (uuid, 一组上传)
 * - filename / ext / tmp_path (或 tmp_data blob for v1 in-memory)
 * - status: pending | parsing | chunking | embedding | pushing | done | failed
 * - progress 0-100
 * - markdown_chars / chunks_count
 * - markdown / chunks_json (缓存解析结果便于 retry)
 * - error_code / error_message
 * - cloud_source_id / cloud_document_id
 * - retry_count / retryable (0/1)
 * - created_at / updated_at
 *
 * 用 better-sqlite3（同步库 + WAL mode = 多读单写不冲突）
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type FileStatus = "pending" | "parsing" | "chunking" | "embedding" | "pushing" | "done" | "failed";

export interface IngestRecord {
  file_id: string;
  batch_id: string;
  filename: string;
  ext: string;
  status: FileStatus;
  progress: number;
  tmp_data: Buffer | null;       // v1 in-memory；T9 改写文件
  markdown: string | null;
  chunks_json: string | null;     // JSON 序列化
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
}

const SCHEMA = `
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

export class StatusStore {
  private db: Database.Database;

  constructor(dbPath: string = ".tmp/unequal.db") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  create(input: {
    file_id: string;
    batch_id: string;
    filename: string;
    ext: string;
    tmp_data?: Buffer;
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
      markdown: null,
      chunks_json: null,
      markdown_chars: null,
      chunks_count: null,
      error_code: null,
      error_message: null,
      cloud_source_id: null,
      cloud_document_id: null,
      retry_count: input.retry_count ?? 0,
      retryable: input.retryable ?? 0,
      created_at: now,
      updated_at: input.updated_at ?? now,
    };
    this.db.prepare(`
      INSERT INTO local_ingest (
        file_id, batch_id, filename, ext, status, progress,
        tmp_data, markdown, chunks_json, markdown_chars, chunks_count,
        error_code, error_message, cloud_source_id, cloud_document_id,
        retry_count, retryable, created_at, updated_at
      ) VALUES (
        @file_id, @batch_id, @filename, @ext, @status, @progress,
        @tmp_data, @markdown, @chunks_json, @markdown_chars, @chunks_count,
        @error_code, @error_message, @cloud_source_id, @cloud_document_id,
        @retry_count, @retryable, @created_at, @updated_at
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

  listRetryable(): IngestRecord[] {
    return this.db.prepare("SELECT * FROM local_ingest WHERE retryable = 1 AND status = 'failed'").all() as IngestRecord[];
  }

  resetForRetry(fileId: string): IngestRecord | null {
    return this.update(fileId, {
      status: "pending",
      progress: 0,
      error_code: null,
      error_message: null,
      retry_count: 0,        // 简化：retry 重置计数
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
