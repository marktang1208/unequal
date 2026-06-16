/**
 * CP-6: HTTP trigger 入口
 *
 * 单一函数入口按 event.path 分发到 13 个 handler。
 * CloudBase 推荐每个函数独立部署，本文件作为：
 * - 启动时硬验证入口（validateEmbeddingDim 在模块加载时跑）
 * - 统一分发骨架（Phase 2 填充 13 个 handler）
 *
 * Phase 2+ 部署模式：
 * - 推荐：每个 handler 独立成云函数（13 个独立部署）
 * - 简化：本文件作为单一入口分发（部署 1 个函数）
 *
 * 当前 Phase 1：骨架 + 硬验证，分发返 501。
 */

import { getEnv, validateEmbeddingDim } from "./lib/env.js";
import {
  errorResponse,
  getClientIp,
  jsonResponse,
  optionsResponse,
  parseFuncPath,
  type HttpTriggerEvent,
} from "./lib/handler-utils.js";

// 启动时硬验证（模块加载时跑一次，失败 throw → 函数冷启动失败）
const startValidation = async () => {
  try {
    await validateEmbeddingDim();
    // eslint-disable-next-line no-console
    console.log("[startup] embedding dim validated");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[startup] embedding dim validation failed:", err);
    throw err;
  }
};

// 触发启动验证（不 await —— 让函数冷启动时并行）
void startValidation();

export async function main(event: HttpTriggerEvent) {
  const env = getEnv();

  // OPTIONS 预检
  if (event.httpMethod === "OPTIONS") {
    return optionsResponse(env.ALLOWED_ORIGIN);
  }

  // 简单存活检查
  if (event.path === "/health" || event.path === "/api-health") {
    return jsonResponse({ ok: true, environment: env.ENVIRONMENT });
  }

  // 按 func name 分发
  const parsed = parseFuncPath(event.path);
  if (!parsed) {
    return errorResponse("NOT_FOUND", `Unknown path: ${event.path}`, 404);
  }

  // Phase 2+ 填充实际 handler
  return errorResponse(
    "NOT_IMPLEMENTED",
    `Handler ${parsed.func} not yet wired (Phase 1 stub). clientIp=${getClientIp(event)}`,
    501,
  );
}