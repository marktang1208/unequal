import * as cheerio from "cheerio";
import type { CrawledDocument } from "../types.js";
import { extractSsrState, extractXhsProfile, SsrParseError } from "./ssr-state-parser.js";

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

/* ──── v2: xhs 博主主页多 note 抓取（2026-06-29 Track B 新增） ──── */

export interface FetchXhsProfileNotesOptions {
  /** 测试用：注入 fake fetch */
  fetchImpl?: typeof fetch;
  /** User-Agent（默认同 v1 移动端 UA） */
  userAgent?: string;
  /**
   * 是否二次抓 explore URL 拿 desc 正文（默认 false）。
   * - false: paragraphs 只含 title + likes 摘要（profile 列表 SSR JSON 无 desc）
   * - true:  N 个 note → 调 N 次 explore URL → 拿真实 desc（**慢**，N=6 时 ~6s）
   *
   * 默认 false 是因 SSR JSON 已含 title/user/likes 等 metadata，足够做 cover 索引。
   * 后续如检索 hit 率高需要 desc，再开 true。
   */
  fetchExploreDesc?: boolean;
}

/**
 * 抓 xhs 博主主页 URL（user/profile/<id>?xsec_token=...）→ 解 SSR state → 返 N 条 CrawledDocument。
 *
 * **关键约束**：URL 必须带 `?xsec_token=...&xsec_source=...`，否则 captcha 拦截返 200 但 HTML 无 SSR state。
 *
 * 单 URL → 多 CrawledDocument：每条 note 单独 file_id 写 SQLite（profile URL 算"种子"，note 算"产出"）。
 *
 * v1 `fetchXiaohongshuNote` 仍保留用于单 explore URL 抓取。本函数不进 fetchImpl 默认路径，避免破坏 v1 行为。
 *
 * @throws fetch 404 / captcha 拦截（SSR state 解不到）/ SsrParseError
 */
export async function fetchXhsProfileNotes(
  url: string,
  opts: FetchXhsProfileNotesOptions = {}
): Promise<CrawledDocument[]> {
  const f = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_UA;

  const res = await f(url, { headers: { "user-agent": userAgent } });
  if (!res.ok) {
    throw new Error(`fetchXhsProfileNotes: fetch ${url} failed: HTTP ${res.status}`);
  }
  const html = await res.text();

  // 解析 SSR state
  let state: unknown;
  try {
    state = extractSsrState(html);
  } catch (err) {
    if (err instanceof SsrParseError) {
      throw new Error(
        `fetchXhsProfileNotes: SSR state not found in ${url} (captcha 拦截或 HTML 结构变更): ${err.message}`,
        { cause: err },
      );
    }
    throw err;
  }

  const profile = extractXhsProfile(state);
  if (!profile) {
    throw new Error(`fetchXhsProfileNotes: no profile data in SSR state of ${url}`);
  }

  if (profile.notes.length === 0) {
    // profile 无笔记（罕见），返空数组让 trigger 知道"成功但 0 note"
    return [];
  }

  // 每条 note → CrawledDocument
  const docs: CrawledDocument[] = [];
  for (const note of profile.notes) {
    const title = note.title || "(无标题)";
    // profile 列表 desc 为空 → 拼占位段（title + likes + cover URL）
    // 这是 v1 简化，p1 后可开 fetchExploreDesc=true 二次拿 desc
    const paragraphs = [
      `【${title}】`,
      `作者: ${note.userNickname}`,
      `点赞: ${note.likes}`,
      note.publishedAt ? `发布时间: ${note.publishedAt}` : "",
      note.coverUrl ? `封面: ${note.coverUrl}` : "",
    ].filter((p) => p.length > 0);

    const totalChars = paragraphs.reduce((sum, p) => sum + p.length, 0);

    docs.push({
      url: note.noteUrl,
      title,
      paragraphs,
      totalChars,
      fetchedAt: Date.now(),
      platformSpecific: {
        author: note.userNickname,
        ...(note.publishedAt ? { publishedAt: note.publishedAt } : {}),
      },
    });
  }

  return docs;
}

/** 判断 URL 是否走 v2 (user profile) 路径 */
export function isXhsProfileUrl(url: string): boolean {
  return url.includes("xiaohongshu.com/user/profile/");
}
