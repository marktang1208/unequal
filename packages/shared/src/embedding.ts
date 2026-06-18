export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface MiniMaxEmbedderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** MiniMax embedding `type` 字段：db = 文档入库, query = 查询向量。默认 db */
  type?: "db" | "query";
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

export function createMiniMaxEmbedder(config: MiniMaxEmbedderConfig): Embedder {
  const f = config.fetchImpl ?? fetch;
  const maxRetries = config.maxRetries ?? 3;
  const embedType = config.type ?? "db";

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      let lastError: unknown;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const res = await f(`${config.baseUrl}/embeddings`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: config.model,
              texts,
              type: embedType,
            }),
          });

          if (!res.ok) {
            const body = await res.text();
            throw new Error(`MiniMax embedding failed: ${res.status} ${body}`);
          }

          const json = (await res.json()) as {
            vectors: number[][] | null;
            base_resp?: { status_code: number; status_msg: string };
          };

          if (!json.vectors || json.vectors.length !== texts.length) {
            throw new Error(
              `MiniMax embedding returned ${json.vectors?.length ?? 0} vectors for ${texts.length} inputs (base_resp: ${JSON.stringify(json.base_resp)})`,
            );
          }

          return json.vectors;
        } catch (e) {
          lastError = e;
          await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
        }
      }
      throw lastError;
    },
  };
}
