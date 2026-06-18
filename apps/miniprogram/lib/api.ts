/**
 * CP-7-A 7 caller typed wrapper（spec §6.1 / plan Task 2）。
 *
 * 每个 caller 是 cloudCall<T> 的 thin wrapper：路径 + body + jwt 透明传
 * 给 cloudCall；返回值直接 typed（caller 不解析 statusCode）。
 *
 * 路径全部沿用现有约定（CP-6 P3.9 + 旧路径兼容）：
 * - /api-ask / /api-chat / /api-sessions-list / /api-sessions-delete/:id
 * - /sessions/:id (renameSession — CP-6 后端暂无 handler；CP-7-B 范围)
 * - /user/nickname (updateNickname — 同上)
 * - /auth/admin-login (adminLogin — 无 jwt 依赖)
 *
 * 死代码清理（M6.3a / M6.4 时代的 wx HTTP 路径）：
 * - 所有 caller 不再走 wx.request / fetchWithRefresh；统一 cloudCall
 * - refresh 401 内作于 cloudCall（spec §D-3）
 */

import type {
  AskResponse,
  ChatRequest,
  ChatResponse,
  SessionsListResponse,
} from "./types.js";
import { cloudCall } from "./cloud-call.js";
import { getJwtToken } from "./auth.js";

/* ---------- CP-7-A admin login (无 jwt 依赖) ---------- */

interface AdminLoginResponse {
  token: string;
  user_id: string;
  is_admin: boolean;
  expires_in: number;
}

/** POST /auth/admin-login → 返 admin jwt。Caller 自己 saveJwt() */
export async function adminLogin(adminToken: string): Promise<AdminLoginResponse> {
  return cloudCall<AdminLoginResponse>({
    path: "/api-auth-admin-login",
    httpMethod: "POST",
    body: { admin_token: adminToken },
  });
}

/* ---------- CP-7-A 单轮问答 (admin 用；user 用 chat 多轮) ---------- */

export async function ask(q: string): Promise<AskResponse> {
  return cloudCall<AskResponse>({
    path: "/api-ask",
    httpMethod: "POST",
    body: { q },
    jwt: getJwtToken() ?? undefined,
  });
}

/* ---------- M6.1 多轮会话 + session CRUD ---------- */

/**
 * /api-chat 多轮问答。sessionId 缺 → 服务端新建；sessionId 有 → 复用。
 * 失败降级：throw ApiError 让 caller 决定 retry / 跳登录。
 */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
  return cloudCall<ChatResponse>({
    path: "/api-chat",
    httpMethod: "POST",
    body: {
      q: req.q,
      ...(req.session_id ? { session_id: req.session_id } : {}),
    },
    jwt: getJwtToken() ?? undefined,
  });
}

/** GET /api-sessions-list → 返 server-side session 列表（最近 50） */
export async function listSessions(): Promise<SessionsListResponse> {
  return cloudCall<SessionsListResponse>({
    path: "/api-sessions-list",
    httpMethod: "GET",
    jwt: getJwtToken() ?? undefined,
  });
}

/** PATCH /api-sessions-rename?id={id} body={title} → 改 title（CP-7-B handler 已 work） */
export async function renameSession(sessionId: string, title: string): Promise<void> {
  await cloudCall({
    path: "/api-sessions-rename",
    httpMethod: "PATCH",
    query: { id: sessionId },
    body: { title },
    jwt: getJwtToken() ?? undefined,
  });
}

/** DELETE /api-sessions-delete?id={id} → 服务端软删（标 degraded_at）
 *  CP-7-B 修复：原 path param `/api-sessions-delete/${id}` 风格与 handler `getQuery` 不一致 → 真接 400 */
export async function deleteSession(sessionId: string): Promise<void> {
  await cloudCall({
    path: "/api-sessions-delete",
    httpMethod: "DELETE",
    query: { id: sessionId },
    jwt: getJwtToken() ?? undefined,
  });
}

/* ---------- M6.3c nickname (CP-7-B: PATCH /api-user-nickname) ---------- */

/**
 * PATCH /api-user-nickname body={nickname} → 写 miniprogram 用户的 nickname。
 * CP-7-B handler 已 work。
 */
export async function updateNickname(nickname: string): Promise<void> {
  await cloudCall({
    path: "/api-user-nickname",
    httpMethod: "PATCH",
    body: { nickname },
    jwt: getJwtToken() ?? undefined,
  });
}