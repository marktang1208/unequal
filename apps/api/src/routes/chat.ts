/**
 * M6.1 /chat 路由（spec §3.2 / §5）。
 *
 * 流程：verifyAuth → parse body { q, session_id? } → runChat → ChatResponse。
 * HttpError 走 try/catch 统一映射 status + code；其他 Error → 500 internal。
 *
 * /ask 兼容共存：单轮走 /ask，多轮走 /chat（M6.1 spec §1.2）。
 */
import { verifyAuth, HttpError } from "../lib/auth.js";
import { runChat, type RunChatOptions } from "../lib/chat.js";
import type { Env } from "../types.js";
import type { SearchResult } from "@unequal/shared/retrieval";

interface ChatRequestBody {
  q?: unknown;
  session_id?: unknown;
  __hits?: unknown; // test-only DI
  __noCache?: unknown; // test-only: 禁用默认 cacheRead/cacheWrite
  __cacheHit?: { answer: string; verified: number[] }; // test-only: 注入 cache 命中
}

export const chatRoute = {
  async POST(request: Request, env: Env): Promise<Response> {
    // 1) 鉴权
    let identity;
    try {
      identity = await verifyAuth(request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json({ error: err.code, message: err.message }, { status: err.status });
      }
      throw err;
    }

    // 2) parse body
    let body: ChatRequestBody;
    try {
      body = (await request.json()) as ChatRequestBody;
    } catch {
      return Response.json({ error: "INVALID_JSON", message: "Request body must be JSON" }, { status: 400 });
    }

    const q = typeof body.q === "string" ? body.q.trim() : "";
    if (!q) {
      return Response.json({ error: "MISSING_Q", message: "Missing or empty 'q' field" }, { status: 400 });
    }

    const sessionId = typeof body.session_id === "string" && body.session_id.length > 0
      ? body.session_id
      : undefined;

    // 3) 调 runChat
    const opts: RunChatOptions = { userId: identity.userId, q, sessionId, env };

    // test-only DI（与 ask.ts 同样的 __hits/__noCache 注入模式，方便集成测）
    if (env.ENVIRONMENT === "test") {
      if (Array.isArray(body.__hits)) {
        opts.searchFn = async () => body.__hits as SearchResult[];
      }
      if (body.__cacheHit) {
        const hit = body.__cacheHit;
        opts.cacheRead = async () => ({
          answer: hit.answer,
          disclaimer: "",
          citations: [],
          cached: false,
        });
      }
      if (body.__noCache) {
        opts.cacheRead = async () => null;
        opts.cacheWrite = async () => undefined;
      }
    }

    try {
      const result = await runChat(opts);
      return Response.json(result);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json({ error: err.code, message: err.message }, { status: err.status });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: "internal", detail: msg }, { status: 500 });
    }
  },
};
