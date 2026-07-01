/**
 * P3-7 / Phase B: ingest-sqlite — crawler 产出暂存 local_ingest 表
 *
 * 替代原 `apps/crawler/src/ingest.ts` 的"直推云"路径。
 * crawler 跑完爬 + parse + chunk + embed → 写 admin 共享 `.tmp/unequal.db` 的
 * local_ingest 表，status=pending，等 admin UI 手动推送。
 *
 * 保留 `submitToIngest` 行为（admin-upload v2 的 CloudPusher 直接调）以兼容
 * 现有 `apps/crawler/test/ingest.test.ts` 17 cases：
 * - 原 ingest.ts 的 `buildIngestBody` + `submitToIngest` 整体搬到本文件
 * - 行为完全不变，仅 import 路径调整
 *
 * 关键设计点：
 * - crawler 写到 admin 的 SQLite（共享 `.tmp/unequal.db`），让 admin UI 看到补推列表
 * - ext = "crawler" 作为临时区分（admin-upload ext 是 pdf/docx/html/txt/md 不撞）
 *   T3 加 `source` 列后会改用 `source="crawler"` + `ext="md"`，本文件提前按 source="crawler" 写
 * - chunks_json 暂存 chunks + embedding（避免 admin 推送前重新 embed）
 * - 校验 embedding dim = 1536（与 CloudBase MiniMax 对齐）
 */

import type { CrawledDocument, IngestBody } from "./types.js";
import { StatusStore } from "@unequal/local-llm";
import { randomUUID } from "node:crypto";

const EXPECTED_EMBED_DIM = 1536;

/* ──── P3-7: 写入 local_ingest 表（crawler 路径） ──── */

/** 单条 chunk schema（admin-upload CloudPusher 已有；这里 crawler 端独立类型） */
export interface CrawlerChunk {
  content: string;
  embedding: number[];
  idx: number;
  token_count: number;
}

export interface CrawlerIngestInput {
  url: string;
  title?: string;
  sourceType: "xhs" | "wechat-mp" | "webpage" | "pdf";
  markdown: string;                            // crawler parse 出的纯文本
  chunks: CrawlerChunk[];                     // crawler 端 chunk + embed
  trustLevel: 0 | 1 | 2 | 3;
  /** P3-7 / Phase C: source 列必填 "crawler"（区分 upload 路径） */
  source?: "crawler";
  metadata?: {
    crawlDepth?: number;
    sourceDomain?: string;
    crawledAt?: number;
    parentUrl?: string;
  };
}

export interface CrawlerIngestResult {
  file_id: string;
  batch_id: string;
  status: "pending";
}

/** chunk 维度校验（与 admin-upload 端 LocalEmbedder 对齐） */
function validateChunks(chunks: CrawlerChunk[]): void {
  if (chunks.length === 0) {
    throw new Error("ingestCrawlerMarkdown: chunks must be non-empty");
  }
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    if (!c.content || typeof c.content !== "string") {
      throw new Error(`ingestCrawlerMarkdown: chunk ${i}.content must be non-empty string`);
    }
    if (!Array.isArray(c.embedding) || c.embedding.length !== EXPECTED_EMBED_DIM) {
      throw new Error(
        `ingestCrawlerMarkdown: chunk ${i}.embedding must be number[${EXPECTED_EMBED_DIM}], got length=${c.embedding?.length ?? 0}`,
      );
    }
  }
}

/** filename 推导：URL 末段 / title 截断 / fallback url  */
function filenameFromUrl(url: string, title?: string): string {
  try {
    const u = new URL(url);
    const pathname = u.pathname.replace(/\/$/, "");
    if (pathname && pathname !== "/") {
      const last = pathname.split("/").pop() ?? "";
      if (last && last.length > 0) return last.slice(0, 100);
    }
  } catch {
    // URL parse fail；继续用 title fallback
  }
  if (title) return title.slice(0, 100);
  return url.slice(0, 100);
}

/**
 * 把 crawler 产出写入 local_ingest 表。
 *
 * @param store 已初始化的 StatusStore（admin 共享 `.tmp/unequal.db`）
 * @param input 单条 crawler 产出
 * @returns file_id + batch_id + status="pending"
 */
