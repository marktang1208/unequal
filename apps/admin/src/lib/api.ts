import type { TrustLevel } from "@unequal/shared/types";

// React app 走 Vite proxy：`/api/*` → `http://localhost:8787/*`（前缀被剥离）
const API_BASE = "/api";

export function getToken(): string {
  // 优先用 localStorage（M6.2 后 admin 都走 /auth/admin-login 拿 jwt 写 localStorage）
  const token = localStorage.getItem("admin_token");
  if (token) return token;
  // M3 dev fallback：只 dev 环境 + localStorage 没 key → 用 dev sentinel。
  // 这条让 dev 体验"装好 admin dev 就能用"，不需先访问 /login。
  // sentinel 值与 server 端 apps/api/src/routes/ask.ts 的 DEV_MOCK_TOKEN 对齐。
  if (import.meta.env.DEV) return "test-token-please-change";
  // 生产：无 token → 抛错，路由 RequireAuth 已经 navigate("/login")
  throw new Error("admin_token 未设置：请访问 /login 登录");
}

/**
 * M6.2 admin JWT 登录（spec §3.7） */

/**
 * M6.3a 401 handler：清除 admin_token + 强刷跳 /login（spec §5.4 / §7.3）。
 * 强刷绕过 react-router，避免 RequireAuth race。
 *
 * 当前 admin 仅有 adminLogin 一个 fetch 端点（LoginPage 已显式 catch 401/429），
 * handleApiResponse 作为 lib 备件保留，待后续 admin 接入新 fetch 时统一调用。
 */
export function handleApiResponse(res: Response): Response {
  if (res.status === 401) {
    localStorage.removeItem("admin_token");
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
  }
  return res;
}

export interface AdminLoginResponse {
  token: string;
  user_id: string;
  is_admin: boolean;
  expires_in: number;
}

/**
 * POST /api/auth/admin-login：拿 admin_token 换 jwt。
 * 服务端（apps/api/src/routes/auth.ts）匹配 ENV.ADMIN_TOKEN → 返 jwt。
 * 401/403 时抛 Error，message 含状态码 + body 便于诊断。
 */
export async function adminLogin(
  adminToken: string,
): Promise<AdminLoginResponse> {
  const res = await fetch("/api/auth/admin-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ admin_token: adminToken }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/auth/admin-login ${res.status}: ${text}`);
  }
  return (await res.json()) as AdminLoginResponse;
}

export interface UploadResponse {
  sourceId: string;
  documentId: string;
  chunkCount: number;
  r2Key: string;
}

export interface SearchHit {
  chunkId: string;
  sourceId?: string;
  documentId?: string;
  trustLevel: number;
  finalScore: number;
  vectorizeScore: number;
  content: string;
}

export interface SearchResponse {
  q: string;
  hits: SearchHit[];
}

export async function uploadFile(
  file: File,
  trustLevel: TrustLevel
): Promise<UploadResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("trust_level", String(trustLevel));

  const resp = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`upload failed: ${resp.status} ${text}`);
  }
  return (await resp.json()) as UploadResponse;
}

export async function search(q: string, topK = 5): Promise<SearchResponse> {
  const params = new URLSearchParams({ q, topK: String(topK) });
  const resp = await fetch(`${API_BASE}/search?${params.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`search failed: ${resp.status} ${text}`);
  }
  return (await resp.json()) as SearchResponse;
}

export interface AskCitation {
  n: number;
  title: string;
  snippet: string;
  url: string;
  trustLevel: number;
  sourceId: string;
  chunkId: string;
}

export interface AskResponse {
  answer: string;
  disclaimer: string;
  citations: AskCitation[];
  cached: boolean;
}

export async function ask(q: string): Promise<AskResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch("/api/ask", {
    method: "POST",
    headers,
    body: JSON.stringify({ q }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/ask ${res.status}: ${text}`);
  }
  return (await res.json()) as AskResponse;
}

/* ---------- M6.1 多轮会话（spec §3.2 / §3.3） ---------- */

export interface ChatCitation {
  n: number;
  title: string;
  trust_level: 0 | 1 | 2 | 3;
  chunk_id: string;
}

export interface ChatResponse {
  answer: string;
  disclaimer?: string;
  citations: ChatCitation[];
  session_id: string;
  session_title: string | null;
  is_new_session: boolean;
  cached: boolean;
  degraded: boolean;
}

