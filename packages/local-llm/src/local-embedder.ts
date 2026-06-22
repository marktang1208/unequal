/**
 * P3-7 / Phase A: LocalEmbedder — OMLX (Qwen3-Embedding-4B) embedding
 *
 * 迁移自 `apps/admin/server/local-embedder.ts`，行为保持一致。
 *
 * OMLX 提供 OpenAI 兼容 API：http://localhost:8000/v1
 * 默认 model: Qwen3-Embedding-4B-4bit-DWQ (matryoshka 1536 维)
 */

import OpenAI from "openai";
import type { EmbeddingCreateParams } from "openai/resources/embeddings.js";
import { EmbedError, EXPECTED_EMBED_DIM, type Embedder } from "./types.js";

export const DEFAULT_LOCAL_EMBED_MODEL = "Qwen3-Embedding-4B-4bit-DWQ";
export const OMLX_BASE_URL = "http://localhost:8000/v1";

export interface LocalEmbedderOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  expectedDim?: number;
  fetchImpl?: typeof fetch;
}

export class LocalEmbedder implements Embedder {
  private client: OpenAI;
  private model: string;
  private expectedDim: number;

  constructor(opts: LocalEmbedderOptions = {}) {
    const baseUrl = opts.baseUrl ?? OMLX_BASE_URL;
    this.model = opts.model ?? DEFAULT_LOCAL_EMBED_MODEL;
    this.expectedDim = opts.expectedDim ?? EXPECTED_EMBED_DIM;
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? "mark",
      baseURL: baseUrl,
      dangerouslyAllowBrowser: true,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl as any } : {}),
    });
  }

  /** 批量分块大小：避免 OMLX 80+ 长文本卡 loadText/OOM（实测单批 18s OK，>30 文本+长内容 hang） */
  private static readonly BATCH_SIZE = 10;

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
      // 分批 embed：每批 ≤ 10 文本（已验证 OMLX 稳定）
      const allVectors: number[][] = [];
      for (let i = 0; i < texts.length; i += LocalEmbedder.BATCH_SIZE) {
        const batch = texts.slice(i, i + LocalEmbedder.BATCH_SIZE);
        const params: EmbeddingCreateParams = {
          model: this.model,
          input: batch,
          encoding_format: "float",
          dimensions: this.expectedDim,
        };
        const resp = await this.client.embeddings.create(params);
        const vectors = resp.data.map((d) => d.embedding);
        if (vectors.length > 0) {
          const dim = vectors[0]?.length ?? 0;
          if (dim !== this.expectedDim) {
            throw new EmbedError(
              `Embedding dim mismatch: expected ${this.expectedDim}, got ${dim} (model=${this.model})`,
              "DimensionMismatch",
            );
          }
        }
        allVectors.push(...vectors);
      }
      return allVectors;
    } catch (err) {
      if (err instanceof EmbedError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      const ctor = err instanceof Error ? err.constructor.name : "";
      const code: EmbedError["code"] =
        ctor === "APIConnectionError" ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("fetch failed") ||
        msg.includes("Connection error")
          ? "OMLX_Unavailable"
          : msg.includes("OOM") || msg.includes("out of memory")
          ? "OOM"
          : msg.includes("dim") || msg.includes("dimension")
          ? "DimensionMismatch"
          : "Unknown";
      throw new EmbedError(`OMLX embedding failed: ${msg}`, code, err);
    }
  }

  /** v1 兼容：保持 `embedBatch` 名字（admin 现有测试 + admin-upload spec 用过） */
  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.embed(texts);
  }
}
