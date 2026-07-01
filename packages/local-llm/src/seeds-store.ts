/**
 * P3-7 种子 URL 库: SeedsStore
 *
 * 数据层：JSON 文件 (source of truth) ↔ SQLite `crawler_seeds` 表 (UI 视图)
 *
 * 设计：
 * - JSON 文件路径：`apps/crawler/seeds/{source}.json` (相对 monorepo root)
 * - SQLite 表：`crawler_seeds` (admin `.tmp/unequal.db`，与 local_ingest 同 db)
 * - 同步策略：UI 增删改 → 立即写 SQLite + 立即写 JSON（单 admin 无冲突）
 * - syncFromJson：读 JSON → 写 SQLite（INSERT OR REPLACE；保留 last_crawled_at from existing SQLite if URL exists）
 *
 * Schema (per URL record)：
 * - url: 主键
 * - source: "xhs" | "wechat-mp" | "webpage"
 * - trust_level: 0-3
 * - active: 0 | 1
 * - last_crawled_at: ms epoch | null
 * - last_status: "done" | "failed" | "pending" | null
 * - last_error: string | null
 * - retry_count: number
 * - created_at: ms epoch
 * - updated_at: ms epoch
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readJsonAtomic, writeJsonAtomic, withFileLock } from "@unequal/local-llm";

export type SeedSource = "xhs" | "wechat-mp" | "webpage" | "pdf";
export type SeedLastStatus = "done" | "failed" | "pending" | null;

export interface SeedUrl {
  url: string;
  trust_level: 0 | 1 | 2 | 3;
  active: boolean;
  last_crawled_at?: string | null;
  last_status?: SeedLastStatus;
  last_error?: string | null;
}

export interface SeedFile {
  source: SeedSource;
  version: number;
  updated_at: string;
  urls: SeedUrl[];
}

export interface SeedRecord extends SeedUrl {
  source: SeedSource;
  /** 来自 SQLite 的 runtime 字段（JSON 文件没这些） */
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

const VALID_SOURCES: SeedSource[] = ["xhs", "wechat-mp", "webpage", "pdf"];

function isSeedSource(s: string): s is SeedSource {
  return (VALID_SOURCES as string[]).includes(s);
}

function validateUrl(url: string): void {
  if (!url || typeof url !== "string") {
    throw new Error("SeedsStore: url must be non-empty string");
  }
  try {
    new URL(url);
  } catch {
    throw new Error(`SeedsStore: url invalid: ${url}`);
  }
}

function validateTrustLevel(t: number): void {
  if (!Number.isFinite(t) || t < 0 || t > 3 || !Number.isInteger(t)) {
    throw new Error(`SeedsStore: trust_level must be integer 0-3, got ${t}`);
  }
}

export class SeedsStore {
  private db: Database.Database;
  private seedsDir: string;

  /**
   * @param dbPath admin 共享 SQLite 路径（默认 .tmp/unequal.db，与 local_ingest 同库）
   * @param seedsDir 种子 JSON 文件目录（相对 monorepo root）
   */
  constructor(
    dbPath: string = ".tmp/unequal.db",
    seedsDir: string = "../apps/crawler/seeds",
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
    // 解析 seedsDir 为绝对路径（相对 cwd）
    this.seedsDir = resolve(process.cwd(), seedsDir);
  }

  /** 单 source JSON 文件路径 */
  private filePath(source: SeedSource): string {
    return join(this.seedsDir, `${source}.json`);
  }

  /** 读 JSON 文件 → 返 SeedFile（不存在返 null） */
  loadFile(source: SeedSource): SeedFile | null {
    const file = this.filePath(source);
    return readJsonAtomic<SeedFile>(file);
  }

  /** 写 JSON 文件（原子写） */
  private async saveFile(source: SeedSource, data: SeedFile): Promise<void> {
    const file = this.filePath(source);
    await withFileLock(file, () => writeJsonAtomic(file, data));
  }

