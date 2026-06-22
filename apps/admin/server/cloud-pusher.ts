/**
 * CP-7-C: CloudPusher — POST /api-ingest (markdown only)
 *
 * 调用 CloudBase Gateway（ap-shanghai.app.tcloudbase.com）/api-ingest
 * Header: X-Ingest-Proxy-Secret: $INGEST_PROXY_SECRET
 *
 * Payload schema（与 apps/api/src/handlers/api-ingest.ts IngestRequest 对齐）：
 *   { content, title, url, trust_level, user_id? }
 *
 * API 端自己 chunk + embed（MiniMax embo-01 → 1536 维），admin 端只传 markdown。
 *   这避免了 admin 端 embed 浪费 OMLX 算力 + 避免 5MB payload 限制
 *   （1536 维 × 30 chunks ≈ 1MB+ 嵌入数组）。
 *
 * 错误分类（spec §4.1）：
 *   - AuthError (401/403): no retry
 *   - RateLimitError (429): retry
 *   - ServerError (5xx): retry
 *   - NetworkError: retry
 */

export interface CloudPusherInput {
  content: string;
  title?: string;
  url: string;
  trust_level: 0 | 1 | 2 | 3;
  user_id?: string;
}

export interface CloudPusherResult {
  source_id: string;
  document_id: string;
  chunks_inserted: number;
  chunks_failed: number;
}

/** v2.4: 推预嵌入 chunks */
export interface ChunksPushInput {
  chunks: Array<{ idx: number; content: string; embedding: number[]; tokenCount: number }>;
  title?: string;
  url: string;
  trust_level: 0 | 1 | 2 | 3;
  user_id?: string;
}

export class PushError extends Error {
  constructor(message: string, public readonly code: "AuthError" | "RateLimit" | "ServerError" | "NetworkError", public readonly retryable: boolean, public readonly status?: number) {
    super(message);
    this.name = "PushError";
  }
}

export interface CloudPusherOptions {
  baseUrl?: string;
  proxySecret?: string;
  fetchImpl?: typeof fetch;
  maxRetries5xx?: number;       // default 2
  maxRetries429?: number;       // default 3
  backoffBase5xxMs?: number;    // default 1000
  backoffBase429Ms?: number;    // default 5000
}

export class CloudPusher {
  private baseUrl: string;
  private secret: string;
  private fetch: typeof fetch;
  private maxRetries5xx: number;
  private maxRetries429: number;
  private backoff5xx: number;
  private backoff429: number;

  constructor(opts: CloudPusherOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com";
    this.secret = opts.proxySecret ?? process.env.INGEST_PROXY_SECRET ?? "5852adc613c74d479907d68c22c478d2d11edb7340c9a4b8b0e1061b21be58a1";
    this.fetch = opts.fetchImpl ?? fetch;
    this.maxRetries5xx = opts.maxRetries5xx ?? 2;
    this.maxRetries429 = opts.maxRetries429 ?? 3;
    this.backoff5xx = opts.backoffBase5xxMs ?? 1000;
    this.backoff429 = opts.backoffBase429Ms ?? 5000;
  }

  /** v2.4: 推预嵌入 chunks（云端直接写库，不调 LLM） */
  async pushChunks(input: ChunksPushInput): Promise<CloudPusherResult> {
    return this._doPost(input);
  }

  async push(input: CloudPusherInput): Promise<CloudPusherResult> {
    return this._doPost(input);
  }

  private async _doPost(input: CloudPusherInput | ChunksPushInput): Promise<CloudPusherResult> {
    const url = `${this.baseUrl}/api-ingest`;
    // 统一序列化：push 走 content 字段，pushChunks 走 chunks 字段，云端 api-ingest handler 分叉处理
    const body = JSON.stringify(input);

    let attempt429 = 0;
    let attempt5xx = 0;
    // 总尝试次数 = 1 (首次) + 2 (5xx) + 3 (429) = 最多 6 次
    // 但 spec 说 "5xx 2 次" + "429 3 次" → 实际可能是混合重试
    // v1 简化：先试首次 + 5xx 2 次（4xx 立即抛）+ 429 3 次
    // 实际上 4xx 不重试，5xx 2 次重试，429 3 次重试
    // 最多 1+2+3 = 6 次，但 4xx 立即返

    while (true) {
      let resp: Response;
      try {
        resp = await this.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Ingest-Proxy-Secret": this.secret,
          },
          body,
        });
      } catch (err) {
        // 网络错误
        const message = err instanceof Error ? err.message : String(err);
        // 网络错误可重试（但 v1 简单：直接抛）
        throw new PushError(`Network error: ${message}`, "NetworkError", true);
      }

      if (resp.ok) {
        // 200: 解析响应
        const data = (await resp.json()) as { source_id: string; document_id: string; chunks_inserted?: number; chunks_failed?: number };
        if (!data.source_id || !data.document_id) {
          throw new PushError(`Invalid response: missing source_id/document_id`, "ServerError", true, 200);
        }
        return {
          source_id: data.source_id,
          document_id: data.document_id,
          chunks_inserted: data.chunks_inserted ?? 0,
          chunks_failed: data.chunks_failed ?? 0,
        };
      }

      const status = resp.status;

      // 4xx auth: 不重试
      if (status === 401 || status === 403) {
        const text = await resp.text();
        throw new PushError(`Auth failed: ${status} ${text.slice(0, 200)}`, "AuthError", false, status);
      }

      // 400: 不重试（请求格式错）
      if (status === 400) {
        const text = await resp.text();
        throw new PushError(`Bad request: 400 ${text.slice(0, 200)}`, "AuthError", false, status);
      }

      // 429: 限流
      if (status === 429) {
        attempt429++;
        if (attempt429 > this.maxRetries429) {
          const text = await resp.text();
          throw new PushError(`Rate limited after ${attempt429} retries: ${text.slice(0, 200)}`, "RateLimit", true, status);
        }
        const backoff = this.backoff429 * Math.pow(2, attempt429 - 1);  // 5s/10s/20s
        await this.sleep(backoff);
        continue;
      }

      // 5xx: server error
      if (status >= 500 && status < 600) {
        attempt5xx++;
        if (attempt5xx > this.maxRetries5xx) {
          const text = await resp.text();
          throw new PushError(`Server error after ${attempt5xx} retries: ${status} ${text.slice(0, 200)}`, "ServerError", true, status);
        }
        const backoff = this.backoff5xx * Math.pow(2, attempt5xx - 1);  // 1s/3s
        await this.sleep(backoff);
        continue;
      }

      // 其他
      const text = await resp.text();
      throw new PushError(`Unexpected status: ${status} ${text.slice(0, 200)}`, "ServerError", true, status);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
