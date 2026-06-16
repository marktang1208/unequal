import { ulid } from "ulid";
import type { D1Database } from "@cloudflare/workers-types";
import { encryptEnvelope, decryptEnvelope } from "./envelope.js";

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
 * M6.7 改：写 envelope 密文（session_key_ct + session_key_dek）；旧 session_key 列置 NULL。
 * 写失败不阻断（auth.ts try/catch 兜底）。
 *
 * 错误：
 * - sessionKey 空字符串 → skip（微信偶尔返空，不写）
 * - KEK_SECRET 缺失 → throw "KEK_SECRET not configured"（auth.ts 透传，不阻断）
 * - encrypt / D1 错误 → 透传
 */
export async function updateUserSessionKey(
  d1: D1Database,
  userId: string,
  sessionKey: string,
  env: { KEK_SECRET?: string },
): Promise<void> {
  if (!sessionKey) return;
  const { ciphertext, wrappedDek } = await encryptEnvelope(sessionKey, env);
  await d1
    .prepare(
      `UPDATE user SET session_key_ct = ?, session_key_dek = ?, session_key = NULL
       WHERE id = ?`,
    )
    .bind(ciphertext, wrappedDek, userId)
    .run();
}

/**
 * M6.7 读 session_key（透明兼容明文，spec §6.2）。
 *
 * 新 user：解 envelope 返 plaintext。
 * 老 user（session_key_ct=NULL）：fallback 旧明文 row.session_key（M6.3b 写入）。
 * 失败：try/catch 兜底返 null + console.warn（admin 排查看到 null 即"明文或损坏"）。
 *
 * 当前 0 调用方（M6.3b 写而未读）；未来 /auth/wx-user-info 解密用。
 */
export async function readUserSessionKey(
  d1: D1Database,
  userId: string,
  env: { KEK_SECRET?: string },
): Promise<string | null> {
  const row = await d1
    .prepare(
      `SELECT session_key_ct, session_key_dek, session_key
       FROM user WHERE id = ?`,
    )
    .bind(userId)
    .first<{
      session_key_ct: string | null;
      session_key_dek: string | null;
      session_key: string | null;
    }>();
  if (!row) return null;

  // 新 user：解 envelope
  if (row.session_key_ct && row.session_key_dek) {
    try {
      return await decryptEnvelope(row.session_key_ct, row.session_key_dek, env);
    } catch (err) {
      console.warn(
        `[envelope] readUserSessionKey decrypt failed for user ${userId}:`,
        err,
      );
      return null;
    }
  }

  // 老 user：fallback 明文（M6.3b 写入的；M6.7 上线前 user）
  return row.session_key;
}
