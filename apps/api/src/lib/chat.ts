/**
 * M6.1 /chat 核心：runChat（spec §3.2 数据流）。
 *
 * 设计要点：
 * 1. 复用 runAsk 核心 RAG（DI 模式：传 searchFn / cacheRead / cacheWrite，避免重复跑 embedding + search）
 * 2. sessionId 缺 → ulid() 新建 + INSERT D1；sessionId 有 → SELECT 验证存在 + 过期判定
 * 3. 用户限额：active session < 50，否则 409 SESSION_LIMIT_EXCEEDED
 * 4. 调 runAsk 拿 answer → 写 DO（user + assistant）→ UPDATE D1 last_active_at
 * 5. 首问：调 llmTitleFn 生成 title → INSERT 已含；PATCH 单独走 /sessions/:id
 * 6. DO 写失败 → 不影响 answer 返回，标 degraded: true（spec §4.4 / §5.4）
 * 7. env 缺 binding（SESSION_DO）→ degraded 路径不 throw
 *
 * 跟 runAsk 的关键区别：runAsk 是单轮纯 RAG；runChat 加 session 生命周期 + DO 写回。
 *
 * 测试注入（mirror ask.ts:14-21）：
 * - fetchImpl 透传 → 单元测用 fake fetch 拦截 embedding / chat completion
 * - searchFn 透传 → 单元测注入 fake SearchResult[] 避免打 Vectorize
 * - cacheRead / cacheWrite 透传 → 单元测控制缓存命中
 * - llmTitleFn 注入 → 单元测控制 title（默认走 mock：q 前 10 字）
 */

import { ulid } from "ulid";
import { runAsk, type RunAskOptions, type SearchFn } from "./ask.js";
import { appendMessage, getSessionMessages, type SessionDOEnv } from "./do-client.js";
import { HttpError } from "./auth.js";
import { buildMultiturnPrefix, type MultiturnMessage } from "@unequal/shared/multiturn";
import type { ChatResponse, ChatCitation } from "@unequal/shared/chat-types";
import type { Env } from "../types.js";

const MAX_SESSIONS_PER_USER = 50;
const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const DEFAULT_TITLE_CHARS = 10;

export type LlmTitleFn = (q: string) => Promise<string | null>;

/**
 * 默认 title 生成：取 q 前 10 字（spec §5.3 失败 fallback）。
 *
 * 不调 LLM 节省成本；M6.1 阶段家长可手动 PATCH /sessions/:id 改 title。
 */
export const defaultLlmTitleFn: LlmTitleFn = async (q: string) => {
  const trimmed = q.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, DEFAULT_TITLE_CHARS);
};

export interface RunChatOptions {
  userId: string;
  q: string;
  sessionId?: string;
  env: Env;
  fetchImpl?: typeof fetch;
  searchFn?: SearchFn;
  cacheRead?: RunAskOptions["cacheRead"];
  cacheWrite?: RunAskOptions["cacheWrite"];
  llmTitleFn?: LlmTitleFn;
}

interface D1SessionRow {
  id: string;
  user_id: string;
  title: string | null;
  created_at: number;
  last_active_at: number;
  degraded_at: number | null;
}

export interface RunChatResult extends ChatResponse {
  /** DO 写失败 / SESSION_DO 缺 binding 时为 true（spec §4.4） */
  degraded: boolean;
}

export async function runChat(opts: RunChatOptions): Promise<RunChatResult> {
  const { userId, q, env } = opts;

  if (!env.DB) {
    throw new HttpError(500, "INFRA_MISSING", "env.DB is not configured");
  }

  // 1. 解析 sessionId（缺则新建）
  let sessionId = opts.sessionId;
  let isNewSession = false;
  let existingTitle: string | null = null;
  if (!sessionId) {
    sessionId = ulid();
    isNewSession = true;
  } else {
    const existing = await loadSession(env.DB, userId, sessionId);
    if (!existing) {
      throw new HttpError(404, "CHAT_SESSION_NOT_FOUND", `Session ${sessionId} not found`);
    }
    existingTitle = existing.title;
  }

  // 2. 新建时检查限额
  if (isNewSession) {
    const activeCount = await countActiveSessions(env.DB, userId);
    if (activeCount >= MAX_SESSIONS_PER_USER) {
      throw new HttpError(
        409,
        "SESSION_LIMIT_EXCEEDED",
        `Max ${MAX_SESSIONS_PER_USER} active sessions per user`,
      );
    }
  }

  // 3. 拉取历史 messages（拼 context prefix）
  // 新 session 必无历史，直接跳过 DO fetch 节省一次 RTT
  const messages: MultiturnMessage[] = isNewSession
    ? []
    : await safeGetMessages(env, userId, sessionId);
  const contextPrefix = buildMultiturnPrefix(messages);
  const enrichedQ = contextPrefix
    ? `${contextPrefix}\n\n[当前问题]\n${q}`
    : q;

  // 4. 调 runAsk 拿 answer
  const askResult = await runAsk({
    q: enrichedQ,
    env,
    fetchImpl: opts.fetchImpl,
    searchFn: opts.searchFn,
    cacheRead: opts.cacheRead,
    cacheWrite: opts.cacheWrite,
  });

  // 5. 生成 title（仅首问：isNewSession 一定为 true；后续轮 PATCH 单独走 /sessions/:id）
  let sessionTitle: string | null = existingTitle;
  if (isNewSession) {
    try {
      const titleFn = opts.llmTitleFn ?? defaultLlmTitleFn;
      const generated = await titleFn(q);
      sessionTitle = (generated ?? "").trim() || null;
    } catch {
      // title 失败 → 留 null（spec §5.3 不阻塞主流程）
      sessionTitle = null;
    }
  }

  // 6. 写 D1 + DO（user + assistant）；DO 失败 → degraded
  const degraded = await persistSession(env, userId, sessionId, isNewSession, sessionTitle, q, askResult);

  // 7. 构造 ChatResponse
  const citations: ChatCitation[] = askResult.citations.map((c) => ({
    n: c.n,
    title: c.title ?? "(无标题)",
    trust_level: (c.trustLevel ?? 0) as 0 | 1 | 2 | 3,
    chunk_id: c.chunkId,
  }));

  return {
    answer: askResult.answer,
    disclaimer: askResult.disclaimer,
    citations,
    session_id: sessionId,
    session_title: sessionTitle,
    is_new_session: isNewSession,
    cached: askResult.cached,
    degraded,
  };
}

