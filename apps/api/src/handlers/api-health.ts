/**
 * api-health handler（CP-6 Phase 2 完成）
 * GET /api-health
 */
import {
  jsonResponse,
  optionsResponse,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);
  return jsonResponse({
    ok: true,
    environment: env.ENVIRONMENT,
    timestamp: Date.now(),
  });
}