import { parseHtml } from "../parser.js";
import type { CrawledDocument } from "../types.js";

export interface FetchUrlOptions {
  /** 测试用：注入 fake fetch */
  fetchImpl?: typeof fetch;
  /** User-Agent，默认 "unequal-crawler/0.1 (+https://unequal.xxx.workers.dev)" */
  userAgent?: string;
}

/**
 * 抓取单个 URL → 解析 → 返回 CrawledDocument。
 * Mock-first：测试用 fetchImpl 注入。
 */
export async function fetchUrl(url: string, opts: FetchUrlOptions = {}): Promise<CrawledDocument> {
  const f = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? "unequal-crawler/0.1 (+https://unequal.xxx.workers.dev)";

  const res = await f(url, { headers: { "user-agent": userAgent } });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  }
  const html = await res.text();
  const parsed = parseHtml(html);
  return {
    url,
    title: parsed.title,
    paragraphs: parsed.paragraphs,
    totalChars: parsed.totalChars,
    fetchedAt: Date.now(),
  };
}
