/**
 * P3-7 / Phase B: CrawlerTrigger — CLI / launchd / UI 三种触发的统一入口
 *
 * CLI：
 *   pnpm -F crawler start --source=xhs --limit=10
 *   pnpm -F crawler start --source=xhs --since=1748000000000
 *   pnpm -F crawler start --full-scan --source=all
 *
 * launchd（每日凌晨 3 点）：
 *   scripts/run-daily-crawler.sh → pnpm -F crawler start --full-scan --source=all
 *
 * UI（admin-upload "启动爬虫" 按钮）：
 *   POST /api/crawler/start body={source, limit} → LocalIngestMiddleware spawn child_process
 *   跑 `pnpm -F crawler start --source=X --limit=N` → 写 stdout 到 PID 文件
 *
 * 三种触发共享本文件 `runCrawler()`。CLI 直接调；UI 调 spawn 子进程；
 * launchd 调 pnpm 脚本。
 */

import { fetchUrl } from "./sources/webpage.js";
import { fetchXiaohongshuNote } from "./sources/xiaohongshu.js";
import { fetchWechatMpArticle } from "./sources/wechat-mp.js";
import { fetchPdf } from "./sources/pdf.js";
import { chunkText } from "@unequal/shared/chunking";
import { createEmbedder, type Embedder } from "@unequal/local-llm";
import { ingestCrawlerMarkdown, createCrawlerStore } from "./ingest-sqlite.js";
import { SeedsLoader, type SeedRecord } from "./seeds-loader.js";
import type { CrawledDocument } from "./types.js";

export type SourceType = "xhs" | "wechat-mp" | "webpage" | "pdf" | "all";

export interface TriggerOptions {
  /** 单一来源或 "all" */
  source?: SourceType;
  /** 单 URL 模式（CLI --url 兼容） */
  url?: string;
  /** 时间窗下界（ms epoch）；不传 = 不限 */
  since?: number;
  /** 时间窗上界（ms epoch）；不传 = 不限 */
  until?: number;
  /** 限制条数；不传 = 不限 */
  limit?: number;
  /** 全量扫描：覆盖所有 source + limit 忽略 */
  fullScan?: boolean;
  /** crawler 自动 trust_level（默认 1 = crawler auto） */
  trustLevel?: 0 | 1 | 2 | 3;
  /** SQLite 路径（默认 .tmp/unequal.db 共享 admin） */
  dbPath?: string;
  /** 测试用：注入 fake fetch */
  fetchImpl?: typeof fetch;
  /** 测试用：注入 fake Embedder */
  embedderOverride?: Embedder;
}

export interface CrawlerResult {
  total: number;
  succeeded: number;
  failed: number;
  file_ids: string[];
  errors: Array<{ url: string; error: string }>;
}

/**
 * 单 URL 抓取 + 解析（不调 /ingest；不写 SQLite；返回 CrawledDocument）。
 * 复用现有 sources/* fetch 实现。
 */
async function fetchOne(url: string, sourceType: SourceType, fetchImpl?: typeof fetch): Promise<CrawledDocument> {
  const opts = fetchImpl ? { fetchImpl } : {};
  if (sourceType === "xhs") {
    return await fetchXiaohongshuNote(url, opts);
  } else if (sourceType === "wechat-mp") {
    return await fetchWechatMpArticle(url, opts);
  } else if (sourceType === "pdf") {
    return await fetchPdf(url, opts);
  }
  return await fetchUrl(url, opts);
}

/**
 * 单条文档 → chunks + embed → 写 SQLite。
 *
 * @returns file_id（成功）或 error string（失败）
 */
