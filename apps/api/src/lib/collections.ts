/**
 * CP-6: CloudBase NoSQL collection 名称常量 + 类型守卫
 *
 * 10 collection（spec §3.1，1:1 映射 v0 D1 表）：
 *   - source
 *   - document
 *   - chunk
 *   - query_cache
 *   - chat_session
 *   - user
 *   - user_session_key
 *   - login_attempt
 *   - crawl_job
 *   - audit_log (CP-7-C #2)
 *
 * CloudBase 控制台需手动创建（无 SDK migration）；用 init-collections.ts 脚本可批量创建。
 */

import type {
  Source,
  Document,
  Chunk,
  QueryCache,
  ChatSession,
  User,
  UserSessionKey,
  LoginAttempt,
  CrawlJob,
} from "@unequal/shared/types";
import type { AuditEntry } from "./audit.js";

export const COLLECTIONS = {
  source: "source",
  document: "document",
  chunk: "chunk",
  queryCache: "query_cache",
  chatSession: "chat_session",
  user: "user",
  userSessionKey: "user_session_key",
  loginAttempt: "login_attempt",
  crawlJob: "crawl_job",
  auditLog: "audit_log",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/** collection → 文档类型映射 */
export interface CollectionDocMap {
  source: Source;
  document: Document;
  chunk: Chunk;
  query_cache: QueryCache;
  chat_session: ChatSession;
  user: User;
  user_session_key: UserSessionKey;
  login_attempt: LoginAttempt;
  crawl_job: CrawlJob;
  audit_log: AuditEntry;
}

export const COLLECTION_DOC_TYPES: { [K in CollectionName]: keyof CollectionDocMap } = {
  source: "source",
  document: "document",
  chunk: "chunk",
  query_cache: "query_cache",
  chat_session: "chat_session",
  user: "user",
  user_session_key: "user_session_key",
  login_attempt: "login_attempt",
  crawl_job: "crawl_job",
  audit_log: "audit_log",
};

/** 需要在 CloudBase 控制台建的 field index（spec §3.3） */
export const REQUIRED_INDEXES: Array<{
  collection: CollectionName;
  field: string;
}> = [
  { collection: COLLECTIONS.chunk, field: "documentId" },
  { collection: COLLECTIONS.chunk, field: "sourceId" },
  { collection: COLLECTIONS.chunk, field: "userId" },
  { collection: COLLECTIONS.document, field: "sourceId" },
  { collection: COLLECTIONS.chatSession, field: "userId" },
  { collection: COLLECTIONS.loginAttempt, field: "clientIpHash" },
  { collection: COLLECTIONS.userSessionKey, field: "userId" },
  { collection: COLLECTIONS.crawlJob, field: "sourceId" },
  { collection: COLLECTIONS.crawlJob, field: "status" },
  { collection: COLLECTIONS.auditLog, field: "timestamp" },
  { collection: COLLECTIONS.auditLog, field: "actor.via" },
  // P9 真接 follow-up #12: action 索引, 加速 whereQuery({action}) 查询
  // 修 P9 verify 17s polling 找不到 audit_log chat_nli_async record (全表 scan 慢)
  { collection: COLLECTIONS.auditLog, field: "action" },
];