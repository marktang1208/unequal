import * as cheerio from "cheerio";
import type { CrawledDocument } from "../types.js";

export interface FetchXhsOptions {
  /** 测试用：注入 fake fetch */
  fetchImpl?: typeof fetch;
  /** User-Agent，默认 XHS 移动端 UA（提升兼容性） */
  userAgent?: string;
}

const DEFAULT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49 (0x18003130) NetType/WIFI Language/zh_CN";

/**
 * 抓取小红书单帖 URL → 解析 → 返回 CrawledDocument (含 platformSpecific)。
 *
 * 解析字段（按优先级降级）：
 * - title: og:title → <title>
 * - author: .author .username → meta[name="author"]
 * - publishedAt: meta[property="article:published_time"]
 * - paragraphs: #detail-desc p → .note-content p
 *
 * Mock-first：测试用 fetchImpl 注入。
 */
export async function fetchXiaohongshuNote(
  url: string,
  opts: FetchXhsOptions = {}
): Promise<CrawledDocument> {
  const f = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_UA;

  const res = await f(url, { headers: { "user-agent": userAgent } });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  // title：og:title 优先，回退 <title>
  const ogTitle = $('meta[property="og:title"]').attr("content");
  const title = ogTitle?.trim() || $("title").first().text().trim() || url;

  // author：.author .username 优先，回退 meta[name=author]
  const authorFromDom = $(".author .username").first().text().trim();
  const authorFromMeta = $('meta[name="author"]').attr("content")?.trim();
  const author = authorFromDom || authorFromMeta || undefined;

  // publishedAt：article:published_time
  const publishedAt =
    $('meta[property="article:published_time"]').attr("content")?.trim() || undefined;

  // paragraphs：#detail-desc p 优先，回退 .note-content p
  const paragraphSelectors = ["#detail-desc p", ".note-content p", "#detail-desc"];
  let paragraphs: string[] = [];
  for (const sel of paragraphSelectors) {
    const found = $(sel)
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((t) => t.length > 0);
    if (found.length > 0) {
      paragraphs = found;
      break;
    }
  }
  const totalChars = paragraphs.reduce((sum, p) => sum + p.length, 0);

  const platformSpecific: CrawledDocument["platformSpecific"] = {};
  if (author) platformSpecific.author = author;
  if (publishedAt) platformSpecific.publishedAt = publishedAt;

  return {
    url,
    title,
    paragraphs,
    totalChars,
    fetchedAt: Date.now(),
    platformSpecific: Object.keys(platformSpecific).length > 0 ? platformSpecific : undefined,
  };
}
