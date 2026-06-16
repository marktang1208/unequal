import { ulid } from "ulid";
import type { D1Database } from "@cloudflare/workers-types";

export interface UserRow {
  id: string;
  wx_openid: string | null;
  nickname: string | null;
  created_at: number;
}

export interface FindOrCreateResult {
  user: UserRow;
  isNew: boolean;
}

/**
 * M6.2 鉴权后落库（M6.2 spec §3.6）。
 *
 * 流程：
 * 1. SELECT user WHERE wx_openid = ? — 找到返 user + isNew=false
 * 2. 没找到 → INSERT user (id=ulid, wx_openid, nickname=NULL, created_at=now) → 返 isNew=true
 *
 * 0 migration 改动：M0-M1 0001_init.sql 已留 wx_openid TEXT UNIQUE + nickname TEXT 字段。
 * wx_openid UNIQUE 保证并发下不会出现两个 user 同一 openid（DB 层兜底）。
 *
 * 错误：
 * - openid 为空串：直接抛 Error（守门，不查 DB）
 * - DB 错误：透传（D1 抛啥抛啥，不吞）
 */
export async function findOrCreateUser(
  d1: D1Database,
  openid: string,
): Promise<FindOrCreateResult> {
  if (!openid) {
    throw new Error("openid must be non-empty");
  }
  const existing = await d1
    .prepare(`SELECT id, wx_openid, nickname, created_at FROM user WHERE wx_openid = ?`)
    .bind(openid)
    .first<UserRow>();
  if (existing) {
    return { user: existing, isNew: false };
  }
  // INSERT 新 user
  const id = ulid();
  const now = Date.now();
  await d1
    .prepare(
      `INSERT INTO user (id, wx_openid, nickname, created_at) VALUES (?, ?, NULL, ?)`,
    )
    .bind(id, openid, now)
    .run();
  return {
    user: { id, wx_openid: openid, nickname: null, created_at: now },
    isNew: true,
  };
}

/**
 * M6.3b 写 session_key（spec §1/§5/§6）。
 *
 * 每次 /auth/wx-login 成功后写入 session_key（推 /auth/wx-user-info 解密用）。
 * 每次重写，不带时间戳（每次都拿最新 session_key；30 天 TTL 足够覆盖所有解密场景）。
 *
 * 错误：
 * - sessionKey 空字符串 → skip（微信偶尔返空，不写）
 * - D1 错误 → 透传，路由层决定是否阻断登录
 */
export async function updateUserSessionKey(
  d1: D1Database,
  userId: string,
  sessionKey: string,
): Promise<void> {
  if (!sessionKey) return;
  await d1
    .prepare(`UPDATE user SET session_key = ? WHERE id = ?`)
    .bind(sessionKey, userId)
    .run();
}
