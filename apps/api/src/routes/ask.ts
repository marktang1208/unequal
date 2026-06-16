import { verifyAuth, HttpError } from "../lib/auth.js";
import { runAsk } from "../lib/ask.js";
import { DISCLAIMER_TEXT } from "@unequal/shared/prompt";
import type { Citation } from "@unequal/shared/types";
import type { SearchResult } from "@unequal/shared/retrieval";
import type { Env } from "../types.js";

/**
 * dev-mode mock shortcut 常量。
 *
 * 为什么用 `test-token-please-change` 做 sentinel：
 * - 这是 dev .dev.vars 的固定 ADMIN_TOKEN，生产环境一定不会用这个值
 * - 即使 ENVIRONMENT === "development"，只要 ADMIN_TOKEN 不是这个值，也不会触发 mock-mode
 * - 双保险：必须 dev env + dev token + "mock:" 前缀三连击才生效
 */
const DEV_MOCK_TOKEN = "test-token-please-change";
const MOCK_PREFIX = "mock:";

const MOCK_CITATIONS: Citation[] = [
  {
    n: 1,
    title: "美国儿科学会育儿百科（第7版）节选",
    snippet:
      "三个月以下婴儿发烧应立即就医。3-6 个月婴儿体温超过 38.5℃ 建议先测量腋温确认...",
    url: "raw/01H0000000000000000000000/dev-seed/aap-fever.pdf",
    trustLevel: 3,
    sourceId: "01HAAAPEDSAAAA00000000001",
    chunkId: "01HCCCAAAA00000000000001",
  },
  {
    n: 3,
    title: "崔玉涛：婴儿发烧的家庭处理",
    snippet:
      "婴儿发烧时先观察精神状态比体温数字更重要。精神好、吃奶正常、玩耍如常的低烧（<38.5℃）可先物理降温...",
    url: "raw/01H0000000000000000000000/dev-seed/cui-yutao-fever.html",
    trustLevel: 2,
    sourceId: "01HAAAPEDSAAAA00000000002",
    chunkId: "01HCCCAAAA00000000000003",
  },
];

const MOCK_ANSWER =
  "5个月宝宝发烧 38.5°C 建议先 [来源 1] [来源 3]";

export const askRoute = {
  async POST(request: Request, env: Env): Promise<Response> {
    // dev-mode mock shortcut: 提前到 token 校验之前。
    // 三连击保险：development env + env.ADMIN_TOKEN 是 sentinel 值 + q startsWith "mock:"。
    //   - 生产环境 ENVIRONMENT !== "development" → 永远不触发
    //   - 生产 env.ADMIN_TOKEN 必不是 sentinel（生产 wrangler secret 必换）→ 永远不触发
    // 无 token 的客户端（如 miniprogram 调试）也能调 mock-mode；普通 q 仍需走 token + 真路径
    if (env.ENVIRONMENT === "development" && env.ADMIN_TOKEN === DEV_MOCK_TOKEN) {
      try {
        const mockBody = (await request.clone().json()) as { q?: unknown };
        const mockQ = typeof mockBody?.q === "string" ? mockBody.q.trim() : "";
        if (mockQ.startsWith(MOCK_PREFIX)) {
          const disclaimer = DISCLAIMER_TEXT;
          const answer = MOCK_ANSWER.includes(disclaimer)
            ? MOCK_ANSWER
            : `${MOCK_ANSWER}\n\n${disclaimer}`;
          return Response.json({
            answer,
            disclaimer,
            citations: MOCK_CITATIONS,
            cached: false,
          });
        }
      } catch {
        /* not JSON / unreadable → fall through to normal flow */
      }
    }

    try {
      await verifyAuth(request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json({ error: err.code, message: err.message }, { status: err.status });
      }
      throw err;
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
