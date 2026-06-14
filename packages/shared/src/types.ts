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
  rawPath: string;
  parsedTextPath?: string;
  createdAt: number;
}

export interface Chunk {
  id: string;
  documentId: string;
  sourceId: string;
  userId: string;
  idx: number;
  content: string;
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