  /**
   * 同步：读 JSON → 写 SQLite（INSERT OR REPLACE on url）。
   * 保留 last_crawled_at / last_status / last_error / retry_count from existing SQLite if URL exists。
   */
  syncFromJson(source: SeedSource): SeedRecord[] {
    const file = this.loadFile(source);
    if (!file) return [];
    const now = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO crawler_seeds (url, source, trust_level, active, last_crawled_at, last_status, last_error, retry_count, created_at, updated_at)
      VALUES (@url, @source, @trust_level, @active, @last_crawled_at_ms, @last_status, @last_error, @retry_count, @created_at_ms, @updated_at_ms)
      ON CONFLICT(url) DO UPDATE SET
        source = excluded.source,
        trust_level = excluded.trust_level,
        active = excluded.active,
        updated_at = excluded.updated_at
    `);
    const records: SeedRecord[] = [];
    const tx = this.db.transaction((urls: SeedUrl[]) => {
      for (const u of urls) {
        const existing = this.db.prepare("SELECT last_crawled_at, last_status, last_error, retry_count, created_at FROM crawler_seeds WHERE url = ?").get(u.url) as
          | { last_crawled_at: number | null; last_status: string | null; last_error: string | null; retry_count: number; created_at: number }
          | undefined;
        const last_crawled_at_ms = existing?.last_crawled_at ?? null;
        const last_status = existing?.last_status ?? null;
        const last_error = existing?.last_error ?? null;
        const retry_count = existing?.retry_count ?? 0;
        const created_at_ms = existing?.created_at ?? now;
        insert.run({
          url: u.url,
          source,
          trust_level: u.trust_level,
          active: u.active ? 1 : 0,
          last_crawled_at_ms,
          last_status,
          last_error,
          retry_count,
          created_at_ms,
          updated_at_ms: now,
        });
        records.push(this.toRecord(source, u, last_crawled_at_ms, last_error, retry_count, created_at_ms, now));
      }
    });
    tx(file.urls);
    return records;
  }

  /** 同步 3 个 source 的所有 JSON → SQLite（admin UI 启动时一次） */
  syncAllFromJson(): void {
    for (const source of VALID_SOURCES) {
      this.syncFromJson(source);
    }
  }

  /** 查 SQLite 单 source 所有记录（含 runtime 状态） */
  listBySource(source: SeedSource): SeedRecord[] {
    const rows = this.db.prepare(`
      SELECT url, source, trust_level, active, last_crawled_at, last_status, last_error, retry_count, created_at, updated_at
      FROM crawler_seeds WHERE source = ? ORDER BY
        active DESC,
        (last_crawled_at IS NULL) DESC,
        last_crawled_at ASC,
        url ASC
    `).all(source) as Array<{
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

  /** 单 record 查询 */
  getByUrl(url: string): SeedRecord | null {
    const row = this.db.prepare("SELECT * FROM crawler_seeds WHERE url = ?").get(url) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      url: row.url as string,
      source: row.source as SeedSource,
      trust_level: row.trust_level as 0 | 1 | 2 | 3,
      active: row.active === 1,
      last_crawled_at: row.last_crawled_at ? new Date(row.last_crawled_at as number).toISOString() : null,
      last_status: row.last_status as SeedLastStatus,
      last_crawled_at_ms: (row.last_crawled_at as number | null) ?? null,
      last_error: row.last_error as string | null,
      retry_count: row.retry_count as number,
      created_at_ms: row.created_at as number,
      updated_at_ms: row.updated_at as number,
    };
  }

  /** 添加 URL → 写 SQLite + JSON */
  async add(source: SeedSource, url: string, trust_level: 0 | 1 | 2 | 3): Promise<SeedRecord> {
    if (!isSeedSource(source)) throw new Error(`SeedsStore.add: invalid source ${source}`);
    validateUrl(url);
    validateTrustLevel(trust_level);

    // 检查是否已存在
    const existing = this.getByUrl(url);
    if (existing) {
      throw new Error(`SeedsStore.add: URL already exists (source=${existing.source})`);
    }

    const now = Date.now();
    const newUrl: SeedUrl = {
      url,
      trust_level,
      active: true,
      last_crawled_at: null,
      last_status: null,
    };

    // 写 SQLite
    this.db.prepare(`
      INSERT INTO crawler_seeds (url, source, trust_level, active, last_crawled_at, last_status, last_error, retry_count, created_at, updated_at)
      VALUES (?, ?, ?, 1, NULL, NULL, NULL, 0, ?, ?)
    `).run(url, source, trust_level, now, now);

    // 写 JSON
    const file = this.loadFile(source);
    const urls = file?.urls ?? [];
    urls.push(newUrl);
    await this.saveFile(source, {
      source,
      version: 1,
      updated_at: new Date(now).toISOString(),
      urls,
    });

    return this.toRecord(source, newUrl, null, null, 0, now, now);
  }

  /** 移除 URL → 写 SQLite 删除 + JSON */
  async remove(source: SeedSource, url: string): Promise<void> {
    validateUrl(url);
    const result = this.db.prepare("DELETE FROM crawler_seeds WHERE url = ?").run(url);
    if (result.changes === 0) {
      throw new Error(`SeedsStore.remove: URL not found: ${url}`);
    }
    const file = this.loadFile(source);
    if (file) {
      const urls = file.urls.filter((u) => u.url !== url);
      await this.saveFile(source, {
        ...file,
        updated_at: new Date().toISOString(),
        urls,
      });
    }
  }

  /** 切换 active → 写 SQLite + JSON */
  async toggleActive(source: SeedSource, url: string, active: boolean): Promise<void> {
    validateUrl(url);
    const now = Date.now();
    const result = this.db.prepare("UPDATE crawler_seeds SET active = ?, updated_at = ? WHERE url = ?").run(active ? 1 : 0, now, url);
    if (result.changes === 0) {
      throw new Error(`SeedsStore.toggleActive: URL not found: ${url}`);
    }
    const file = this.loadFile(source);
    if (file) {
      const urls = file.urls.map((u) => u.url === url ? { ...u, active } : u);
      await this.saveFile(source, {
        ...file,
        updated_at: new Date(now).toISOString(),
        urls,
      });
    }
  }

  /** 更新 trust_level → 写 SQLite + JSON */
  async updateTrustLevel(source: SeedSource, url: string, trust_level: 0 | 1 | 2 | 3): Promise<void> {
    validateUrl(url);
    validateTrustLevel(trust_level);
    const now = Date.now();
    const result = this.db.prepare("UPDATE crawler_seeds SET trust_level = ?, updated_at = ? WHERE url = ?").run(trust_level, now, url);
    if (result.changes === 0) {
      throw new Error(`SeedsStore.updateTrustLevel: URL not found: ${url}`);
    }
    const file = this.loadFile(source);
    if (file) {
      const urls = file.urls.map((u) => u.url === url ? { ...u, trust_level } : u);
      await this.saveFile(source, {
        ...file,
        updated_at: new Date(now).toISOString(),
        urls,
      });
    }
  }

  /** crawler 调用：标记爬取完成（成功或失败） */
  markCrawled(url: string, status: "done" | "failed", error?: string): void {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE crawler_seeds
      SET last_crawled_at = ?, last_status = ?, last_error = ?, retry_count = retry_count + 1, updated_at = ?
      WHERE url = ?
    `).run(now, status, error ?? null, now, url);
    if (result.changes === 0) {
      // URL 不在 SQLite（可能 JSON 有但未 sync）；静默忽略
      return;
    }
    // 注：不写 JSON 的 last_crawled_at / last_status（runtime 字段，JSON 只存配置）
  }

  close(): void {
    this.db.close();
  }

  private toRecord(
    source: SeedSource,
    u: SeedUrl,
    last_crawled_at_ms: number | null,
    last_error: string | null,
    retry_count: number,
    created_at_ms: number,
    updated_at_ms: number,
  ): SeedRecord {
    return {
      ...u,
      source,
      last_crawled_at_ms,
      last_error,
      retry_count,
      created_at_ms,
      updated_at_ms,
    };
  }
}