/**
 * P3-7 种子 URL 库: seeds-loader
 *
 * crawler 启动时读 JSON 同步到 SQLite + 排序 + 取 limit
 * 共享 admin `crawler_seeds` 表（.tmp/unequal.db）
 *
 * 设计：
 * - loadOne(source) / loadAll()：返回带 runtime 状态的 SeedRecord[]
 * - 排序：active DESC + last_crawled_at IS NULL DESC + last_crawled_at ASC + url ASC
 * - markCrawled(url, status, error?)：被 trigger.ts 调用，更新 runtime 状态
 *
 * 注意：crawler 端在 runtime 直接调 markCrawled（不写 JSON，runtime 字段不入 JSON）。
 */

import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type SeedSource = "xhs" | "wechat-mp" | "webpage";
export type SeedLastStatus = "done" | "failed" | "pending" | null;

export interface SeedRecord {
  url: string;
  source: SeedSource;
  trust_level: 0 | 1 | 2 | 3;
  active: boolean;
  last_crawled_at: string | null;
  last_status: SeedLastStatus;
  last_crawled_at_ms: number | null;
  last_error: string | null;
  retry_count: number;
  created_at_ms: number;
  updated_at_ms: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crawler_seeds (
  url TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  trust_level INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_crawled_at INTEGER,
  last_status TEXT,
  last_error TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seeds_source_active ON crawler_seeds(source, active);
CREATE INDEX IF NOT EXISTS idx_seeds_last_crawled ON crawler_seeds(last_crawled_at);
`;

export interface LoadOptions {
  limit?: number;
  /** 包含 inactive（默认 false = 只返 active=true） */
  includeInactive?: boolean;
}

export class SeedsLoader {
  private db: Database.Database;

  constructor(dbPath: string = ".tmp/unequal.db") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  /** 单 source 加载（按 active + last_crawled_at 排序 + 可选 limit） */
  loadOne(source: SeedSource, opts: LoadOptions = {}): SeedRecord[] {
    return this.loadInternal(
      opts.includeInactive ? "" : " AND active = 1",
      [source],
      opts.limit,
    );
  }

  /** 全 source 合并（按相同排序） */
  loadAll(opts: LoadOptions = {}): SeedRecord[] {
    return this.loadInternal(
      opts.includeInactive ? "" : " AND active = 1",
      ["xhs", "wechat-mp", "webpage"],
      opts.limit,
    );
  }

  private loadInternal(extraWhere: string, sources: SeedSource[], limit?: number): SeedRecord[] {
    const placeholders = sources.map(() => "?").join(",");
    const sql = `
      SELECT url, source, trust_level, active, last_crawled_at, last_status, last_error, retry_count, created_at, updated_at
      FROM crawler_seeds
      WHERE source IN (${placeholders})${extraWhere}
      ORDER BY
        active DESC,
        (last_crawled_at IS NULL) DESC,
        last_crawled_at ASC,
        url ASC
      ${limit ? "LIMIT ?" : ""}
    `;
    const params: Array<string | number> = [...sources];
    if (limit) params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      url: string; source: string; trust_level: number; active: number;
      last_crawled_at: number | null; last_status: string | null; last_error: string | null;
      retry_count: number; created_at: number; updated_at: number;
    }>;
    return rows.map((r) => ({
      url: r.url,
      source: r.source as SeedSource,
      trust_level: r.trust_level as 0 | 1 | 2 | 3,
      active: r.active === 1,
      last_crawled_at: r.last_crawled_at ? new Date(r.last_crawled_at).toISOString() : null,
      last_status: r.last_status as SeedLastStatus,
      last_crawled_at_ms: r.last_crawled_at,
      last_error: r.last_error,
      retry_count: r.retry_count,
      created_at_ms: r.created_at,
      updated_at_ms: r.updated_at,
    }));
  }

  /** 标记单 URL 爬取完成（成功或失败） */
  markCrawled(url: string, status: "done" | "failed", error?: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE crawler_seeds
      SET last_crawled_at = ?, last_status = ?, last_error = ?, retry_count = retry_count + 1, updated_at = ?
      WHERE url = ?
    `).run(now, status, error ?? null, now, url);
  }

  close(): void {
    this.db.close();
  }
}