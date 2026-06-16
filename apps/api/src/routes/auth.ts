/**
 * M6.2 /auth 路由（spec §3.3 + §3.4）。
 *
 * 2 endpoint：
 * - POST /auth/wx-login    { code } → 调 jscode2session → findOrCreateUser → signJwt
 * - POST /auth/admin-login { admin_token } → 验 env.ADMIN_TOKEN → signJwt (userId=DEFAULT_ADMIN_USER_ID, isAdmin=true)
 *
 * HttpError 走 try/catch 统一映射 status+code（与 chat.ts / sessions.ts 同模式）。
 * jscode2session 走 env.fetchImpl 注入（M6.2 测试依赖）；生产路径不传，自动用全局 fetch。
 */
import {
  verifyAdminToken,
  DEFAULT_ADMIN_USER_ID,
  HttpError,
} from "../lib/auth.js";
import { signJwt } from "../lib/auth-jwt.js";
import { jscode2session } from "../lib/wx.js";
import { findOrCreateUser } from "../lib/user.js";
import type { Env } from "../types.js";

const JWT_TTL_SECONDS = 24 * 60 * 60;

interface WxLoginRequestBody {
  code?: unknown;
}

interface AdminLoginRequestBody {
  admin_token?: unknown;
}

export interface WxLoginResponse {
  token: string;
  user_id: string;
  is_new_user: boolean;
  expires_in: number;
}

export interface AdminLoginResponse {
  token: string;
  user_id: string;
  is_admin: boolean;
  expires_in: number;
}

function handleHttpError(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json(
      { error: err.code, message: err.message },
      { status: err.status },
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return Response.json({ error: "internal", detail: msg }, { status: 500 });
}

export const authRoute = {
  async WX_LOGIN(request: Request, env: Env): Promise<Response> {
    try {
      let body: WxLoginRequestBody;
      try {
        body = (await request.json()) as WxLoginRequestBody;
      } catch {
        return Response.json(
          { error: "INVALID_JSON", message: "Body must be JSON" },
          { status: 400 },
        );
      }
      const code = typeof body.code === "string" ? body.code.trim() : "";
      if (!code) {
        return Response.json(
          { error: "MISSING_CODE", message: "Missing or empty 'code' field" },
          { status: 400 },
        );
      }

      // 调 jscode2session（spec §3.5），fetchImpl 走 env 注入
      const wxRes = await jscode2session({
        code,
        appId: env.WX_APP_ID ?? "",
        appSecret: env.WX_APP_SECRET ?? "",
        ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}),
      });

      // upsert user
      const { user, isNew } = await findOrCreateUser(env.DB, wxRes.openid);

      // 签 JWT
      const token = await signJwt(
        { userId: user.id, isAdmin: false },
        env.JWT_SECRET ?? "",
      );

      const response: WxLoginResponse = {
        token,
        user_id: user.id,
        is_new_user: isNew,
        expires_in: JWT_TTL_SECONDS,
      };
      return Response.json(response);
    } catch (err) {
      return handleHttpError(err);
    }
  },

  async ADMIN_LOGIN(request: Request, env: Env): Promise<Response> {
    try {
      let body: AdminLoginRequestBody;
      try {
        body = (await request.json()) as AdminLoginRequestBody;
      } catch {
        return Response.json(
          { error: "INVALID_JSON", message: "Body must be JSON" },
          { status: 400 },
        );
      }
      const adminToken =
        typeof body.admin_token === "string" ? body.admin_token : "";
      if (!adminToken) {
        return Response.json(
          { error: "MISSING_TOKEN", message: "Missing or empty 'admin_token' field" },
          { status: 400 },
        );
      }
      const auth = verifyAdminToken(
        `Bearer ${adminToken}`,
        env.ADMIN_TOKEN,
      );
      if (!auth.ok) {
        throw new HttpError(401, "INVALID_ADMIN_TOKEN", auth.message);
      }
      const token = await signJwt(
        { userId: DEFAULT_ADMIN_USER_ID, isAdmin: true },
        env.JWT_SECRET ?? "",
      );
      const response: AdminLoginResponse = {
        token,
        user_id: DEFAULT_ADMIN_USER_ID,
        is_admin: true,
        expires_in: JWT_TTL_SECONDS,
      };
      return Response.json(response);
    } catch (err) {
      return handleHttpError(err);
    }
  },
};
