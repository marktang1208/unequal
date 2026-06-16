/**
 * api-auth-admin-login handler（CP-6 Phase 3 完整实现）
 * POST /api-auth-admin-login { token: "..." }
 *
 * 流程：
 * 1. 解析 body
 * 2. admin IP 白名单 check（白名单 IP 跳过 rate-limit；spec §5.3）
 * 3. verify token == ADMIN_TOKEN
 * 4. sign JWT (admin scope, sub = "admin")
 * 5. 返 { jwt }
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

export interface AdminLoginRequest {
  token: string;
}

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  // 1. parse body
  const body = parseJsonBody<AdminLoginRequest>(event);
  if (!body?.token || typeof body.token !== "string") {
    return errorResponse("INVALID_REQUEST", "Missing or invalid 'token' field", 400);
  }

  // 2. IP allowlist check（spec §5.3；目前仅记日志，rate-limit 留 v2）
  const clientIp = getClientIp(event);
  const allowlist = parseAdminIpAllowlist({ ADMIN_IP_ALLOWLIST: env.ADMIN_IP_ALLOWLIST });
  const isAdminIp = isAdminIpAllowed(clientIp, allowlist);
  if (!isAdminIp && allowlist.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[admin-login] clientIp=${clientIp} not in allowlist`);
    // 当前不强制拒绝（仅警告）；spec §10.3 D-4 验证后由 admin_token 本身做二次防御
  }

  // 3. verify token
  if (body.token !== env.ADMIN_TOKEN) {
    return errorResponse("AUTH_FAILED", "Invalid admin token", 401);
  }

  // 4. sign JWT（sub 用 DEFAULT_USER_ID，因单用户场景；admin scope 标识管理员）
  const jwt = await signJwt({
    userId: env.DEFAULT_USER_ID,
    scope: "admin",
    secret: env.JWT_SECRET,
  });

  // 5. 返 { jwt }
  return jsonResponse({ jwt });
}