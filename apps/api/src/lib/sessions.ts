/**
 * M6.1 /sessions CRUD lib（spec §3.3 / §4.2）。
 *
 * D1 chat_session 表维护：
 * - listSessions: 按 last_active_at DESC，limit 50
 * - renameSession: UPDATE title
 * - deleteSession: UPDATE degraded_at = now（不真删，M6.2 回收站）
 * - getSession: SELECT 单个（userId 隔离检查）
 *
 * 全部走 userId 隔离 — 别人的 session 返 null（不抛错，让 caller 决定 404 vs 403）
 */
import type { D1Database } from "@cloudflare/workers-types";
import { HttpError } from "./auth.js";

export interface ChatSessionRow {
  id: string;
  user_id: string;
  title: string | null;
  created_at: number;
  last_active_at: number;
  degraded_at: number | null;
}

const MAX_LIST_LIMIT = 50;

async function loadRow(
  d1: D1Database,
  userId: string,
  sessionId: string,
): Promise<ChatSessionRow | null> {
  const row = await d1
    .prepare(
      `SELECT id, user_id, title, created_at, last_active_at, degraded_at
         FROM chat_session
        WHERE id = ? AND user_id = ?`,
    )
    .bind(sessionId, userId)
    .first<ChatSessionRow>();
  return row ?? null;
}

export async function listSessions(
  d1: D1Database,
  userId: string,
  limit: number = MAX_LIST_LIMIT,
): Promise<ChatSessionRow[]> {
  const safeLimit = Math.max(1, Math.min(limit, MAX_LIST_LIMIT));
  const result = await d1
    .prepare(
      `SELECT id, user_id, title, created_at, last_active_at, degraded_at
         FROM chat_session
        WHERE user_id = ?
        ORDER BY last_active_at DESC
        LIMIT ?`,
    )
    .bind(userId, safeLimit)
    .all<ChatSessionRow>();
  return (result.results ?? []) as ChatSessionRow[];
}

export async function getSession(
  d1: D1Database,
  userId: string,
  sessionId: string,
): Promise<ChatSessionRow | null> {
  return loadRow(d1, userId, sessionId);
}

export async function renameSession(
  d1: D1Database,
  userId: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new HttpError(400, "MISSING_TITLE", "title must be a non-empty string");
  }
  if (trimmed.length > 100) {
    throw new HttpError(400, "TITLE_TOO_LONG", "title must be <= 100 chars");
  }
  const existing = await loadRow(d1, userId, sessionId);
  if (!existing) {
    throw new HttpError(404, "CHAT_SESSION_NOT_FOUND", `Session ${sessionId} not found`);
  }
  await d1
    .prepare(`UPDATE chat_session SET title = ? WHERE id = ? AND user_id = ?`)
    .bind(trimmed, sessionId, userId)
    .run();
}

export async function deleteSession(
  d1: D1Database,
  userId: string,
  sessionId: string,
): Promise<void> {
  const existing = await loadRow(d1, userId, sessionId);
  if (!existing) {
    throw new HttpError(404, "CHAT_SESSION_NOT_FOUND", `Session ${sessionId} not found`);
  }
  // M6.1: 不真删，标 degraded_at = now（M6.2 加回收站 + cron 清理）
  const now = Date.now();
  await d1
    .prepare(
      `UPDATE chat_session SET degraded_at = ?, last_active_at = ? WHERE id = ? AND user_id = ?`,
    )
    .bind(now, now, sessionId, userId)
    .run();
}
