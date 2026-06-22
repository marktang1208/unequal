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
import { StatusStore } from "./status-store.js";
import { ConcurrencyGate } from "./concurrency-gate.js";
import { FallbackDetector } from "./fallback-detector.js";
import { probeOmlx } from "./omlx-probe.js";
import { LocalParser } from "./local-parser.js";
import { CloudPusher } from "./cloud-pusher.js";
import { chunkText } from "./chunker.js";
import { initConfig } from "./config.js";
import { createEmbedder } from "./embedder-factory.js";
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
 * 生产初始化：按 config 创建 Embedder（local OMLX 或 cloud MiniMax）作为基础设施
 *   （v1 不入 pipeline，API 端自己 embed；保留是为了未来离线缓存/兜底），
 *   注入 Parser/Pusher/Chunker。
 * dev server 启动时调一次（idempotent）。
 */
export async function initProductionDeps(): Promise<void> {
  if (_initialized) return;
  const { orchestrator } = deps();
  const config = await initConfig();
  orchestrator.setParser(new LocalParser());
  orchestrator.setPusher(new CloudPusher());
  orchestrator.setChunker({ chunkText });
  // 创建 embedder 但不注入 orchestrator（API 端 embed）；保留引用供未来 LlmStatus / fallback
  createEmbedder(config.embed);
  _initialized = true;
  console.log(`[local-ingest] Pusher=CloudBase (api-ingest); Embedder infra=${config.embed.provider} (model=${config.embed.omlxModel ?? config.embed.cloudModel}) [API 端 embed]`);
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
  const batchId = url.searchParams.get("batch_id");
  if (!batchId) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "INVALID_REQUEST", message: "Missing batch_id" }));
    return;
  }
  const files = store.listByBatch(batchId);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ batch_id: batchId, files }));
}

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
