/**
 * CP-7-C: 本地 ingest Vite middleware
 *
 * 路由（Vite dev 5173）：
 *   POST /api/upload       - multipart FormData → 写 .tmp/uploads/ → 调 IngestOrchestrator
 *   GET  /api/ingest-status?batch_id=X  - 查 SQLite 状态
 *   POST /api/retry?file_id=X           - 重推失败文件
 *   GET  /api/llm-status                - OMLX runtime 状态
 *
 * 设计：Vite Connect.Server；通过 vite.config.ts plugin 注入 server.middlewares
 */

import type { Connect } from "vite";
import { IngestOrchestrator } from "./ingest-orchestrator.js";
import { StatusStore, type FileStatus, type IngestSource } from "@unequal/local-llm";
import { ConcurrencyGate } from "./concurrency-gate.js";
import { FallbackDetector } from "./fallback-detector.js";
import { probeOmlx } from "./omlx-probe.js";
import { LocalParser } from "./local-parser.js";
import { CloudPusher } from "./cloud-pusher.js";
import { chunkText } from "./chunker.js";
import { initConfig } from "./config.js";
import { createEmbedder } from "./llm-provider.js";
import { startCrawler, getCrawlerStatus, type SpawnOptions } from "./crawler-spawner.js";
import { randomUUID } from "node:crypto";

let _store: StatusStore | null = null;
let _orchestrator: IngestOrchestrator | null = null;
let _gate: ConcurrencyGate | null = null;
let _fallback: FallbackDetector | null = null;
let _initialized = false;

/** 测试用：注入自定义 deps（避免 module-level 单例） */
export function __setDepsForTest(deps: {
  store: StatusStore;
  orchestrator: IngestOrchestrator;
  gate: ConcurrencyGate;
  fallback?: FallbackDetector;
}): void {
  _store = deps.store;
  _orchestrator = deps.orchestrator;
  _gate = deps.gate;
  _fallback = deps.fallback ?? null;
}

/** 测试用：重置单例 */
export function __resetForTest(): void {
  _store = null;
  _orchestrator = null;
  _gate = null;
  _fallback = null;
  _initialized = false;
}

/**
 * 生产初始化（v2.4）：注入 Parser/Pusher/Chunker/Embedder。
 *   Embedder 走 OMLX Qwen3-Embedding-4B + matryoshka 1536（admin 本地 embed），
 *   CloudBase 不再调 MiniMax，云端只写库。
 * dev server 启动时调一次（idempotent）。
 */
export async function initProductionDeps(): Promise<void> {
  if (_initialized) return;
  const { orchestrator } = deps();
  const config = await initConfig();
  orchestrator.setParser(new LocalParser());
  orchestrator.setPusher(new CloudPusher());
  orchestrator.setChunker({ chunkText });
  // v2.4: 把 embedder 注入 orchestrator（v2.3 因"admin 不 embed"删了）
  orchestrator.setEmbedder(createEmbedder(config.embed));
  _initialized = true;
  console.log(`[local-ingest] Pusher=CloudBase (v2.4 chunks); Embedder=${config.embed.provider} (model=${config.embed.omlxModel ?? config.embed.cloudModel})`);
}

function deps() {
  if (!_store) _store = new StatusStore(".tmp/unequal.db");
  if (!_gate) _gate = new ConcurrencyGate();
  if (!_orchestrator) _orchestrator = new IngestOrchestrator(_store, _gate);
  if (!_fallback) _fallback = new FallbackDetector();
  return { store: _store!, orchestrator: _orchestrator!, gate: _gate!, fallback: _fallback! };
}

/** 简单 multer 替代：用 raw body + boundary 解析（避免 multer 依赖膨胀）
 *  v1: 接收 multipart 但只解析最简单 form-data；完整 multipart 库待 T5/T9 升级
 *
 * 标准 multipart 格式：
 *   --<boundary>\r\n
 *   <headers>\r\n
 *   \r\n
 *   <data>\r\n
 *   --<boundary>\r\n
 *   <headers>\r\n
 *   \r\n
 *   <data>\r\n
 *   --<boundary>--\r\n  (terminator)
 */
