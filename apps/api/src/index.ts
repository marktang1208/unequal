/**
 * CP-6: HTTP trigger 统一入口 + 分发
 *
 * 部署模式：单一 CloudBase 函数分发到 13 个 handler（spec §2.4 简化方案）。
 * 推荐：每个 handler 独立部署（spec §2.4 推荐方案）—— 部署期切换到独立入口文件。
 *
 * Phase 2：13 handler 骨架就位；返 501 NOT_IMPLEMENTED
 * Phase 3-7：按 phase 填充
 *
 * 启动时硬验证（spec §7.3）：
 * - validateEmbeddingDim 在模块加载时跑一次（production 才执行）
 * - 失败 throw → 函数冷启动失败 → 不会接收任何请求
 */

import {
  getEnv,
  validateEmbeddingDim,
} from "./lib/env.js";
import {
  errorResponse,
  getClientIp,
  jsonResponse,
  optionsResponse,
  parseFuncPath,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "./lib/handler-utils.js";

import * as ask from "./handlers/api-ask.js";
import * as upload from "./handlers/api-upload.js";
import * as ingest from "./handlers/api-ingest.js";
import * as search from "./handlers/api-search.js";
import * as chat from "./handlers/api-chat.js";
import * as sessionsList from "./handlers/api-sessions-list.js";
import * as sessionsGet from "./handlers/api-sessions-get.js";
import * as sessionsDelete from "./handlers/api-sessions-delete.js";
import * as stats from "./handlers/api-stats.js";
import * as authWxLogin from "./handlers/api-auth-wx-login.js";
import * as authAdminLogin from "./handlers/api-auth-admin-login.js";
import * as cronCleanup from "./handlers/api-cron-cleanup.js";
import * as health from "./handlers/api-health.js";

// 启动时硬验证（生产期）
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

void startValidation();

/**
 * CP-6 修复：esbuild bundle 没有 server.listen() 等 keep-alive handle，
 * `void startValidation()` 是 fire-and-forget 异步 — module load 完后 Node 进程 0 active handle → 立即 exit 0。
 * SCF Event runtime 期望 user code 一直 run 直到 invoke 调 main()。
 * 之前用 setInterval(1<<30) 被 SCF 当 0 active handle（InitFunction: 0ms + 0 code exit），
 * 改用 1s 短间隔 + 真 callback 保持 event loop 真的 active。
 */
let keepAliveTicks = 0;
setInterval(() => {
  keepAliveTicks++;
}, 1_000);

/** func 名 → handler 模块映射 */
type HandlerModule = { main: (event: HttpTriggerEvent) => Promise<HttpTriggerResponse> };

const HANDLER_MAP: Record<string, HandlerModule> = {
  "api-ask": ask as unknown as HandlerModule,
  "api-upload": upload as unknown as HandlerModule,
  "api-ingest": ingest as unknown as HandlerModule,
  "api-search": search as unknown as HandlerModule,
  "api-chat": chat as unknown as HandlerModule,
  "api-sessions-list": sessionsList as unknown as HandlerModule,
  "api-sessions-get": sessionsGet as unknown as HandlerModule,
  "api-sessions-delete": sessionsDelete as unknown as HandlerModule,
  "api-stats": stats as unknown as HandlerModule,
  "api-auth-wx-login": authWxLogin as unknown as HandlerModule,
  "api-auth-admin-login": authAdminLogin as unknown as HandlerModule,
  "api-cron-cleanup": cronCleanup as unknown as HandlerModule,
  "api-health": health as unknown as HandlerModule,
};

/** 兼容 /health 短路径（admin 历史惯例） */
function resolveFuncPath(path: string): string | null {
  if (path === "/health") return "api-health";
  const parsed = parseFuncPath(path);
  return parsed?.func ?? null;
}

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  const start = Date.now();
  const clientIp = getClientIp(event);

  // request log（start）
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    level: "info",
    msg: "request.start",
    method: event.httpMethod,
    path: event.path,
    clientIp,
  }));

  // OPTIONS 预检
  if (event.httpMethod === "OPTIONS") {
    return optionsResponse(env.ALLOWED_ORIGIN);
  }

  const funcName = resolveFuncPath(event.path);
  if (!funcName) {
    logEnd(start, event, clientIp, funcName, 404, "NOT_FOUND");
    return errorResponse("NOT_FOUND", `Unknown path: ${event.path}`, 404);
  }

  const handler = HANDLER_MAP[funcName];
  if (!handler) {
    logEnd(start, event, clientIp, funcName, 404, "HANDLER_NOT_FOUND");
    return errorResponse("NOT_FOUND", `No handler for ${funcName}`, 404);
  }

  try {
    const response = await handler.main(event);
    logEnd(start, event, clientIp, funcName, response.statusCode);
    return response;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[${funcName}] handler threw:`, err);
    const message = err instanceof Error ? err.message : String(err);
    logEnd(start, event, clientIp, funcName, 500, "INTERNAL_ERROR");
    return jsonResponse(
      { error: "INTERNAL_ERROR", message: `${funcName} failed: ${message}` },
      500,
    );
  }
}

/** SCF 兼容别名：某些版本要求 handler 名（而非 main） */
export const handler = main;

/** request log（end）—— 结构化 JSON 一行输出，便于 CloudBase 日志聚合 */
function logEnd(
  start: number,
  event: HttpTriggerEvent,
  clientIp: string,
  funcName: string | null,
  statusCode: number,
  errorCode?: string,
): void {
  const latency = Date.now() - start;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    level: statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info",
    msg: "request.end",
    method: event.httpMethod,
    path: event.path,
    func: funcName,
    status: statusCode,
    latencyMs: latency,
    clientIp,
    ...(errorCode ? { errorCode } : {}),
  }));
}