export interface ChatSessionRow {
  id: string;
  user_id: string;
  title: string | null;
  created_at: number;
  last_active_at: number;
  degraded_at: number | null;
}

async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${init.method ?? "GET"} ${path} ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function chat(q: string, sessionId?: string): Promise<ChatResponse> {
  return authedJson<ChatResponse>("/chat", {
    method: "POST",
    body: JSON.stringify({ q, ...(sessionId ? { session_id: sessionId } : {}) }),
  });
}

export async function listSessions(): Promise<{ sessions: ChatSessionRow[] }> {
  return authedJson<{ sessions: ChatSessionRow[] }>("/sessions", { method: "GET" });
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  await authedJson<{ ok: true }>(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await authedJson<{ ok: true }>(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export interface CrawledDocument {
  url: string;
  title: string;
  content: string;
  fetchedAt: string;
  trustLevel: number;
}

export interface CrawlResult {
  document: CrawledDocument;
  ingested: boolean;
  sourceId: string;
  documentId: string;
  chunkCount: number;
}

export async function crawlUrl(
  url: string,
  trustLevel: number
): Promise<CrawlResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`/api/crawl?url=${encodeURIComponent(url)}&trust_level=${trustLevel}`, {
    method: "POST",
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/crawl ${res.status}: ${text}`);
  }
  return (await res.json()) as CrawlResult;
}

// ─────────────────────────────────────────────────────────
// M5: 小红书 / 微信公众号批量抓取（mock-first）
// ─────────────────────────────────────────────────────────

export interface PlatformCrawledDoc {
  url: string;
  title: string;
  author: string;
  publishedAt: string;
  content: string;
  paragraphs: string[];
}

export type PlatformCrawlOutcome =
  | { ok: true; doc: PlatformCrawledDoc }
  | { ok: false; reason: "fixture_miss" | "parse_fail"; message: string };

export interface PlatformCrawlResult {
  /** 所有提交的 URL（保持输入顺序） */
  urls: string[];
  /** 每个 URL 的抓取结果，与 urls 一一对应 */
  outcomes: PlatformCrawlOutcome[];
}

/**
 * Mock-first 抓取小红书 URL 列表：
 * 1. fetch /mock-crawl/xiaohongshu.json (Vite 静态服务)
 * 2. 按 URL 查 fixture，命中即返回 ok: true
 * 3. 未命中返 ok: false, reason: 'fixture_miss'
 *
 * 真接 Cloudflare 时改为 fetch https://unequal-api.xxx.workers.dev/crawl/xiaohongshu
 */
export async function crawlXiaohongshuUrls(
  urls: string[]
): Promise<PlatformCrawlResult> {
  const res = await fetch("/mock-crawl/xiaohongshu.json");
  if (!res.ok) {
    return {
      urls,
      outcomes: urls.map((url) => ({
        ok: false,
        reason: "fixture_miss",
        message: `fixture fetch failed: HTTP ${res.status}`,
      })),
    };
  }
  const fixtureMap = (await res.json()) as Record<string, PlatformCrawledDoc>;
  return {
    urls,
    outcomes: urls.map((url) => {
      const doc = fixtureMap[url];
      if (!doc) {
        return {
          ok: false,
          reason: "fixture_miss",
          message: `URL not in fixture (mock-first mode)`,
        };
      }
      return { ok: true, doc };
    }),
  };
}

/**
 * Mock-first 抓取微信公众号 URL 列表：同 crawlXiaohongshuUrls，fixture 路径换 wechat-mp.json
 */
export async function crawlWechatMpUrls(
  urls: string[]
): Promise<PlatformCrawlResult> {
  const res = await fetch("/mock-crawl/wechat-mp.json");
  if (!res.ok) {
    return {
      urls,
      outcomes: urls.map((url) => ({
        ok: false,
        reason: "fixture_miss",
        message: `fixture fetch failed: HTTP ${res.status}`,
      })),
    };
  }
  const fixtureMap = (await res.json()) as Record<string, PlatformCrawledDoc>;
  return {
    urls,
    outcomes: urls.map((url) => {
      const doc = fixtureMap[url];
      if (!doc) {
        return {
          ok: false,
          reason: "fixture_miss",
          message: `URL not in fixture (mock-first mode)`,
        };
      }
      return { ok: true, doc };
    }),
  };
}