function parseMultipartSimple(
  body: Buffer,
  boundary: string,
): Array<{ name: string; filename?: string; data: Buffer }> {
  const parts: Array<{ name: string; filename?: string; data: Buffer }> = [];
  const delim = Buffer.from(`--${boundary}`);
  const crlf = Buffer.from("\r\n");

  // split by --<boundary>
  // 但 boundary 出现在数据中的概率极低（binary 文件可能含巧合字符，v1 接受风险）
  const segments: Buffer[] = [];
  let pos = 0;
  while (pos < body.length) {
    const idx = body.indexOf(delim, pos);
    if (idx < 0) break;
    segments.push(body.subarray(pos, idx));
    pos = idx + delim.length;
  }

  // segments[0] = preamble (before first boundary)，忽略
  // segments[i] 是第 i-1 个 part 的内容
  for (let i = 1; i < segments.length; i++) {
    let seg = segments[i]!;
    // segment 开头可能是 \r\n（delimiter 后的换行）
    if (seg[0] === 0x0d && seg[1] === 0x0a) seg = seg.subarray(2);
    // segment 末尾是 \r\n（delimiter 前的换行），或 "--" 表示结束
    if (seg[0] === 0x2d && seg[1] === 0x2d) break;  // end: --<boundary>--
    // 去掉末尾 \r\n
    if (seg.length >= 2 && seg[seg.length - 2] === 0x0d && seg[seg.length - 1] === 0x0a) {
      seg = seg.subarray(0, seg.length - 2);
    }

    // 找 header / body 分界 \r\n\r\n
    const headerEnd = seg.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) continue;
    const header = seg.subarray(0, headerEnd).toString("utf-8");
    const data = seg.subarray(headerEnd + 4);

    const nameMatch = /name="([^"]+)"/.exec(header);
    const filenameMatch = /filename="([^"]+)"/.exec(header);
    if (nameMatch) {
      parts.push({
        name: nameMatch[1]!,
        ...(filenameMatch ? { filename: filenameMatch[1]! } : {}),
        data,
      });
    }
  }
  return parts;
}

async function handleUpload(req: Connect.IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  const { store, orchestrator } = deps();
  const contentType = req.headers["content-type"] ?? "";
  const match = /boundary=(.+)$/.exec(contentType);
  if (!match) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "INVALID_REQUEST", message: "Missing multipart boundary" }));
    return;
  }
  const boundary = match[1]!;

  // read full body (dev 模式 5MB 上限)
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  if (body.length > 5 * 1024 * 1024) {
    res.statusCode = 413;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "FILE_TOO_LARGE", message: "Total upload > 5MB" }));
    return;
  }

  const parts = parseMultipartSimple(body, boundary);
  const fileParts = parts.filter((p) => p.filename);

  if (fileParts.length === 0) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "INVALID_REQUEST", message: "No files in multipart" }));
    return;
  }

  // trust_level field
  const trustLevelPart = parts.find((p) => p.name === "trust_level");
  const trustLevel = trustLevelPart ? parseInt(trustLevelPart.data.toString("utf-8"), 10) : 0;
  if (!Number.isFinite(trustLevel) || trustLevel < 0 || trustLevel > 3) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "INVALID_REQUEST", message: "trust_level must be 0-3" }));
    return;
  }

  const batchId = randomUUID();
  const fileIds: string[] = [];
  for (const fp of fileParts) {
    const fileId = randomUUID();
    fileIds.push(fileId);
    const ext = (fp.filename ?? "").split(".").pop()?.toLowerCase() ?? "";
    store.create({
      file_id: fileId,
      batch_id: batchId,
      filename: fp.filename ?? "unknown",
      ext,
      tmp_data: fp.data,        // T2 存内存；T9 改写 .tmp 文件
      source: "upload",         // P3-7 / Phase C: 显式 source（区分 crawler 路径）
      trust_level: trustLevel as 0 | 1 | 2 | 3,  // P3-7: 持久化到表（handleManualPush 推送时读）
      status: "pending",
      progress: 0,
      retry_count: 0,
      retryable: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    // fire-and-forget 调 orchestrator
    void orchestrator.processFile(fileId).catch((err) => {
      console.error(`[orchestrator] ${fileId} failed:`, err);
    });
  }

  res.statusCode = 202;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    batch_id: batchId,
    files: fileParts.map((fp, i) => ({
      batch_id: batchId,           // 每文件也带（前端用）
      file_id: fileIds[i]!,
      filename: fp.filename ?? "unknown",
      status: "pending" as const,
    })),
  }));
}

