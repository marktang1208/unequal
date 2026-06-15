import type { AskResponse, AskError } from "./types.js";

/**
 * 调 /ask endpoint 拿单轮问答。
 * Mock-first：
 * - 开发期 base URL = http://localhost:8787（需在微信开发者工具勾选「不校验合法域名」）
 * - CP-5 真接 Cloudflare 后改 https://unequal.xxx.workers.dev
 * - fetch 注入点允许测试桩（Vitest 单测）
 */

export interface AskOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export async function ask(q: string, opts: AskOptions = {}): Promise<AskResponse> {
  const baseUrl = opts.baseUrl ?? "http://localhost:8787";
  const f = opts.fetchImpl ?? fetch;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  const res = await f(`${baseUrl}/ask`, {
    method: "POST",
    headers,
    body: JSON.stringify({ q }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as AskError;
    throw new Error(`/ask ${res.status}: ${body.error ?? "unknown"}`);
  }

  return (await res.json()) as AskResponse;
}
