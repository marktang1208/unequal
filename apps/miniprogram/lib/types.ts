/**
 * 小程序端类型（与 M2 packages/shared/src/types.ts Citation 对齐）。
 * 镜像定义而非 import 是为了避免跨 runtime 依赖：
 * - 小程序 runtime 不支持 node 模块系统
 * - admin/admin 已独立 lib/types
 */

export interface Citation {
  n: number;            // 1..5
  title: string;
  snippet: string;
  url: string;          // R2 原始文件 URL 或 raw_path
  trustLevel: 0 | 1 | 2 | 3;
  sourceId: string;
  chunkId: string;
}

export interface AskResponse {
  answer: string;       // 含 [来源 N] 标记 + 免责声明
  disclaimer: string;
  citations: Citation[];
  cached: boolean;
}

export interface AskError {
  error: string;
  detail?: string;
}

export interface HistoryEntry {
  id: string;           // ulid
  q: string;
  response: AskResponse;
  createdAt: number;    // ms
}

/* ---------- M6.1 多轮会话类型（与 api 端 ChatRequest / ChatResponse 对齐） ---------- */

export interface ChatRequest {
  q: string;
  session_id?: string;
}

export interface ChatCitation {
  n: number;
  title: string;
  trust_level: 0 | 1 | 2 | 3;
  chunk_id: string;
}

export interface ChatResponse {
  answer: string;
  disclaimer?: string;
  citations: ChatCitation[];
  session_id: string;
  session_title: string | null;
  is_new_session: boolean;
  cached: boolean;
  degraded: boolean;
}

export interface ChatSessionRow {
  id: string;            // ULID
  user_id: string;
  title: string | null;
  created_at: number;
  last_active_at: number;
  degraded_at: number | null;
}

export interface SessionsListResponse {
  sessions: ChatSessionRow[];
}
