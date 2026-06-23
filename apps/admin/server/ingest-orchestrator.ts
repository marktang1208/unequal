/**
 * CP-7-C: IngestOrchestrator — 单文件 6 状态机调度
 *
 * 状态机：pending → parsing → chunking → embedding → pushing → done
 *                          ↘ failed (任意阶段)
 *
 * 流程：
 *   1. StatusStore.getByFileId → 拿 record
 *   2. 解析 (ConcurrencyGate.parserSem, max=1) → LocalParser → markdown
 *   3. chunkText (本地) → 切分
 *   4. Embedder (v2.4 新增) → OMLX Qwen3-4B matryoshka 1536
 *   5. CloudPusher.pushChunks (ConcurrencyGate.pushSem, max=5) → POST /api-ingest (预嵌入 chunks)
 *   6. StatusStore.markDone
 *
 * 错误：每个阶段 try/catch → markFailed(retryable)
 * Fallback：push 失败时 FallbackDetector 计数
 */

import { StatusStore, type FileStatus, type IngestRecord } from "@unequal/local-llm";
import type { ConcurrencyGate } from "./concurrency-gate.js";
import { ParseFailedError } from "./local-parser.js";

// Dependency interfaces
export interface LocalParser {
  parseAuto(tmpData: Buffer, ext: string, filename: string): Promise<string>;
}
export interface CloudPusher {
  push(input: PushInput): Promise<PushResult>;
  /** v2.4: 推预嵌入 chunks */
  pushChunks(input: ChunksPushInput): Promise<PushResult>;
}
export interface ChunkText {
  chunkText(text: string): Promise<Array<{ idx: number; content: string; tokenCount: number }>>;
}
/** v2.4: Embedder 接口（OMLX 本地 embed） */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/** v2.4: 推预嵌入 chunks 的 input */
export interface ChunksPushInput {
  chunks: Array<{ idx: number; content: string; embedding: number[]; tokenCount: number }>;
  title?: string;
  url: string;
  trust_level: 0 | 1 | 2 | 3;
  user_id?: string;
}

export interface PushInput {
  content: string;
  title?: string;
  url: string;
  trust_level: 0 | 1 | 2 | 3;
  user_id?: string;
}

export interface PushResult {
  source_id: string;
  document_id: string;
  chunks_inserted: number;
  chunks_failed: number;
}

export class IngestOrchestrator {
  private store: StatusStore;
  private gate: ConcurrencyGate;
  // dependency injection（默认用 stub；T5/T8 注入真实实现）
  private parser: LocalParser | null = null;
  private pusher: CloudPusher | null = null;
  private chunker: ChunkText | null = null;
  /** v2.4: OMLX 本地 embedder */
  private embedder: Embedder | null = null;

  // 简单 user_id（v1 用 admin 默认；T11 改从 auth 拿）
  private defaultUserId = "01H0000000000000000000000";

  constructor(store: StatusStore, gate: ConcurrencyGate) {
    this.store = store;
    this.gate = gate;
  }

  setParser(parser: LocalParser): void { this.parser = parser; }
  setPusher(pusher: CloudPusher): void { this.pusher = pusher; }
  setChunker(chunker: ChunkText): void { this.chunker = chunker; }
  /** v2.4: 注入 embedder */
  setEmbedder(embedder: Embedder): void { this.embedder = embedder; }

