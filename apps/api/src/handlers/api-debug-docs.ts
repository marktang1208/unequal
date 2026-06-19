/**
 * api-debug-docs handler（CP-7-B round 9 临时调试）
 * GET /api-debug-docs?user_id=xxx
 */

import {
  errorResponse,
  getQuery,
  jsonResponse,
  optionsResponse,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";
import { requireAdmin } from "../lib/auth-admin.js";
import { whereQuery, COLLECTIONS } from "../lib/db.js";
import type { Document } from "@unequal/shared/types";

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  const auth = await requireAdmin(event, env);
  if (!auth.ok) return auth.response;

  const userId = getQuery(event, "user_id");
  if (!userId) return errorResponse("INVALID_REQUEST", "Missing user_id", 400);

  const docs = await whereQuery<Document>(COLLECTIONS.document, { userId }, { limit: 10 });
  const summary = docs.map((d) => ({
    id: d.id,
    _id: d._id,
    title: d.title,
    sourceId: d.sourceId,
    userId: d.userId,
  }));
  return jsonResponse({ total: docs.length, docs: summary });
}
