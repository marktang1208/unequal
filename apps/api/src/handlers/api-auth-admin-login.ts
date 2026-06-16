/**
 * api-auth-admin-login handler（CP-6 Phase 2 stub → Phase 3 完整实现）
 * POST /api-auth-admin-login { token: "..." }
 */
import {
  errorResponse,
  optionsResponse,
  parseJsonBody,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);
  // TODO Phase 3: verifyAdminToken + admin-IP-allowlist check + rate-limit + JWT 签发
  return errorResponse("NOT_IMPLEMENTED", "api-auth-admin-login stub (CP-6 Phase 2)", 501);
  void parseJsonBody;
}