function handleStatus(req: Connect.IncomingMessage, res: import("node:http").ServerResponse, url: URL): void {
  const { store } = deps();

  // P3-7 / Phase C: 支持多维查询（batch_id / source+status / 全 pending）
  const batchId = url.searchParams.get("batch_id");
  const sourceParam = url.searchParams.get("source");
  const statusParam = url.searchParams.get("status");

  if (batchId) {
    const files = store.listByBatch(batchId);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ batch_id: batchId, files }));
    return;
  }

  // source 过滤（crawler / upload / all）
  if (sourceParam && sourceParam !== "all") {
    if (sourceParam !== "upload" && sourceParam !== "crawler") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "INVALID_REQUEST", message: `source must be upload|crawler|all, got ${sourceParam}` }));
      return;
    }
    const files = store.listBySource(sourceParam as IngestSource, (statusParam as FileStatus) || undefined);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ source: sourceParam, status: statusParam ?? "all", files }));
    return;
  }

  // 兜底：无 batch_id / source → 400（admin-upload 上传后立即返 batch_id，前端轮询那个）
  res.statusCode = 400;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "INVALID_REQUEST", message: "Missing batch_id or source" }));
}

/* ──── P3-7 / Phase C: 手动推送（crawler / upload 都走这条） ──── */

/**
 * POST /api/manual-push
 * body = { file_ids: string[], trust_level_overrides?: { [file_id]: 0|1|2|3 } }
 *
 * 行为：
 * - 遍历 file_ids，每条：
 *   - record.status != "pending" → 跳过（计入 skipped）
 *   - record.cloud_source_id 已存在 → skip（推送去重）
 *   - status → "pushing"，retry_count++
 *   - 调 CloudPusher.push（同步 await；5xx/429 不自动重试）
 *   - 成功 → markDone
 *   - 失败 → markFailed（retryable=true；retry_count 达 3 → retryable=false）
 *
 * 串行（避免 CloudBase HTTP 瞬时 429）；并发 v1 简化不做。
 */
async function handleManualPush(req: Connect.IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  const { store } = deps();
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  let body: { file_ids?: string[]; trust_level_overrides?: Record<string, 0 | 1 | 2 | 3> } = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "INVALID_JSON", message: "Body must be JSON" }));
    return;
  }
  const fileIds = body.file_ids ?? [];
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "INVALID_REQUEST", message: "file_ids must be non-empty array" }));
    return;
  }

  const pusher = new CloudPusher();
  const result: { pushed: number; failed: number; skipped: number; errors: Array<{ file_id: string; error: string }> } = {
    pushed: 0, failed: 0, skipped: 0, errors: [],
  };

  for (const fileId of fileIds) {
    const record = store.getByFileId(fileId);
    if (!record) {
      result.skipped++;
      continue;
    }
    if (record.status !== "pending") {
      result.skipped++;
      continue;
    }
    if (record.cloud_source_id) {
      // 已推送过，去重
      result.skipped++;
      continue;
    }
    // 更新 retry_count + status
    store.update(fileId, {
      status: "pushing",
      retry_count: record.retry_count + 1,
    });

    const trustLevel = body.trust_level_overrides?.[fileId] ?? record.trust_level ?? 0;

    try {
      const pushResult = await pusher.push({
        content: record.markdown ?? "",
        title: record.filename,
        url: record.filename,        // crawler 端 filename 是 URL 末段；admin-upload 是文件名
        trust_level: trustLevel as 0 | 1 | 2 | 3,
      });
      store.markDone(fileId, pushResult.source_id, pushResult.document_id);
      result.pushed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = (record.retry_count + 1) < 3; // 限制 retry 上限 3
      store.markFailed(fileId, "PUSH_FAILED", msg, isRetryable);
      result.failed++;
      result.errors.push({ file_id: fileId, error: msg });
    }
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result));
}

/* ──── P3-7 / Phase C: 启动爬虫 ──── */

/**
 * POST /api/crawler/start
 * body = { source: "xhs"|"wechat-mp"|"webpage"|"all", limit?: number, fullScan?: boolean, since?: number, until?: number, trustLevel?: 0|1|2|3 }
 *
 * 行为：spawn detached 子进程跑 pnpm -F crawler start，返 { process_id }。
 */
