/**
 * CP-6: Admin 鉴权 helper（共享给所有 admin 路由）
 *
 * 强制两层防御（spec §10.3 D-4）：
 * 1. Authorization: Bearer $ADMIN_TOKEN OR admin JWT (scope=admin)
 * 2. ADMIN_IP_ALLOWLIST 强制拒绝（不在白名单 → 403）
 *
 * 注意：IP 白名单空 = 行为不变（向后兼容 dev）；spec §5.3.
 */

import { errorResponse, getClientIp, type HttpTriggerEvent, type HttpTriggerResponse } from "./handler-utils.js";
import { verifyJwt } from "./jwt.js";
import {
  isAdminIpAllowed,
  parseAdminIpAllowlist,
} from "./admin-ip-allowlist.js";
import type { AppEnv } from "./env.js";

export type AdminCheckResult =
  | { ok: true; scope: "admin"; via: "admin_token" | "admin_jwt" }
  | { ok: false; response: HttpTriggerResponse };

export async function requireAdmin(
  event: HttpTriggerEvent,
  env: AppEnv,
): Promise<AdminCheckResult> {
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return {
      ok: false,
      response: errorResponse("AUTH_FAILED", "Missing Authorization header", 401),
    };
  }

  // 1. token check
  let scope: "admin" | "user" | null = null;
  let via: "admin_token" | "admin_jwt" = "admin_token";

  if (token === env.ADMIN_TOKEN) {
    scope = "admin";
  } else {
    try {
      const payload = await verifyJwt({ token, secret: env.JWT_SECRET });
      if (payload.scope === "admin") {
        scope = "admin";
        via = "admin_jwt";
      }
    } catch {
      // fall through
    }
  }

  if (scope !== "admin") {
    return {
      ok: false,
      response: errorResponse("AUTH_FAILED", "Not admin", 401),
    };
  }

  // 2. IP allowlist 强制（spec §10.3 D-4 关闭项）
  const clientIp = getClientIp(event);
  const allowlist = parseAdminIpAllowlist({ ADMIN_IP_ALLOWLIST: env.ADMIN_IP_ALLOWLIST });
  const isAdminIp = isAdminIpAllowed(clientIp, allowlist);

  if (allowlist.length > 0 && !isAdminIp) {
    return {
      ok: false,
      response: errorResponse(
        "IP_NOT_ALLOWED",
        `clientIp=${clientIp} not in ADMIN_IP_ALLOWLIST`,
        403,
      ),
    };
  }

  return { ok: true, scope: "admin", via };
}