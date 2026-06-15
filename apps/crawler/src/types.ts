/**
 * 网页抓取结果。
 *
 * `platformSpecific` 是 M5 引入的可选扩展字段，覆盖非通用 webpage 场景：
 * - 小红书：author（小红书用户名）+ publishedAt（发布时间）
 * - 微信公众号：account（公众号名）+ publishedAt（发布时间）
 * - 普通 webpage：不填
 *
 * M4 webpage source 不写该字段，运行时安全。
 */
export interface CrawledDocument {
  url: string;
  title: string;
  /** 抓取到的纯文本段落（去 HTML 标签后） */
  paragraphs: string[];
  /** 所有段落拼接的总字符数 */
  totalChars: number;
  /** 抓取时间戳 ms */
  fetchedAt: number;
  /** 平台特定字段（XHS / WX-MP 填，普通 webpage 留空） */
  platformSpecific?: {
    /** 小红书：用户名；微信公众号：公众号名 */
    author?: string;
    /** 发布或更新时间（ISO 字符串，平台原始格式） */
    publishedAt?: string;
  };
}

/**
 * 调 /ingest 时的 payload（与 apps/api M0+M1 ingest schema 对齐）。
 * source.type = 'webpage'（schema CHECK 已支持）。
 */
export interface IngestPayload {
  source: {
    type: "file" | "webpage" | "xiaohongshu" | "wechat-mp";
    title: string;
    url: string;
    trust_level: 0 | 1 | 2 | 3;
    meta?: Record<string, unknown>;
  };
  document: {
    title: string;
    raw_path: string;
    parsed_text: string;
  };
  chunks: Array<{
    idx: number;
    content: string;
    token_count: number;
    trust_level: 0 | 1 | 2 | 3;
  }>;
}
