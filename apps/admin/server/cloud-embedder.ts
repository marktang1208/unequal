/**
 * CP-7-C: CloudEmbedder — MiniMax API embedding
 *
 * MiniMax OpenAI 兼容 embed API（packages/shared/embedding.ts 已有 MiniMaxEmbedder）
 * 这里重新包装：返回 1536 维向量（MiniMax 默认），错误分类为 EmbedError 兼容 orchestrator
 */

import { EmbedError } from "./local-embedder.js";

export interface CloudEmbedderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  expectedDim?: number;
  fetchImpl?: typeof fetch;
}

export class CloudEmbedder {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private expectedDim: number;
  private fetch: typeof fetch;

  constructor(opts: CloudEmbedderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.minimax.chat/v1";
    this.model = opts.model ?? "embo-01";
    this.expectedDim = opts.expectedDim ?? 1536;
    this.fetch = opts.fetchImpl ?? fetch;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    try {
      const res = await this.fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          encoding_format: "float",
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 401 || res.status === 403) {
          throw new EmbedError(`Auth failed: ${res.status} ${text.slice(0, 200)}`, "OMLX_Unavailable");
        }
        throw new EmbedError(`Cloud embed failed: ${res.status} ${text.slice(0, 200)}`, "Unknown");
      }
      const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
      const vectors = data.data.map((d) => d.embedding);

      if (vectors.length > 0) {
        const dim = vectors[0]?.length ?? 0;
        if (dim !== this.expectedDim) {
          throw new EmbedError(
            `Cloud embed dim mismatch: expected ${this.expectedDim}, got ${dim} (model=${this.model})`,
            "DimensionMismatch",
          );
        }
      }
      return vectors;
    } catch (err) {
      if (err instanceof EmbedError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      const code: EmbedError["code"] =
        msg.includes("ECONNREFUSED") || msg.includes("fetch failed") ? "OMLX_Unavailable" : "Unknown";
      throw new EmbedError(`Cloud embed failed: ${msg}`, code, err);
    }
  }
}