import { verifyAdminToken } from "../lib/auth.js";
import { runAsk } from "../lib/ask.js";
import { DISCLAIMER_TEXT } from "@unequal/shared/prompt";
import type { SearchResult } from "@unequal/shared/retrieval";
import type { Env } from "../types.js";

export const askRoute = {
  async POST(request: Request, env: Env): Promise<Response> {
    const auth = verifyAdminToken(request.headers.get("Authorization"), env.ADMIN_TOKEN);
    if (!auth.ok) {
      return Response.json({ error: auth.message }, { status: auth.status });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const q = typeof (body as { q?: unknown })?.q === "string"
      ? (body as { q: string }).q.trim()
      : "";
    if (!q) {
      return Response.json({ error: "Missing or empty 'q' field" }, { status: 400 });
    }

    const opts: Parameters<typeof runAsk>[0] = { q, env };
    if (env.ENVIRONMENT === "test") {
      const hits = (body as { __hits?: unknown }).__hits;
      if (Array.isArray(hits)) {
        // 类型断言：test-only，生产不接
        opts.searchFn = async () => hits as SearchResult[];
      }
      const cacheHit = (body as { __cacheHit?: { answer: string; verified: number[] } }).__cacheHit;
      if (cacheHit) {
        opts.cacheRead = async () => ({
          answer: cacheHit.answer,
          disclaimer: DISCLAIMER_TEXT,
          citations: [],
          cached: false,
        });
      }
      // __noCache: 测试环境禁用 cache 模块默认实现（Miniflare v3 不支持 VECTORIZE binding；
      // 显式 cache-hit 测试通过 __cacheHit 注入 opts.cacheRead 覆盖，二者不冲突）
      if ((body as { __noCache?: boolean }).__noCache) {
        opts.cacheRead = async () => null;
        opts.cacheWrite = async () => undefined;
      }
    }

    try {
      const result = await runAsk(opts);
      return Response.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("LLM chat failed")) {
        return Response.json({ error: "upstream_unavailable" }, { status: 502 });
      }
      return Response.json({ error: "internal", detail: msg }, { status: 500 });
    }
  },
};
