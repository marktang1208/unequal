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
  /** 平台特定字段（XHS / WX-MP 填，普通 webpage 留空）。 */
  /**
   * 注：XHS 与 WX-MP 字段含义不同（XHS author=用户名，WX-MP author=公众号名），
   * 命名统一以减少 schema 复杂度。typecheck 仅校验形状，运行时 consumer 应结合 source.type 解读。
   * v2+ 可改 discriminated union 做更严的类型安全。
   */
  platformSpecific?: {
    /** 小红书：用户名；微信公众号：公众号名（命名统一） */
    author?: string;
    /**
     * 发布时间字符串。**注意：保留平台原始格式**，不做 ISO 归一化：
     * - 小红书：`meta[property="article:published_time"]` 通常为 ISO 8601
     * - 微信公众号：`#publish_time` 文本（例 `2026-06-08 14:23`）
     * consumer 解析时按 source.type 分支处理。
     */
    publishedAt?: string;
  };
}

/**
 * 调 /api-ingest 的 body（与 apps/api IngestRequest 对齐）。
 * - user_id 缺省时不写该字段；CLI 必须配 --ingest-proxy-secret 才能传 user_id
 * - 不嵌 chunks（api 端 chunkText 自己生成）
 */
export interface IngestBody {
  content: string;
  title?: string;
  url: string;
  trust_level: 0 | 1 | 2 | 3;
  user_id?: string;
}
