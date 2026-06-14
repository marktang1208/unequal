export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface MiniMaxEmbedderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

export function createMiniMaxEmbedder(config: MiniMaxEmbedderConfig): Embedder {
  const f = config.fetchImpl ?? fetch;
  const maxRetries = config.maxRetries ?? 3;

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
              input: texts,
            }),
          });

          if (!res.ok) {
            const body = await res.text();
            throw new Error(`MiniMax embedding failed: ${res.status} ${body}`);
          }

          const json = (await res.json()) as {
            data: Array<{ embedding: number[] }>;
          };
          return json.data.map((d) => d.embedding);
        } catch (e) {
          lastError = e;
          // 指数退避：100ms, 200ms, 400ms
          await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
        }
      }
      throw lastError;
    },
  };
}