async function processOne(
  store: ReturnType<typeof createCrawlerStore>,
  embedder: Embedder,
  doc: CrawledDocument,
  trustLevel: 0 | 1 | 2 | 3,
  sourceType: SourceType,
): Promise<{ file_id: string } | { error: string }> {
  try {
    // 1. markdown = paragraphs 拼接
    const markdown = doc.paragraphs.join("\n\n");

    // 2. chunk（与 CloudBase MiniMax chunker 参数对齐：maxTokens=500, overlap=80）
    const chunks = chunkText(markdown, { maxTokens: 500, overlapTokens: 80 });

    // 3. embed（1536 维）
    const texts: string[] = chunks.map((c: { content: string }) => c.content);
    const embeddings = await embedder.embed(texts);

    // 4. 组装 chunks for ingest-sqlite
    const ingestChunks: Array<{ content: string; embedding: number[]; idx: number; token_count: number }> = chunks.map(
      (c: { content: string; tokenCount: number }, i: number) => ({
        content: c.content,
        embedding: embeddings[i]!,
        idx: i,
        token_count: c.tokenCount,
      }),
    );

    // 5. 写 SQLite
    const r = ingestCrawlerMarkdown(store, {
      url: doc.url,
      title: doc.title,
      sourceType: sourceType === "all" ? "webpage" : sourceType,
      markdown,
      chunks: ingestChunks,
      trustLevel,
      // P3-7 / Phase C: source 列必填 "crawler"（区分 upload 路径）
      source: "crawler",
      metadata: {
        crawledAt: doc.fetchedAt,
      },
    });
    return { file_id: r.file_id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * URL 列表生成：
 * - fullScan=true → 来源全量（暂用 hardcoded 空集；未来扩展从 source 列表读）
 * - 单一 source + limit → 来源种子 URL
 * - url=单条 → 单条
 *
 * v1 简化：fullScan 用空列表（admin 已知每日触发场景）；limit 模式也用空列表。
 * 调用方实际传 url 或 source= 具体来源配对 seed URL。
 * 真实场景：admin 配 JSON 种子文件（待未来 spec 补）。
 */
function resolveSeedUrls(opts: TriggerOptions): Array<{ url: string; sourceType: SourceType; trustLevel: 0 | 1 | 2 | 3 }> {
  if (opts.url) {
    return [{
      url: opts.url,
      sourceType: (opts.source && opts.source !== "all" ? opts.source : "webpage"),
      trustLevel: opts.trustLevel ?? 1,
    }];
  }
  // P3-7: 批量模式读 seeds-loader（admin SeedsStore 启动时已把 JSON 同步到 SQLite）
  const loader = new SeedsLoader(opts.dbPath ?? "../admin/.tmp/unequal.db");
  try {
    const seeds = (opts.source && opts.source !== "all")
      ? loader.loadOne(opts.source, { limit: opts.limit })
      : loader.loadAll({ limit: opts.limit });
    return seeds
      .filter((s) => s.active)
      .map((s) => ({
        url: s.url,
        sourceType: s.source as SourceType,
        trustLevel: s.trust_level,
      }));
  } finally {
    loader.close();
  }
}

/**
 * 主入口：跑 crawler → 写 SQLite。
 *
 * 设计：
 * - 同步顺序处理（v1 简化；未来可加并发 semaphore）
 * - 任一 URL 失败不影响其他
 * - 全跑完才返回（含每条写 SQLite 状态）
 */
export async function runCrawler(opts: TriggerOptions): Promise<CrawlerResult> {
  const seedUrls = resolveSeedUrls(opts);
  const defaultTrustLevel = opts.trustLevel ?? 1;

  if (seedUrls.length === 0) {
    console.warn(`[crawler-trigger] no seed urls resolved (url=${opts.url}, source=${opts.source}, fullScan=${opts.fullScan})`);
    return { total: 0, succeeded: 0, failed: 0, file_ids: [], errors: [] };
  }

  const store = createCrawlerStore(opts.dbPath ?? "../admin/.tmp/unequal.db");
  let embedder: Embedder;
  if (opts.embedderOverride) {
    embedder = opts.embedderOverride;
  } else {
    // P3-7: 用 loadLocalLLMConfig 拿真实 provider（auto mode 解析 → local/cloud）
    const { loadLocalLLMConfig } = await import("@unequal/local-llm");
    const cfg = await loadLocalLLMConfig();
    embedder = createEmbedder(cfg.embed);
  }
  const seedsLoader = new SeedsLoader(opts.dbPath ?? "../admin/.tmp/unequal.db");

  const result: CrawlerResult = { total: 0, succeeded: 0, failed: 0, file_ids: [], errors: [] };

  for (const { url, sourceType: src, trustLevel } of seedUrls) {
    result.total++;
    try {
      const doc = await fetchOne(url, src, opts.fetchImpl);
      const r = await processOne(store, embedder, doc, trustLevel, src);
      if ("file_id" in r) {
        result.succeeded++;
        result.file_ids.push(r.file_id);
        seedsLoader.markCrawled(url, "done");
        console.log(`[crawler-trigger] OK url=${url} file_id=${r.file_id} trust=${trustLevel}`);
      } else {
        result.failed++;
        result.errors.push({ url, error: r.error });
        seedsLoader.markCrawled(url, "failed", r.error);
        console.error(`[crawler-trigger] FAIL url=${url} error=${r.error}`);
      }
    } catch (err) {
      result.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ url, error: msg });
      seedsLoader.markCrawled(url, "failed", msg);
      console.error(`[crawler-trigger] FAIL url=${url} error=${msg}`);
    }
  }

  store.close();
  seedsLoader.close();
  return result;
}
