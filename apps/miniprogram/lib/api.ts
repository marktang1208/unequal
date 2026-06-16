import type {
  AskResponse,
  AskError,
  ChatRequest,
  ChatResponse,
  SessionsListResponse,
} from "./types.js";
import { getJwtToken, ensureJwt } from "./auth.js";

/**
 * 调 /ask endpoint 拿单轮问答。
 * Mock-first：
 * - 开发期 base URL = http://localhost:8787（需在微信开发者工具勾选「不校验合法域名」）
 * - CP-5 真接 Cloudflare 后改 https://unequal.xxx.workers.dev
 * - fetch 注入点允许测试桩（Vitest 单测）
 *
 * 三方环境兼容：
 * - Vitest Node 单测：opts.fetchImpl 注入
 * - 小程序运行时：wx 全局存在，走 wxRequestAsFetch（globalThis.fetch 不存在）
 * - 其它（admin / 浏览器）：原生 fetch
 */

export interface ApiOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

interface ResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** 把 wx.request 包成 fetch 兼容的 Promise 接口。miniprogram 运行时唯一可用的 HTTP 通道。 */
function wxRequestAsFetch(input: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<ResponseLike> {
  return new Promise((resolve, reject) => {
    // miniprogram-api-typings 没装，wx 全局在 tsc 看是 any
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.request({
      url: input,
      method: (init.method ?? "GET") as any,
      header: init.headers as any,
      data: init.body as any,
      success: (res: any) => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        const bodyText = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
        const response: ResponseLike = {
          ok,
          status: res.statusCode,
          statusText: "",
          json: async () => {
            try { return JSON.parse(bodyText); } catch { return {}; }
          },
          text: async () => bodyText,
        };
        resolve(response);
      },
      fail: (err: any) => reject(new Error(err.errMsg ?? "wx.request failed")),
    });
  });
}

function getFetch(opts: ApiOptions): (input: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<ResponseLike> {
  if (opts.fetchImpl) return opts.fetchImpl as never;
  // @ts-expect-error wx 全局类型 mock-first 缺失
  if (typeof wx !== "undefined" && typeof wx.request === "function") return wxRequestAsFetch as never;
  return fetch as never;
}

/* ---------- M6.3a 401 transparent refresh wrapper ---------- */

/**
 * 包一层：401 触发 ensureJwt 拿新 jwt → 用新 jwt 重发原 request 1 次。
 * - 第二次仍 401 → 拒死循环（isRetry flag 强制最多 1 次）
 * - wx.login 或 /auth/wx-login 失败 → 原 401 透传给 caller（caller 决定 mock-first fallback）
 *
 * M6.2 adminLogin 走独立路径（无 jwt header），保留直 getFetch 不变。
 */
/** @internal 导出仅用于单测；生产代码不直接调 */
export async function fetchWithRefresh(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  opts: ApiOptions,
  isRetry = false,
): Promise<ResponseLike> {
  const f = getFetch(opts);
  const res = await f(url, init);
  if (res.status !== 401 || isRetry) return res;
  // 401 + 非 retry → 触发 refresh
  try {
    const newJwt = await ensureJwt(opts.baseUrl ?? "http://localhost:8787", opts.fetchImpl);
    const newInit: typeof init = {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${newJwt}` },
    };
    return await fetchWithRefresh(url, newInit, opts, true);
  } catch {
    // wx.login 失败或 /auth/wx-login 失败 → 原 401 透传
    return res;
  }
}

function buildHeaders(opts: ApiOptions): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // M6.2: 优先 opts.token（admin LoginPage 用），否则用 storage jwt
  if (opts.token) {
    headers.authorization = `Bearer ${opts.token}`;
  } else {
    const jwt = getJwtToken();
    if (jwt) headers.authorization = `Bearer ${jwt}`;
  }
  return headers;
}

/* ---------- M6.2 admin login ---------- */

/** POST /auth/admin-login → 返 admin jwt。Caller 自己 saveJwt() */
export async function adminLogin(
  adminToken: string,
  opts: ApiOptions = {},
): Promise<{ token: string; user_id: string; is_admin: boolean; expires_in: number }> {
  const baseUrl = opts.baseUrl ?? "http://localhost:8787";
  const f = getFetch(opts);
  const res = await f(`${baseUrl}/auth/admin-login`, {
    method: "POST",
    headers: buildHeaders(opts),
    body: JSON.stringify({ admin_token: adminToken }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as AskError;
    throw new Error(`/auth/admin-login ${res.status}: ${body.error ?? "unknown"}`);
  }
  return (await res.json()) as { token: string; user_id: string; is_admin: boolean; expires_in: number };
}

export async function ask(q: string, opts: ApiOptions = {}): Promise<AskResponse> {
  const baseUrl = opts.baseUrl ?? "http://localhost:8787";
  const f = getFetch(opts);
  const res = await f(`${baseUrl}/ask`, {
    method: "POST",
    headers: buildHeaders(opts),
    body: JSON.stringify({ q }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as AskError;
    throw new Error(`/ask ${res.status}: ${body.error ?? "unknown"}`);
  }
  return (await res.json()) as AskResponse;
}

/* ---------- M6.1 多轮会话 + session CRUD ---------- */

/**
 * /chat 多轮问答。sessionId 缺 → 服务端新建；sessionId 有 → 复用。
 * 失败降级：网络/5xx 抛 Error（含 status + code），让 caller 决定 retry / mock-first fallback。
 */
export async function chat(req: ChatRequest, opts: ApiOptions = {}): Promise<ChatResponse> {
  const baseUrl = opts.baseUrl ?? "http://localhost:8787";
  const f = getFetch(opts);
  const res = await f(`${baseUrl}/chat`, {
    method: "POST",
    headers: buildHeaders(opts),
    body: JSON.stringify({
      q: req.q,
      ...(req.session_id ? { session_id: req.session_id } : {}),
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as AskError;
    throw new Error(`/chat ${res.status}: ${body.error ?? "unknown"}`);
  }
  return (await res.json()) as ChatResponse;
}

/** GET /sessions → 返 server-side session 列表（最近 50） */
export async function listSessions(opts: ApiOptions = {}): Promise<SessionsListResponse> {
  const baseUrl = opts.baseUrl ?? "http://localhost:8787";
  const f = getFetch(opts);
  const res = await f(`${baseUrl}/sessions`, {
    method: "GET",
    headers: buildHeaders(opts),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as AskError;
    throw new Error(`/sessions ${res.status}: ${body.error ?? "unknown"}`);
  }
  return (await res.json()) as SessionsListResponse;
}

/** PATCH /sessions/:id → 改 title */
export async function renameSession(sessionId: string, title: string, opts: ApiOptions = {}): Promise<void> {
  const baseUrl = opts.baseUrl ?? "http://localhost:8787";
  const f = getFetch(opts);
  const res = await f(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: buildHeaders(opts),
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as AskError;
    throw new Error(`/sessions PATCH ${res.status}: ${body.error ?? "unknown"}`);
  }
}

/** DELETE /sessions/:id → 服务端软删（标 degraded_at） */
export async function deleteSession(sessionId: string, opts: ApiOptions = {}): Promise<void> {
  const baseUrl = opts.baseUrl ?? "http://localhost:8787";
  const f = getFetch(opts);
  const res = await f(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: buildHeaders(opts),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as AskError;
    throw new Error(`/sessions DELETE ${res.status}: ${body.error ?? "unknown"}`);
  }
}
