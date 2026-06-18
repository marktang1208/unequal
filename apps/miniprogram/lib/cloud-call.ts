/**
 * CP-7-A miniprogram 唯一 callFunction 入口（spec §5）。
 *
 * 行为：
 * - Promise<T> typed body，caller 不解析 statusCode
 * - 401 + 有 jwt → refreshJwt + retry 1 次（内部 inflight 共享 wx.login）
 * - 4xx / 5xx → throw ApiError(statusCode, code, message)
 * - rawCall throw → throw ApiError(0, NETWORK_ERROR, err.message)
 *
 * 测试桩：
 * - __setCloudCallImpl(mockFn) 注入（避免 mock 全局 wx.cloud）
 * - __resetCloudCallImpl() 清空
 * - __clearInflightRefresh() 清 inflight 缓存
 *
 * 设计决策：见 spec 附录 A D-1 ~ D-10。
 */

import { ensureJwt } from "./auth.js";
import { saveJwt } from "./chat-storage.js";

// ─── ApiError ───────────────────────────────────────────────
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ─── CloudCallRequest / RawResult ───────────────────────────
export interface CloudCallRequest {
  path: string;
  httpMethod: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string>;
  jwt?: string;
}

export interface RawResult {
  statusCode: number;
  body: unknown;
}

export type CloudCallFn = (req: CloudCallRequest) => Promise<RawResult>;

// ─── impl + 测试桩 ──────────────────────────────────────────
let impl: CloudCallFn | null = null;
export function __setCloudCallImpl(next: CloudCallFn | null): void {
  impl = next;
}
export function __resetCloudCallImpl(): void {
  impl = null;
}

// ─── inflight refresh（M6.4 模式） ──────────────────────────
let inflightRefresh: Promise<string> | null = null;
export function __clearInflightRefresh(): void {
  inflightRefresh = null;
}

async function refreshJwt(): Promise<string> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    try {
      return await ensureJwt();
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

// ─── rawCall（impl ?? wx.cloud.callFunction）────────────────
async function rawCall(req: CloudCallRequest): Promise<RawResult> {
  if (impl) return impl(req);
  // @ts-expect-error wx 全局类型 mock-first 缺失
  if (typeof wx === "undefined" || !wx.cloud?.callFunction) {
    throw new ApiError(0, "WX_UNAVAILABLE", "wx.cloud.callFunction unavailable; set impl via __setCloudCallImpl");
  }
  return new Promise<RawResult>((resolve, reject) => {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.cloud.callFunction({
      name: "api-router",
      data: {
        path: req.path,
        httpMethod: req.httpMethod,
        body: req.body !== undefined ? JSON.stringify(req.body) : null,
        headers: req.jwt ? { authorization: `Bearer ${req.jwt}` } : {},
        queryString: req.query ?? {},
        isBase64Encoded: false,
      },
      success: (res: { result?: { statusCode?: number; body?: string } }) => {
        const r = res.result ?? {};
        let body: unknown;
        try {
          body = JSON.parse(r.body ?? "");
        } catch {
          body = r.body;
        }
        resolve({ statusCode: r.statusCode ?? 0, body });
      },
      fail: (err: { errMsg?: string }) =>
        reject(new ApiError(0, "NETWORK_ERROR", err.errMsg ?? "wx.cloud.callFunction failed")),
    });
  });
}

// ─── codeFromBody / msgFromBody helpers ─────────────────────
function codeFromBody(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    return String((body as Record<string, unknown>).error);
  }
  return "UNKNOWN";
}

function msgFromBody(body: unknown): string {
  if (body && typeof body === "object" && "message" in body) {
    return String((body as Record<string, unknown>).message);
  }
  return "Unknown error";
}

// ─── cloudCall（公开 API）──────────────────────────────────
export async function cloudCall<T>(req: CloudCallRequest): Promise<T> {
  let res: RawResult;
  try {
    res = await rawCall(req);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      err instanceof Error ? err.message : String(err),
    );
  }

  // 401 + 有 jwt → refresh + retry 1 次
  if (res.statusCode === 401 && req.jwt) {
    let newJwt: string;
    try {
      newJwt = await refreshJwt();
    } catch (err) {
      throw new ApiError(
        401,
        "REFRESH_FAILED",
        err instanceof Error ? err.message : String(err),
      );
    }
    let retry: RawResult;
    try {
      retry = await rawCall({ ...req, jwt: newJwt });
    } catch (err) {
      throw new ApiError(
        0,
        "NETWORK_ERROR",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (retry.statusCode === 401) {
      saveJwt(null);
      throw new ApiError(401, "UNAUTHORIZED", "Authentication failed after refresh");
    }
    if (retry.statusCode >= 400) {
      throw new ApiError(retry.statusCode, codeFromBody(retry.body), msgFromBody(retry.body));
    }
    return retry.body as T;
  }

  // 401 + 无 jwt → throw MISSING_AUTH（不 refresh）
  if (res.statusCode === 401) {
    throw new ApiError(401, "MISSING_AUTH", "No JWT provided");
  }
  if (res.statusCode >= 400) {
    throw new ApiError(res.statusCode, codeFromBody(res.body), msgFromBody(res.body));
  }
  return res.body as T;
}