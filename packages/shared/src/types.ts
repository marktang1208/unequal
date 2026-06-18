export type SourceType = "file" | "webpage" | "xiaohongshu" | "wechat-mp";
export type TrustLevel = 0 | 1 | 2 | 3;

export interface User {
  id: string;
  wxOpenid?: string;
  nickname?: string;
  createdAt: number;
}

export interface Source {
  id: string;
  userId: string;
  type: SourceType;
  title?: string;
  url?: string;
  account?: string;
  trustLevel: TrustLevel;
  createdAt: number;
  meta?: Record<string, unknown>;
}

export interface Document {
  id: string;
  sourceId: string;
  userId: string;
  title?: string;
  /** 云存储路径：原文件（PDF / docx） */
  rawPath: string;
  /** 云存储路径：解析后纯文本（CP-6 新增；parsed_text 移出文档 doc） */
  parsedTextPath?: string;
  /** 引用卡片用的前 N 字片段（CP-6 新增，避免拉全文） */
  previewSnippet?: string;
  createdAt: number;
}

/**
 * Chunk: CP-6 嵌入 embedding 字段（替代 v0 在 Vectorize 单独存的模式）。
 * CloudBase NoSQL doc 限制 1MB，单 chunk ~14KB 远不到。
 *
 * `id` 字段保留以兼容历史接口（upload 写时会传 `id: ""`），但实际 ID
 * 由 CloudBase `_id` 自动生成，retrieval/search 应优先读 `chunk._id`。
 */
export interface Chunk {
  id: string;
  /** CloudBase 自动生成的 doc ID（CP-6 migration 期间补回，retrieval 优先用这个） */
  _id?: string;
  documentId: string;
  sourceId: string;
  userId: string;
  idx: number;
  content: string;
  /** 1536-dim MiniMax embedding（spec §4 假设；启动时硬验证） */
  embedding: number[];
  tokenCount: number;
  trustLevel: TrustLevel;
  createdAt: number;
}

export interface Citation {
  n: number;
  title?: string;
  snippet: string;
  url: string;
  trustLevel: TrustLevel;
  sourceId: string;
  chunkId: string;
}

export interface QueryCache {
  id: string;
  userId: string;
  query: string;
  queryVector: number[];
  answer: string;
  citations: Citation[];
  topChunkId?: string;
  topScore?: number;
  createdAt: number;
  expiresAt: number;
}

export interface ChatSession {
  id: string;
  userId: string;
  title?: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  createdAt: number;
}

export interface UserSessionKey {
  id: string;
  userId: string;
  /** AES-256-CBC + HMAC envelope（v0 M6.7） */
  envelope: string;
  /** M6.8: 当前 KEK 版本（默认 1） */
  kekVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface LoginAttempt {
  id: string;
  identifier: string;
  clientIpHash: string;
  success: boolean;
  createdAt: number;
}

export interface CrawlJob {
  id: string;
  userId: string;
  sourceId?: string;
  url: string;
  status: "pending" | "running" | "completed" | "failed";
  error?: string;
  chunksAdded?: number;
  createdAt: number;
  updatedAt: number;
}