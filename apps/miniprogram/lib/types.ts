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
  /** M7-B: 限定 sourceType 列表（如 ["pdf", "webpage"]）；undefined = 不过滤 */
  source_types?: string[];
  /** M7-B: 排除 sourceId 列表；undefined = 不排除 */
  exclude_source_ids?: string[];
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
  // CP-6 P3.9 修复：跟 server sessions-list handler 返回对齐（camelCase，原 spec snake_case 不一致）
  id: string;
  title: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionsListResponse {
  sessions: ChatSessionRow[];
}

/* ---------- CP-7-B 真接 round 3：getSession 返单 session 详情含 messages ---------- */

export interface ChatMessageRow {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface SessionDetailResponse {
  _id?: string;
  id: string;
  userId?: string;
  title?: string;
  messages: ChatMessageRow[];
  createdAt: number;
  updatedAt: number;
}
