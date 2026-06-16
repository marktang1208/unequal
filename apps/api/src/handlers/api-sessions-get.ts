/**
 * api-sessions-get handler（CP-6 Phase 2 stub → Phase 3 完整实现）
 * GET /api-sessions-get?id=...
 */
import {
  errorResponse,
  optionsResponse,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);
  // TODO Phase 3: JWT auth + chatSession.doc(id).get() + userId 校验
  return errorResponse("NOT_IMPLEMENTED", "api-sessions-get stub (CP-6 Phase 2)", 501);
}