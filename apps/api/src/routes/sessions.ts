/**
 * M6.1 /sessions 路由（spec §3.3）。
 *
 * 4 个 endpoint：
 * - GET    /sessions        → 返 user 的 session 列表（最近 50，按 last_active_at DESC）
 * - GET    /sessions/:id    → 返单个 session
 * - PATCH  /sessions/:id    → 改 title
 * - DELETE /sessions/:id    → 软删（标 degraded_at）
 *
 * 全部走 verifyAuth（统一鉴权入口，M6.1 切 jwt 时只动 verifyAuth）。
 */
import { verifyAuth, HttpError } from "../lib/auth.js";
import { listSessions, getSession, renameSession, deleteSession } from "../lib/sessions.js";
import type { Env } from "../types.js";

interface PatchBody {
  title?: unknown;
}

function handleHttpError(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.code, message: err.message }, { status: err.status });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return Response.json({ error: "internal", detail: msg }, { status: 500 });
}

export const sessionsRoute = {
  async LIST(request: Request, env: Env): Promise<Response> {
    try {
      const identity = await verifyAuth(request, env);
      const rows = await listSessions(env.DB, identity.userId);
      return Response.json({ sessions: rows });
    } catch (err) {
      return handleHttpError(err);
    }
  },

  async GET(request: Request, env: Env, sessionId: string): Promise<Response> {
    try {
      const identity = await verifyAuth(request, env);
      const row = await getSession(env.DB, identity.userId, sessionId);
      if (!row) {
        return Response.json(
          { error: "CHAT_SESSION_NOT_FOUND", message: `Session ${sessionId} not found` },
          { status: 404 },
        );
      }
      return Response.json({ session: row });
    } catch (err) {
      return handleHttpError(err);
    }
  },

  async PATCH(request: Request, env: Env, sessionId: string): Promise<Response> {
    try {
      const identity = await verifyAuth(request, env);
      let body: PatchBody;
      try {
        body = (await request.json()) as PatchBody;
      } catch {
        return Response.json({ error: "INVALID_JSON", message: "Body must be JSON" }, { status: 400 });
      }
      const title = typeof body.title === "string" ? body.title : "";
      await renameSession(env.DB, identity.userId, sessionId, title);
      return Response.json({ ok: true });
    } catch (err) {
      return handleHttpError(err);
    }
  },

  async DELETE(request: Request, env: Env, sessionId: string): Promise<Response> {
    try {
      const identity = await verifyAuth(request, env);
      await deleteSession(env.DB, identity.userId, sessionId);
      return Response.json({ ok: true });
    } catch (err) {
      return handleHttpError(err);
    }
  },
};
