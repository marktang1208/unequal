/**
 * api-ask handler（CP-6 Phase 2 stub → Phase 5 完整实现）
 * GET/POST /api-ask
 */
import {
  errorResponse,
  jsonResponse,
  optionsResponse,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);
  // TODO Phase 5: MiniMax embedding + retrieval + MiniMax chat + citations
  return errorResponse("NOT_IMPLEMENTED", "api-ask stub (CP-6 Phase 2)", 501);
  void jsonResponse; void event;
}