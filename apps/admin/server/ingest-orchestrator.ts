/**
 * CP-7-C: IngestOrchestrator — 单文件 6 状态机调度
 *
 * 状态机：pending → parsing → chunking → embedding → pushing → done
 *                          ↘ failed (任意阶段)
 *
 * 流程：
 *   1. StatusStore.getByFileId → 拿 record
 *   2. 解析 (ConcurrencyGate.parserSem, max=1) → LocalParser
 *   3. chunkText (本地) → 切分
 *   4. LocalEmbedder (ConcurrencyGate.embedSem, max=3) → embeddings
 *   5. CloudPusher (ConcurrencyGate.pushSem, max=5) → POST /api-ingest
 *   6. StatusStore.markDone
 *
 * 错误：每个阶段 try/catch → markFailed(retryable)
 * Fallback：embed/push 失败时 FallbackDetector 计数
 *
 * v1 状态：实现 orchestrator 调度骨架 + 状态转换。parser/embed/push 三个 dependency
 *  在 T5/T6/T8 注入；T2 已经能 import 这个 class。
 */

import { StatusStore, type FileStatus, type IngestRecord } from "./status-store.js";
import type { ConcurrencyGate } from "./concurrency-gate.js";
import { ParseFailedError } from "./local-parser.js";

// Dependency interfaces (T5/T6/T8 实现这些)
export interface LocalParser {
  parseAuto(tmpData: Buffer, ext: string, filename: string): Promise<string>;
}
export interface LocalEmbedder {
  embedBatch(texts: string[]): Promise<number[][]>;
}
export interface CloudPusher {
  push(input: PushInput): Promise<PushResult>;
}
export interface ChunkText {
  chunkText(text: string): Promise<Array<{ idx: number; content: string; tokenCount: number }>>;
}

export interface PushInput {
  markdown: string;
  source_meta: {
    url: string;
    type: string;
    title?: string;
    trust_level: number;
    user_id?: string;
  };
  document_meta: {
    title: string;
    rawPath?: string;
    previewSnippet?: string;
  };
  chunks: Array<{ content: string; embedding: number[]; idx: number; token_count: number }>;
}

export interface PushResult {
  source_id: string;
  document_id: string;
}

export class IngestOrchestrator {
  private store: StatusStore;
  private gate: ConcurrencyGate;
  // dependency injection（默认用 stub；T5/T6/T8 注入真实实现）
  private parser: LocalParser | null = null;
  private embedder: LocalEmbedder | null = null;
  private pusher: CloudPusher | null = null;
  private chunker: ChunkText | null = null;

  // 简单 user_id（v1 用 admin 默认；T11 改从 auth 拿）
  private defaultUserId = "01H0000000000000000000000";

  constructor(store: StatusStore, gate: ConcurrencyGate) {
    this.store = store;
    this.gate = gate;
  }

  setParser(parser: LocalParser): void { this.parser = parser; }
  setEmbedder(embedder: LocalEmbedder): void { this.embedder = embedder; }
  setPusher(pusher: CloudPusher): void { this.pusher = pusher; }
  setChunker(chunker: ChunkText): void { this.chunker = chunker; }

  /** 主入口：处理单个文件（fire-and-forget 调） */
  async processFile(fileId: string): Promise<void> {
    const record = this.store.getByFileId(fileId);
    if (!record) {
      console.error(`[orchestrator] file_id ${fileId} not found`);
      return;
    }

    try {
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

      // 2. chunkText
      this.store.setStatus(fileId, "chunking", 30);
      if (!this.chunker) throw new Error("Chunker not initialized");
      const chunks = await this.chunker.chunkText(markdown);
      if (chunks.length === 0) {
        throw new ParseFailedError("chunker produced 0 chunks (empty content?)");
      }
      this.store.update(fileId, { chunks_count: chunks.length, chunks_json: JSON.stringify(chunks) });

      // 3. embed
      this.store.setStatus(fileId, "embedding", 50);
      if (!this.embedder) throw new Error("Embedder not initialized");
      const embeddings = await this.gate.embed(() =>
        this.embedder!.embedBatch(chunks.map((c) => c.content)),
      );
      if (embeddings.length !== chunks.length) {
        throw new EmbedError(`embedder returned ${embeddings.length} embeddings for ${chunks.length} chunks`);
      }
      // 4. push
      this.store.setStatus(fileId, "pushing", 80);
      if (!this.pusher) throw new Error("Pusher not initialized");
      const pushResult = await this.gate.push(() =>
        this.pusher!.push({
          markdown,
          source_meta: {
            url: `local://${record.filename}`,
            type: record.ext,
            title: record.filename,
            trust_level: 1,  // T11: 改为从 request 拿
            user_id: this.defaultUserId,
          },
          document_meta: {
            title: record.filename,
            rawPath: undefined,
            previewSnippet: markdown.slice(0, 200),
          },
          chunks: chunks.map((c, i) => ({
            content: c.content,
            embedding: embeddings[i]!,
            idx: c.idx,
            token_count: c.tokenCount,
          })),
        }),
      );

      // 5. done
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
