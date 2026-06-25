/**
 * api-nli-result.ts — P9 NLI 异步 verdict 轮询端点
 *
 * GET /api-nli-result?turnId=<id>
 *  查 audit_log 找 nliSnapshot.turnId = turnId
 *  命中: 返 { verdict, score, latencyMs, isWarning, found: true }
 *  未命中: 返 { found: false } (让 client 继续轮询)
 *
 * 决策:
 *  - JWT auth 必填, 仅 user scope (admin scope → 401, polling 是 user-only 功能)
 *  - 不返 audit_log 整 record, 只返 nliSnapshot 字段 (防 leak)
 *  - 400 INVALID_REQUEST 仅当 turnId 格式非法
 *  - 未命中返 200 + {found: false} (让 client 继续轮询, 不 404)
 */

import {
  errorResponse,
  jsonResponse,
  optionsResponse,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
  getQuery,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";
import { verifyJwt } from "../lib/jwt.js";
import { whereQuery, COLLECTIONS } from "../lib/db.js";

interface NliSnapshot {
  turnId?: string;
  verdict?: "entailed" | "neutral" | "contradiction";
  score?: number;
  latencyMs?: number;
  reason?: string;
}

interface AuditLogRecord {
  _id: string;
  action?: string;
  nliSnapshot?: NliSnapshot;
}

interface NliResultResponse {
  found: boolean;
  verdict?: "entailed" | "neutral" | "contradiction";
  score?: number;
  latencyMs?: number;
  isWarning?: boolean;
}

/** turnId 格式: `${session_id}:${turn_seq}`, session_id 大写字母数字 8-16, turn_seq 1-4 位数字 */
const TURN_ID_PATTERN = /^[A-Z0-9]{8,16}:[0-9]{1,4}$/;

/** P5 v1.3 阈值: verdict !== entailed && score < 0.5 触发 warning */
const WARNING_SCORE_THRESHOLD = 0.5;

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  // JWT auth (user scope only; admin scope → 401)
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return errorResponse("AUTH_FAILED", "Missing Authorization header", 401);
  }
  let payload;
  try {
    payload = await verifyJwt({ token, secret: env.JWT_SECRET });
  } catch {
    return errorResponse("AUTH_FAILED", "Invalid JWT", 401);
  }
  if (payload.scope !== "user") {
    return errorResponse("AUTH_FAILED", "Invalid scope (user required)", 401);
  }

  // 解析 turnId from query string
  const turnId = getQuery(event, "turnId") ?? "";
  if (!TURN_ID_PATTERN.test(turnId)) {
    return errorResponse("INVALID_REQUEST", "Invalid turnId format", 400);
  }

  // 查 audit_log (P5 v1.3 audit_log schema, nliSnapshot.turnId 字段在 P9 加)
  const records = await whereQuery<AuditLogRecord>(
    COLLECTIONS.auditLog,
    { action: "chat_nli_async" },
    { limit: 50 },
  );
  const hit = records.find((r) => r.nliSnapshot?.turnId === turnId);

  if (!hit || !hit.nliSnapshot) {
    return jsonResponse({ found: false });
  }

  const { verdict, score, latencyMs } = hit.nliSnapshot;
  const isWarning =
    (verdict === "contradiction" || verdict === "neutral") &&
    (score ?? 1) < WARNING_SCORE_THRESHOLD;

  return jsonResponse({
    found: true,
    verdict,
    score,
    latencyMs,
    isWarning,
  });
}