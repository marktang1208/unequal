/**
 * M6.2 + M6.3a /auth 路由（spec §3.3 + §3.4 + M6.3a §5.1/§5.2）。
 *
 * 2 endpoint：
 * - POST /auth/wx-login    { code } → 调 jscode2session → findOrCreateUser → signJwt
 *   M6.3a：jscode2session 抛 INVALID_CODE 时记 failed attempt（identifier=sha256(code).slice(0,16), type='wx_code'）
 * - POST /auth/admin-login { admin_token } → 验 env.ADMIN_TOKEN → signJwt (userId=DEFAULT_ADMIN_USER_ID, isAdmin=true)
 *   M6.3a：verifyAdminToken 之前做 rate limit pre-check；验后 recordAttempt（无论成功失败）
 *
 * HttpError 走 try/catch 统一映射 status+code（与 chat.ts / sessions.ts 同模式）。
 * 429 显式 return Response.json（带 retry_after 字段），不走 throw HttpError。
 * jscode2session 走 env.fetchImpl 注入（M6.2 测试依赖）；生产路径不传，自动用全局 fetch。
 */
import {
  verifyAdminToken,
  DEFAULT_ADMIN_USER_ID,
  HttpError,
} from "../lib/auth.js";
import { signJwt } from "../lib/auth-jwt.js";
import { jscode2session } from "../lib/wx.js";
import { findOrCreateUser, updateUserSessionKey } from "../lib/user.js";
import {
  checkRateLimitDual,
  recordAttempt,
  sha256Identifier,
  sha256ClientIp,
  getClientIp,
  readRateLimitConfig,
} from "../lib/rate-limit.js";
import { withTokenMutex } from "../lib/token-mutex.js";
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

      // M6.3a wx rate limit pre-check（spec §5.2 + plan §4 Task 4）：
      // identifier = sha256(code).slice(0, 16)，type='wx_code'
      // 微信 code 5min TTL，hash 撞概率 2^-64 可忽略；同 code 重试 5 次后拦截
      //
      // M6.6：加 per-IP 维度（双层独立）。clientIpHash = sha256(CF-Connecting-IP).slice(0, 16)
      // 任一维度锁即整体锁（attacker 换 wrong-code N 次绕过 5/15min 的攻击面被封堵）
      const codeIdentifier = await sha256Identifier(code);
      const clientIpHash = await sha256ClientIp(getClientIp(request));
      const rateCheck = await checkRateLimitDual(
        env.DB, codeIdentifier, clientIpHash, "wx_code", Date.now(), readRateLimitConfig(env),
      );
      if (rateCheck.locked) {
        return Response.json(
          {
            error: "RATE_LIMITED",
            message: "Too many failed wx login attempts. Try again later.",
            retry_after: rateCheck.retry_after,
          },
          { status: 429 },
        );
      }

      // 调 jscode2session（spec §3.5），fetchImpl 走 env 注入
      let wxRes: { openid: string; session_key: string; unionid?: string };
      try {
        wxRes = await jscode2session({
          code,
          appId: env.WX_APP_ID ?? "",
          appSecret: env.WX_APP_SECRET ?? "",
          ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}),
        });
      } catch (err) {
        // M6.3a：jscode2session 抛 INVALID_CODE 时记 failed attempt
        // 其它错误（502 WX_API_ERROR / 500 INFRA_MISSING）不计（避免把网络问题当刷攻击）
        // M6.9: 防御性 — 同 code 5 并发 wx-login 小窗口串行化
        await withTokenMutex(codeIdentifier, async () => {
          if (err instanceof HttpError && err.code === "INVALID_CODE") {
            await recordAttempt(env.DB, codeIdentifier, "wx_code", false, clientIpHash);
          }
        });
        throw err;
      }

      // upsert user
      const { user, isNew } = await findOrCreateUser(env.DB, wxRes.openid);

      // M6.3b 写 session_key；M6.7 改 envelope 密文（KEK 来自 env.KEK_SECRET）
      // 写失败不阻断登录；让 jwt 仍签发
      try {
        // env 是 Env 类型（含 D1Database 等），envelope 函数只需 KEK_* 字段；cast 安全
        await updateUserSessionKey(env.DB, user.id, wxRes.session_key, env as unknown as Parameters<typeof updateUserSessionKey>[3]);
      } catch {
        // session_key 写失败不阻断 jwt 签发；未来解密不可用但当前 /auth/wx-login 仍成功
      }

      // 签 JWT
      const token = await signJwt(
        { userId: user.id, isAdmin: false },
        env.JWT_SECRET ?? "",
      );

      // M6.3a：成功路径不记 attempt（spec §5.2 — 避免 race condition 设计）

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
      // M6.3a rate limit pre-check（spec §5.1）：在 verifyAdminToken 之前拦截
      // identifier = sha256(admin_token).hex().slice(0, 16)
      //
      // M6.6：加 per-IP 维度（双层独立）。attacker 换 wrong-token N 次绕过 5/15min 的攻击面被封堵
      const adminIdentifier = await sha256Identifier(adminToken);
      const clientIpHash = await sha256ClientIp(getClientIp(request));
      const rateCheck = await checkRateLimitDual(
        env.DB, adminIdentifier, clientIpHash, "admin", Date.now(), readRateLimitConfig(env),
      );
      if (rateCheck.locked) {
        // 显式 return（带 retry_after），不走 throw HttpError
        return Response.json(
          {
            error: "RATE_LIMITED",
            message: "Too many failed admin login attempts. Try again later.",
            retry_after: rateCheck.retry_after,
          },
          { status: 429 },
        );
      }
      const auth = verifyAdminToken(
        `Bearer ${adminToken}`,
        env.ADMIN_TOKEN,
      );
      // M6.3a：无论成功失败都记 attempt（spec §5.1 step 4）
      // M6.9: 防御性 — 同 admin_token 5 并发小窗口串行化
      if (!auth.ok) {
        await withTokenMutex(adminIdentifier, async () => {
          await recordAttempt(env.DB, adminIdentifier, "admin", false, clientIpHash);
        });
        throw new HttpError(401, "INVALID_ADMIN_TOKEN", auth.message);
      }
      const token = await signJwt(
        { userId: DEFAULT_ADMIN_USER_ID, isAdmin: true },
        env.JWT_SECRET ?? "",
      );
      await withTokenMutex(adminIdentifier, async () => {
        await recordAttempt(env.DB, adminIdentifier, "admin", true, clientIpHash);
      });
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
