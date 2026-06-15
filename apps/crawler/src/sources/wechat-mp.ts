import * as cheerio from "cheerio";
import type { CrawledDocument } from "../types.js";

export interface FetchWxMpOptions {
  /** 测试用：注入 fake fetch */
  fetchImpl?: typeof fetch;
  /** User-Agent，默认微信内置浏览器 UA */
  userAgent?: string;
}

const DEFAULT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49 (0x18003130) NetType/WIFI Language/zh_CN";

/**
 * 抓取微信公众号单文章 URL → 解析 → 返回 CrawledDocument (含 platformSpecific)。
 *
 * 解析字段：
 * - title: #activity-name（最强选择器，覆盖 og:title）
 * - account (#js_name) → 映射到 platformSpecific.author（统一字段名）
 * - publishedAt: #publish_time
 * - paragraphs: #js_content p，过滤 style="display:none"
 *
 * Mock-first：测试用 fetchImpl 注入。
 */
export async function fetchWechatMpArticle(
  url: string,
  opts: FetchWxMpOptions = {}
): Promise<CrawledDocument> {
  const f = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_UA;

  const res = await f(url, { headers: { "user-agent": userAgent } });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  // title：#activity-name 优先
  const titleFromActivity = $("#activity-name").first().text().trim();
  const titleFromOg = $('meta[property="og:title"]').attr("content")?.trim();
  const title = titleFromActivity || titleFromOg || $("title").first().text().trim() || url;

  // account → 映射到 author
  const account = $("#js_name").first().text().trim() || undefined;

  // publishedAt
  const publishedAt = $("#publish_time").first().text().trim() || undefined;

  // paragraphs：过滤 display:none
  const paragraphs = $("#js_content p")
    .filter((_, el) => {
      const style = $(el).attr("style") ?? "";
      return !style.includes("display:none") && !style.includes("display: none");
    })
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length > 0);

  const totalChars = paragraphs.reduce((sum, p) => sum + p.length, 0);

  const platformSpecific: CrawledDocument["platformSpecific"] = {};
  if (account) platformSpecific.author = account;
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
