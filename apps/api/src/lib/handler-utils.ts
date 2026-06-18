/**
 * CP-6: HTTP trigger 通用工具
 *
 * CloudBase HTTP 触发器 handler 签名：
 *   export async function main(event: HttpTriggerEvent, context: Context) {
 *     return { statusCode, headers, body }
 *   }
 *
 * 此模块提供统一 JSON 响应、CORS headers、body 解析、query 解析等。
 */

export interface HttpTriggerEvent {
  httpMethod: string;
  path: string;
  headers: Record<string, string>;
  /** queryString 实际可能 undefined（CloudBase HTTP gateway 时有时无） */
  queryString?: Record<string, string | string[]>;
  body: string | null;
  isBase64Encoded: boolean;
}

export interface HttpTriggerResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

export interface ApiError {
  error: string;
  message: string;
  retry_after?: number;
  details?: unknown;
}

/** 统一 JSON 响应 */
export function jsonResponse(
  data: unknown,
  statusCode = 200,
  extraHeaders: Record<string, string> = {},
): HttpTriggerResponse {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
    body: JSON.stringify(data),
  };
}

/** 统一错误响应 */
export function errorResponse(
  error: string,
  message: string,
  statusCode = 500,
  extra: Partial<ApiError> = {},
): HttpTriggerResponse {
  return jsonResponse({ error, message, ...extra }, statusCode);
}

/** CORS headers（按 ALLOWED_ORIGIN） */
export function corsHeaders(allowedOrigin: string): Record<string, string> {
  const origin = !allowedOrigin || allowedOrigin === "*" ? "*" : allowedOrigin;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

/** 解析 JSON body；失败返 null */
export function parseJsonBody<T = unknown>(event: HttpTriggerEvent): T | null {
  if (!event.body) return null;
  try {
    return JSON.parse(event.body) as T;
  } catch {
    return null;
  }
}

/** 取第一个 query 参数值（兼容 queryString + queryStringParameters） */
export function getQuery(event: HttpTriggerEvent, key: string): string | undefined {
  // SCF API GW 标准: queryStringParameters；CloudBase: queryString
  const qs = event.queryString ?? (event as unknown as { queryStringParameters?: Record<string, string | string[]> }).queryStringParameters;
  const v = qs?.[key];
  return Array.isArray(v) ? v[0] : v;
}

/** 取 client IP（CloudBase 透传 header，按需 smoke 验证实际 header 名） */
export function getClientIp(event: HttpTriggerEvent): string {
  return (
    event.headers["x-real-ip"] ||
    event.headers["X-Real-IP"] ||
    event.headers["x-forwarded-for"] ||
    event.headers["X-Forwarded-For"] ||
    "unknown"
  );
}

/** OPTIONS 预检返 204 */
export function optionsResponse(allowedOrigin: string): HttpTriggerResponse {
  return {
    statusCode: 204,
    headers: corsHeaders(allowedOrigin),
    body: "",
  };
}

/** 简单 path 解析：把 `/api-ask/123` 解析成 `{ func: 'api-ask', rest: '/123' }` */
export function parseFuncPath(
  path: string,
): { func: string; rest: string } | null {
  const m = path.match(/^\/?(api-[^/]+)(.*)$/);
  if (!m) return null;
  return { func: m[1] ?? "", rest: m[2] ?? "" };
}