/* ---------- D1 维护 helpers ---------- */

async function loadSession(
  d1: D1Database,
  userId: string,
  sessionId: string,
): Promise<D1SessionRow | null> {
  const row = await d1
    .prepare(
      `SELECT id, user_id, title, created_at, last_active_at, degraded_at
         FROM chat_session
        WHERE id = ? AND user_id = ?`,
    )
    .bind(sessionId, userId)
    .first<D1SessionRow>();
  if (!row) return null;
  // 过期判定（spec §5.2）：lazy 过期，> 30 天不活跃视为过期 → 返 null（让 caller 抛 404）
  if (row.last_active_at < Date.now() - SESSION_EXPIRY_MS) return null;
  return row;
}

async function countActiveSessions(d1: D1Database, userId: string): Promise<number> {
  const cutoff = Date.now() - SESSION_EXPIRY_MS;
  const row = await d1
    .prepare(
      `SELECT COUNT(*) AS n
         FROM chat_session
        WHERE user_id = ? AND last_active_at >= ?`,
    )
    .bind(userId, cutoff)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function insertSession(
  d1: D1Database,
  userId: string,
  sessionId: string,
  title: string | null,
  now: number,
): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO chat_session (id, user_id, title, created_at, last_active_at, degraded_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .bind(sessionId, userId, title, now, now)
    .run();
}

async function updateLastActive(
  d1: D1Database,
  userId: string,
  sessionId: string,
  now: number,
  degradedAt: number | null,
): Promise<void> {
  await d1
    .prepare(
      `UPDATE chat_session SET last_active_at = ?, degraded_at = ? WHERE id = ? AND user_id = ?`,
    )
    .bind(now, degradedAt, sessionId, userId)
    .run();
}

/* ---------- DO 写回 + degraded 判定 ---------- */

async function safeGetMessages(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<MultiturnMessage[]> {
  if (!env.SESSION_DO) return [];
  try {
    return await getSessionMessages(
      env as unknown as SessionDOEnv,
      userId,
      sessionId,
    );
  } catch {
    // DO 路由失败 → 降级到无历史（spec §4.4 单轮模式）
    return [];
  }
}

async function persistSession(
  env: Env,
  userId: string,
  sessionId: string,
  isNewSession: boolean,
  sessionTitle: string | null,
  q: string,
  askResult: { answer: string },
): Promise<boolean> {
  const now = Date.now();
  let degraded = false;

  // 6.1 INSERT / UPDATE D1
  if (isNewSession) {
    await insertSession(env.DB, userId, sessionId, sessionTitle, now);
  } else {
    await updateLastActive(env.DB, userId, sessionId, now, null);
  }

  // 6.2 写 DO（user + assistant）
  if (env.SESSION_DO) {
    try {
      const doEnv = env as unknown as SessionDOEnv;
      await appendMessage(doEnv, userId, sessionId, { role: "user", content: q });
      await appendMessage(doEnv, userId, sessionId, {
        role: "assistant",
        content: askResult.answer,
        summary: askResult.answer.slice(0, 50),
      });
    } catch {
      // DO 写失败 → 标 degraded（spec §5.4）
      degraded = true;
      try {
        await updateLastActive(env.DB, userId, sessionId, now, now);
      } catch {
        /* D1 也失败就静默 — 不阻塞返回 */
      }
    }
  } else {
    // SESSION_DO binding 缺 → degraded 路径
    degraded = true;
    try {
      await updateLastActive(env.DB, userId, sessionId, now, now);
    } catch {
      /* 静默 */
    }
  }

  return degraded;
}
