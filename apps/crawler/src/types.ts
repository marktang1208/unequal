/**
 * 网页抓取结果。
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
