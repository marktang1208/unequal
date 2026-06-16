/**
 * api-chat handler（CP-6 Phase 2 stub → Phase 5 完整实现）
 * POST /api-chat
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
  // TODO Phase 5: chat_session 查/建 + 历史 + retrieval + MiniMax chat
  return errorResponse("NOT_IMPLEMENTED", "api-chat stub (CP-6 Phase 2)", 501);
}