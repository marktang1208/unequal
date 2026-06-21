/**
 * CP-7-C: LocalEmbedder — OMLX (Qwen3-Embedding-4B) embedding
 *
 * OMLX 提供 OpenAI 兼容 API：http://localhost:8000/v1
 * 默认 model: Qwen3-Embedding-4B-4bit-DWQ (matryoshka 1536 维)
 *
 * 设计：
 * - Qwen3-Embedding 支持 matryoshka 截断：通过 `dimensions` 参数指定输出维度
 * - 1536 维跟 CloudBase MiniMax 默认对齐（api-router cosineSimilarity 通过）
 * - 注入式构造（测试可 mock OpenAI client）
 *
 * 错误分类：OMLX_Unavailable / OOM / DimensionMismatch / Unknown
 *
 * v2 变更（2026-06-22）：
 * - 从 bge-m3 (1024 维锁死) 改为 Qwen3-Embedding-4B-4bit-DWQ (matryoshka → 1536)
 * - 原因：cosineSimilarity 要 a.length===b.length，admin 存 1024 跟 MiniMax 1536 冲突
 */

import OpenAI from "openai";
import type { EmbeddingCreateParams } from "openai/resources/embeddings.js";

export class EmbedError extends Error {
  constructor(message: string, public readonly code: "OMLX_Unavailable" | "OOM" | "DimensionMismatch" | "Unknown", public readonly cause?: unknown) {
    super(message);
    this.name = "EmbedError";
  }
}

export const EXPECTED_DIM = 1536;
export const DEFAULT_MODEL = "Qwen3-Embedding-4B-4bit-DWQ";
export const OMLX_BASE_URL = "http://localhost:8000/v1";

export interface LocalEmbedderOptions {
  baseUrl?: string;
  apiKey?: string;          // OMLX 不需要但 OpenAI SDK 必填（"mark" 即可）
  model?: string;
  fetchImpl?: typeof fetch;  // 测试用
}

export class LocalEmbedder {
  private client: OpenAI;
  private model: string;
  private baseUrl: string;

  constructor(opts: LocalEmbedderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? OMLX_BASE_URL;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? "mark",  // OMLX 默认 key "mark"，见 ~/.omlx/settings.json
      baseURL: this.baseUrl,
      // OMLX 部署在 Mac 本地，测试环境也是 Node，但 OpenAI SDK 4.x+ 默认拒绝 browser-like env
      dangerouslyAllowBrowser: true,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl as any } : {}),
    });
  }

  /** 批量 embed → number[][] (每行 1536 维) */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    try {
      const params: EmbeddingCreateParams = {
        model: this.model,
        input: texts,
        encoding_format: "float",
        // matryoshka 截断到 EXPECTED_DIM；OMLX bge-m3 不支持但 Qwen3-Embedding 支持
        dimensions: EXPECTED_DIM,
      };
      const resp = await this.client.embeddings.create(params);
      const vectors = resp.data.map((d) => d.embedding);

      // 验证维度
      if (vectors.length > 0) {
        const dim = vectors[0]?.length ?? 0;
        if (dim !== EXPECTED_DIM) {
          throw new EmbedError(
            `Embedding dim mismatch: expected ${EXPECTED_DIM}, got ${dim} (model=${this.model})`,
            "DimensionMismatch",
          );
        }
      }
      return vectors;
    } catch (err) {
      if (err instanceof EmbedError) throw err;
      // 推断错误类型
      const msg = err instanceof Error ? err.message : String(err);
      const ctor = err instanceof Error ? err.constructor.name : "";
      const code: EmbedError["code"] =
        ctor === "APIConnectionError" || msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("Connection error")
          ? "OMLX_Unavailable"
          : msg.includes("OOM") || msg.includes("out of memory")
          ? "OOM"
          : msg.includes("dim") || msg.includes("dimension")
          ? "DimensionMismatch"
          : "Unknown";
      throw new EmbedError(`OMLX embedding failed: ${msg}`, code, err);
    }
  }
}