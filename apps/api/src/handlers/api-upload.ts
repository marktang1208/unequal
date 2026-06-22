/**
 * api-upload handler — DEPRECATED since CP-7-C T15 (2026-06-22)
 *
 * 历史：CP-6 Phase 4 完整实现（admin auth + 文件解析 + chunk + embed + DB writes）
 * 弃用原因：v2 ingest 架构改为 admin 端解析 → 推 content markdown → API 端自己 chunk + embed
 *         （见 docs/superpowers/state-arch-v2.3.md §2-3）
 *
 * 新路径：POST /api-ingest { content, title, url, trust_level, user_id? }
 *         Content 必须在 admin 端解析（local parser），API 端只 chunk + embed + 写库。
 *         限制：单 content ≤ 5MB（CloudBase HTTP body 上限）。
 *
 * 此 handler 仍注册在 index.ts 的 HANDLER_MAP，访问返 410 GONE 便于客户端区分
 * "路径错"(404) vs "已弃用"(410)。
 *
 * 计划：等 minipgm v2 上传稳定后（预计 2026-Q3）整个 file 删除 + 从 HANDLER_MAP 移除。
 */

import {
  errorResponse,
  optionsResponse,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";

/** DEPRECATED 入口：返 410 GONE + 新路径说明 */
export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  return errorResponse(
    "GONE",
    "api-upload 已弃用（since 2026-06-22）。请改用 POST /api-ingest，body 字段: { content, title, url, trust_level, user_id? }。详见 docs/superpowers/state-arch-v2.3.md §3。",
    410,
  );
}