export function ingestCrawlerMarkdown(
  store: StatusStore,
  input: CrawlerIngestInput,
): CrawlerIngestResult {
  validateChunks(input.chunks);

  const fileId = randomUUID();
  const batchId = randomUUID();
  const filename = filenameFromUrl(input.url, input.title);

  // P3-7 / Phase B：ext 暂用 "crawler" 区分（admin-upload ext 是 pdf/docx/html/txt/md 不撞）。
  // T3 加 `source` 列后会改用 source="crawler" + ext="md" 统一。
  const ext = "crawler";

  const chunksJson = JSON.stringify(input.chunks);

  const record = store.create({
    file_id: fileId,
    batch_id: batchId,
    filename,
    ext,
    markdown: input.markdown,
    chunks_json: chunksJson,
    markdown_chars: input.markdown.length,
    chunks_count: input.chunks.length,
    source: input.source ?? "crawler",     // P3-7 / Phase C: 显式 "crawler"
    status: "pending",
    progress: 0,
    retry_count: 0,
    retryable: 0,
  });

  return { file_id: record.file_id, batch_id: record.batch_id, status: "pending" };
}

/* ──── 原 ingest.ts 的 buildIngestBody + submitToIngest（保留向后兼容） ──── */

export interface BuildBodyOptions {
  trustLevel: 0 | 1 | 2 | 3;
  /**
   * 缺省 undefined：CLI 不传 --user-id → 字段从 body 完全省略。
   * 传具体 user_id：CLI 传 --user-id <X> → body 含 user_id: X。
   * 注意：admin 路径禁止 user_id（CLI 层 fail-fast 拦截）。
   */
  userId?: string;
}

export function buildIngestBody(doc: CrawledDocument, opts: BuildBodyOptions): IngestBody {
  return {
    content: doc.paragraphs.join("\n\n"),
    title: doc.title || doc.url,
    url: doc.url,
    trust_level: opts.trustLevel,
    ...(opts.userId ? { user_id: opts.userId } : {}),
  };
}

export interface SubmitOptions {
  ingestUrl: string;
  /**
   * auth：proxy secret 与 token 互斥（CLI 层 enforce；submitToIngest 也防御性 throw）。
   * - ingestProxySecret 有值 → headers 含 x-ingest-proxy-secret（只发这一个）
   * - token 有值 → headers 含 authorization: Bearer（只发这一个）
   * - 两者都有/都无 → throw Error
   */
  ingestProxySecret?: string;
  token?: string;
  /** undefined → body 不含 user_id 字段 */
  userId?: string;
  trustLevel: 0 | 1 | 2 | 3;
  fetchImpl?: typeof fetch;
}

export type SubmitResult =
  | { ok: true; sourceId?: string; documentId?: string }
  | { ok: false; status: number; error: string };

/**
 * 保留原 `submitToIngest`：直接 POST `/api-ingest`（不走 SQLite）。
 * 现有 `apps/crawler/test/ingest.test.ts` 17 cases 依赖此函数（admin-upload
 * CloudPusher 内部也用同样逻辑）。P3-7 把它从 ingest.ts 搬到本文件。
 *
 * 注：admin MacBook crawler 工作流当前主要用 `ingestCrawlerMarkdown` 写 SQLite，
 * 然后 admin UI 手动推送。`submitToIngest` 仅作为 legacy 直推云路径保留（CLI
 * `--no-sqlite --direct-cloud` flag 用，或 admin 临时一次性脚本）。
 */
export async function submitToIngest(
  doc: CrawledDocument,
  opts: SubmitOptions,
): Promise<SubmitResult> {
  const hasProxy = !!opts.ingestProxySecret;
  const hasToken = !!opts.token;
  if (hasProxy === hasToken) {
    throw new Error("submitToIngest: exactly one of ingestProxySecret/token must be provided");
  }

  const body = buildIngestBody(doc, { trustLevel: opts.trustLevel, userId: opts.userId });

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (hasProxy) {
    headers["x-ingest-proxy-secret"] = opts.ingestProxySecret!;
  } else {
    headers["authorization"] = `Bearer ${opts.token!}`;
  }

  const f = opts.fetchImpl ?? fetch;
  const res = await f(opts.ingestUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, status: res.status, error: errBody.error ?? `HTTP ${res.status}` };
  }

  const okBody = (await res.json()) as { ok?: boolean; sourceId?: string; documentId?: string };
  return { ok: true, sourceId: okBody.sourceId, documentId: okBody.documentId };
}

/** P3-7: 创建共享 StatusStore 单例（crawler 进程用） */
export function createCrawlerStore(dbPath: string = "../admin/.tmp/unequal.db"): StatusStore {
  return new StatusStore(dbPath);
}