  /** 主入口：处理单个文件（fire-and-forget 调）
   *
   * zhenjie6 快路径：若 record.chunks_with_emb_json 存在（说明之前 push 成功过或已 cache）
   * → 跳过 parse/chunk/embed，直接 push（retry 场景：失败在 push → 重试不用重算 embedding）
   *
   * 注：只在 push 成功后才写 chunks_with_emb_json（markDone 之前写）。
   *   若 push 失败 → markFailed，chunks_with_emb_json 仍保留，retry 时直接复用。
   */
  async processFile(fileId: string): Promise<void> {
    const record = this.store.getByFileId(fileId);
    if (!record) {
      console.error(`[orchestrator] file_id ${fileId} not found`);
      return;
    }

    try {
      // zhenjie6 快路径：cached chunks+embeddings → 跳过 parse/chunk/embed
      if (record.chunks_with_emb_json) {
        const cached = JSON.parse(record.chunks_with_emb_json) as Array<{
          idx: number; content: string; embedding: number[]; tokenCount: number;
        }>;
        if (cached.length > 0) {
          this.store.setStatus(fileId, "pushing", 90);
          if (!this.pusher) throw new Error("Pusher not initialized");
          const pushResult = await this.gate.push(() =>
            this.pusher!.pushChunks({
              chunks: cached,
              title: record.filename,
              url: `local://${record.filename}`,
              trust_level: 1,
              user_id: this.defaultUserId,
            }),
          );
          this.store.markDone(fileId, pushResult.source_id, pushResult.document_id);
          return;
        }
        // 缓存是空数组 → 落到下面正常路径重新跑
      }

      // 1. 解析
      this.store.setStatus(fileId, "parsing", 10);
      if (!this.parser) throw new Error("Parser not initialized");
      const markdown = await this.gate.parser(() =>
        this.parser!.parseAuto(record.tmp_data ?? Buffer.alloc(0), record.ext, record.filename),
      );
      this.store.update(fileId, {
        markdown,
        markdown_chars: markdown.length,
      });

      // 2. chunkText（拆 chunks 供展示 + 后续 embed）
      this.store.setStatus(fileId, "chunking", 30);
      if (!this.chunker) throw new Error("Chunker not initialized");
      const chunks = await this.chunker.chunkText(markdown);
      if (chunks.length === 0) {
        throw new ParseFailedError("chunker produced 0 chunks (empty content?)");
      }
      this.store.update(fileId, { chunks_count: chunks.length, chunks_json: JSON.stringify(chunks) });

      // 3. embedding（v2.4: admin 本地 embed）
      this.store.setStatus(fileId, "embedding", 50);
      if (!this.embedder) throw new Error("Embedder not initialized");
      const texts = chunks.map((c) => c.content);
      const embeddings = await this.embedder.embed(texts);
      const chunksWithEmb = chunks.map((c, i) => ({
        ...c,
        embedding: embeddings[i]!,
      }));
      // zhenjie6: 持久化 chunks+embeddings（retry 复用）
      this.store.update(fileId, {
        chunks_with_emb_json: JSON.stringify(chunksWithEmb),
        progress: 80,
      });

      // 4. push（v2.4: 推预嵌入 chunks，云端直接写库）
      this.store.setStatus(fileId, "pushing", 90);
      if (!this.pusher) throw new Error("Pusher not initialized");
      const pushResult = await this.gate.push(() =>
        this.pusher!.pushChunks({
          chunks: chunksWithEmb,
          title: record.filename,
          url: `local://${record.filename}`,
          trust_level: 1,
          user_id: this.defaultUserId,
        }),
      );

      // 4. done
      this.store.markDone(fileId, pushResult.source_id, pushResult.document_id);
    } catch (err) {
      const { code, message, retryable } = classifyError(err);
      console.error(`[orchestrator] file ${fileId} failed: ${code} - ${message}`);
      this.store.markFailed(fileId, code, message, retryable);
    }
  }
}

// --- Error classification (spec §5.1) ---

export class ParseFailedError extends Error {
  constructor(message: string) { super(message); this.name = "ParseFailedError"; }
}
export class EmbedError extends Error {
  constructor(message: string) { super(message); this.name = "EmbedError"; }
}
export class PushError extends Error {
  constructor(public readonly retryable: boolean, message: string) { super(message); this.name = "PushError"; }
}

function classifyError(err: unknown): { code: string; message: string; retryable: boolean } {
  // 用 err.name (字符串) 而非 instanceof 跨 module 不可靠
  // (vitest + tsx 可能让同一文件加载两次 → 不同 class 实例)
  const name = err instanceof Error ? err.name : "";
  if (name === "ParseFailedError") {
    return { code: "ParseFailed", message: err.message, retryable: false };
  }
  if (name === "EmbedError") {
    return { code: "EmbedFailed", message: err.message, retryable: true };
  }
  if (name === "PushError") {
    // PushError 自带 retryable 字段，但 instanceof 失败时取不到；用消息推断
    const msg = err instanceof Error ? err.message : String(err);
    const retryable = msg.includes("after") || msg.includes("Rate") || msg.includes("Server") || msg.includes("Network");
    return { code: retryable ? "PushFailed" : "PushAuthError", message: msg, retryable };
  }
  if (err instanceof Error) {
    const msg = err.message;
    if (
      msg.includes("not initialized") ||
      msg.includes("Parser not initialized")
    ) {
      return { code: "InternalError", message: msg, retryable: false };
    }
    if (
      msg.includes("chunker produced 0 chunks") ||
      msg.includes("empty content")
    ) {
      return { code: "ParseFailed", message: msg, retryable: false };
    }
    return { code: "UnknownError", message: msg, retryable: true };
  }
  return { code: "UnknownError", message: String(err), retryable: true };
}
