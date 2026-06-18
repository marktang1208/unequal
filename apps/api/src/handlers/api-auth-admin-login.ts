/**
 * api-auth-admin-login handler（CP-6 Phase 3 完整实现）
 * POST /api-auth-admin-login { token: "..." }
 *
 * 流程：
 * 1. 解析 body
 * 2. admin IP 白名单 check（白名单 IP 跳过 rate-limit；spec §5.3）
 * 3. verify token == ADMIN_TOKEN
 * 4. sign JWT (admin scope, sub = "admin")
 * 5. 写 login_attempt collection (成功 + 失败都记, spec §3.3)
 * 6. 返 { jwt }
 */
import {
  errorResponse,
  getClientIp,
  jsonResponse,
  optionsResponse,
  parseJsonBody,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";
import {
  isAdminIpAllowed,
  parseAdminIpAllowlist,
} from "../lib/admin-ip-allowlist.js";
import { signJwt } from "../lib/jwt.js";
import { createHash } from "node:crypto";
import { add, COLLECTIONS } from "../lib/db.js";
import type { LoginAttempt } from "@unequal/shared/types";

export interface AdminLoginRequest {
  token: string;
}

/** SHA-256 hex digest of clientIp with JWT_SECRET as salt (spec §3.3 clientIpHash). */
function hashClientIp(clientIp: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${clientIp}`).digest("hex");
}

async function recordLoginAttempt(
  clientIp: string,
  env: ReturnType<typeof getEnv>,
  success: boolean,
): Promise<void> {
  try {
    await add<Omit<LoginAttempt, "id">>(COLLECTIONS.loginAttempt, {
      identifier: "admin",
      clientIpHash: hashClientIp(clientIp, env.JWT_SECRET),
      success,
      createdAt: Date.now(),
    });
  } catch {
    // login_attempt 写入失败不影响 login 主流程
  }
}

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  // 1. parse body
  const body = parseJsonBody<AdminLoginRequest>(event);
  if (!body?.token || typeof body.token !== "string") {
    return errorResponse("INVALID_REQUEST", "Missing or invalid 'token' field", 400);
  }

  // 2. IP allowlist check（spec §5.3；白名单非空时强制拒绝）
  const clientIp = getClientIp(event);
  const allowlist = parseAdminIpAllowlist({ ADMIN_IP_ALLOWLIST: env.ADMIN_IP_ALLOWLIST });
  const isAdminIp = isAdminIpAllowed(clientIp, allowlist);
  if (allowlist.length > 0 && !isAdminIp) {
    await recordLoginAttempt(clientIp, env, false);
    return errorResponse(
      "IP_NOT_ALLOWED",
      `clientIp=${clientIp} not in ADMIN_IP_ALLOWLIST`,
      403,
    );
  }

  // 3. verify token
  if (body.token !== env.ADMIN_TOKEN) {
    await recordLoginAttempt(clientIp, env, false);
    return errorResponse("AUTH_FAILED", "Invalid admin token", 401);
  }

  // 4. sign JWT（sub 用 DEFAULT_USER_ID，因单用户场景；admin scope 标识管理员）
  const jwt = await signJwt({
    userId: env.DEFAULT_USER_ID,
    scope: "admin",
    secret: env.JWT_SECRET,
  });

  // 5. 记录成功登录
  await recordLoginAttempt(clientIp, env, true);

  // 6. 返 { jwt }
  return jsonResponse({ jwt });
}
