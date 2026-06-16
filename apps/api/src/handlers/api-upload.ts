/**
 * api-upload handler（CP-6 Phase 2 stub → Phase 4 完整实现）
 * POST /api-upload
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
  // TODO Phase 4: multipart parse + chunking + MiniMax embedding + DB writes
  return errorResponse("NOT_IMPLEMENTED", "api-upload stub (CP-6 Phase 2)", 501);
}