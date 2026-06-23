/**
 * P3-7 / Phase A: CloudEmbedder — MiniMax API embedding
 *
 * 迁移自 `apps/admin/server/cloud-embedder.ts`，行为保持一致。
 *
 * MiniMax embo-01 schema（实测，与 OpenAI 不兼容）：
 *   request:  { model, type: "query"|"db", texts: string[] }
 *   response: { vectors: number[][] }
 *
 * OMLX / OpenAI 风格 { input, data[].embedding } 当前不支持，需走本适配。
 */

import { EmbedError, EXPECTED_EMBED_DIM, type Embedder } from "./types.js";

export interface CloudEmbedderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  expectedDim?: number;
  fetchImpl?: typeof fetch;
}

export class CloudEmbedder implements Embedder {
  /** zhenjie5: MiniMax embo-01 单次请求 batch 限，实测 1520 一次性发返 vectors=null
   * 设 100 留余量（10 chunks/批在 OMLX 上限，MiniMax 可以更大；100 平衡 RTT vs 稳定性） */
  private static readonly BATCH_SIZE = 100;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private expectedDim: number;
  private fetch: typeof fetch;

  constructor(opts: CloudEmbedderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.minimax.chat/v1";
    this.model = opts.model ?? "embo-01";
    this.expectedDim = opts.expectedDim ?? EXPECTED_EMBED_DIM;
    this.fetch = opts.fetchImpl ?? fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // zhenjie5: MiniMax 单次 batch 限，分批调
    const allVectors: number[][] = [];
    for (let i = 0; i < texts.length; i += CloudEmbedder.BATCH_SIZE) {
      const batch = texts.slice(i, i + CloudEmbedder.BATCH_SIZE);
      const batchVectors = await this._embedBatch(batch);
      allVectors.push(...batchVectors);
    }
    return allVectors;
  }

  private async _embedBatch(texts: string[]): Promise<number[][]> {
    try {
      const res = await this.fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          type: "query",
          texts,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 401 || res.status === 403) {
          throw new EmbedError(`Auth failed: ${res.status} ${text.slice(0, 200)}`, "OMLX_Unavailable");
        }
        throw new EmbedError(`Cloud embed failed: ${res.status} ${text.slice(0, 200)}`, "Unknown");
      }
      const data = (await res.json()) as { vectors: number[][] | null };
      const vectors = data.vectors;
      if (!vectors) {
        throw new EmbedError(`Cloud embed returned null vectors (texts=${texts.length})`, "Unknown");
      }
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

  /** v1 兼容：保持 `embedBatch` 名字 */
  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.embed(texts);
  }
}