function handleCrawlerStart(req: Connect.IncomingMessage, res: import("node:http").ServerResponse): void {
  const chunks: Buffer[] = [];
  void (async () => {
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf-8");
    let body: SpawnOptions & { trustLevel?: 0 | 1 | 2 | 3 } = { source: "webpage" };
    try {
      body = raw ? JSON.parse(raw) : { source: "webpage" };
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "INVALID_JSON", message: "Body must be JSON" }));
      return;
    }
    if (!["xhs", "wechat-mp", "webpage", "all"].includes(body.source)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "INVALID_REQUEST", message: `source must be xhs|wechat-mp|webpage|all` }));
      return;
    }
    try {
      const r = startCrawler(body);
      res.statusCode = 202;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        process_id: r.process_id,
        pid: r.pid,
        log_path: r.log_path,
        started_at: r.started_at,
        status: "started",
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "SPAWN_FAILED", message: msg }));
    }
  })();
}

/**
 * GET /api/crawler/status?process_id=X
 */
function handleCrawlerStatus(req: Connect.IncomingMessage, res: import("node:http").ServerResponse, url: URL): void {
  const processId = url.searchParams.get("process_id");
  if (!processId) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "INVALID_REQUEST", message: "Missing process_id" }));
    return;
  }
  const { store } = deps();
  const status = getCrawlerStatus(processId, (batchId) => store.countByBatchId(batchId));
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(status));
}

/**
 * POST /api/retry?file_id=X
 *
 * - source="upload" → 调 orchestrator.processFile（admin-upload 5 态机）
 * - source="crawler" → 直接调 CloudPusher 重推（crawler 路径已 parse + chunk + embed，无需重跑）
 */
async function handleRetry(req: Connect.IncomingMessage, res: import("node:http").ServerResponse, url: URL): Promise<void> {
  const { store, orchestrator } = deps();
  const fileId = url.searchParams.get("file_id");
  if (!fileId) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "INVALID_REQUEST", message: "Missing file_id" }));
    return;
  }
  const record = store.getByFileId(fileId);
  if (!record) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "NOT_FOUND", message: `file_id ${fileId} not found` }));
    return;
  }
  if (!record.retryable) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "NOT_RETRYABLE", message: `file ${fileId} not retryable (status=${record.status})` }));
    return;
  }

  // P3-7: crawler 路径直接 CloudPusher 重推（不调 orchestrator）
  if (record.source === "crawler") {
    const pusher = new CloudPusher();
    store.resetForRetry(fileId);
    store.update(fileId, { status: "pushing", retry_count: record.retry_count + 1 });
    try {
      const pushResult = await pusher.push({
        content: record.markdown ?? "",
        title: record.filename,
        url: record.filename,
        trust_level: (record.trust_level ?? 0) as 0 | 1 | 2 | 3,
      });
      store.markDone(fileId, pushResult.source_id, pushResult.document_id);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ file_id: fileId, status: "done", source_id: pushResult.source_id }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = (record.retry_count + 1) < 3;
      store.markFailed(fileId, "PUSH_FAILED", msg, isRetryable);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ file_id: fileId, status: "failed", error: msg, retryable: isRetryable }));
    }
    return;
  }

  // source="upload" 路径：原有 orchestrator 5 态机流程
  store.resetForRetry(fileId);
  void orchestrator.processFile(fileId).catch((err) => {
    console.error(`[orchestrator retry] ${fileId} failed:`, err);
  });
  res.statusCode = 202;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ file_id: fileId, status: "pending" }));
}

async function handleLlmStatus(_req: Connect.IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  const { fallback } = deps();
  const omlx = await probeOmlx();
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    omlx,
    fallback: {
      embed: fallback.getState("embed"),
      llm: fallback.getState("llm"),
    },
  }));
}

export const localIngestMiddleware: Connect.Server = async (req, res, next) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/upload") {
      await handleUpload(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/ingest-status") {
      handleStatus(req, res, url);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/retry") {
      await handleRetry(req, res, url);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/llm-status") {
      handleLlmStatus(req, res);
      return;
    }
    // P3-7 / Phase C: 手动推送 + 启动爬虫 + 爬虫状态
    if (req.method === "POST" && url.pathname === "/api/manual-push") {
      await handleManualPush(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/crawler/start") {
      handleCrawlerStart(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/crawler/status") {
      handleCrawlerStatus(req, res, url);
      return;
    }
    next();
  } catch (err) {
    console.error("[local-ingest] unhandled error:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        error: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  }
};
