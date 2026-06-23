/**
 * api-search handler 单元测试 — ask-search-retrieval fix
 *
 * 验证：
 * 1. happy path: 2 chunks 返 topK=10（默认）
 * 2. 1000 chunks mock 不 throw：handler 传 limit=500 给 DB
 * 3. limit query param: topK=3 限制返 3 条
 *
 * 端到端 mock：fetch (MiniMax embedding) + whereQuery (CloudBase DB)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// 1. mock CloudBase DB — whereQuery 返 mock chunks + docs
vi.mock("../../src/lib/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/db.js")>();
  return {
    ...actual,
    whereQuery: vi.fn(),
  };
});

import { main as searchMain } from "../../src/handlers/api-search.js";
import * as db from "../../src/lib/db.js";
import { loadEnvForTest, resetEnv } from "../../src/lib/env.js";
import { resetProviders } from "../../src/lib/llm-provider.js";

const ADMIN_TOKEN = "***REMOVED***";
const ALLOW_IP = "127.0.0.1";
const MOCK_USER = "u1";

const MOCK_CHUNK_1 = {
  _id: "01K_CHUNK_1",
  id: "01K_CHUNK_1",
  documentId: "01K_DOC_1",
  sourceId: "01K_SRC_1",
  userId: MOCK_USER,
  idx: 0,
  content: "宝宝 6 个月开始可以尝试断奶过渡，循序渐进最关键。",
  embedding: new Array(1536).fill(0.99),  // 高 cosine
  tokenCount: 20,
  trustLevel: 2,
  createdAt: 1000,
};
const MOCK_CHUNK_2 = {
  ...MOCK_CHUNK_1,
  _id: "01K_CHUNK_2",
  id: "01K_CHUNK_2",
  content: "断奶期间需要保证每天 500ml 奶量。",
  embedding: new Array(1536).fill(0.5),
};
const MOCK_CHUNK_3 = {
  ...MOCK_CHUNK_1,
  _id: "01K_CHUNK_3",
  id: "01K_CHUNK_3",
  content: "断奶不要操之过急。",
  embedding: new Array(1536).fill(0.3),
};

function makeEvent(query: Record<string, string>, headers: Record<string, string> = {}): Parameters<typeof searchMain>[0] {
  return {
    httpMethod: "GET",
    path: "/api-search",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "x-real-ip": ALLOW_IP,
      ...headers,
    },
    body: "",
    queryString: query,
    isBase64Encoded: false,
  } as unknown as Parameters<typeof searchMain>[0];
}

describe("api-search handler (ask-search-retrieval fix)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetEnv();
    resetProviders();
    loadEnvForTest({
      ADMIN_TOKEN,
      JWT_SECRET: "jwt-secret-32-bytes-min-aaaaaaaaa",
      MINIMAX_API_KEY: "sk-test",
      KEK_SECRET_V1: "kek-secret-32-bytes-min-aaaaaaaaa",
      ENVIRONMENT: "production",
      ALLOWED_ORIGIN: "*",
      ADMIN_IP_ALLOWLIST: "127.0.0.1,::1",
      MINIMAX_BASE_URL: "https://api.test/v1",
      DEFAULT_USER_ID: MOCK_USER,
      KEK_CURRENT_VERSION: "1",
    });

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // mock whereQuery：chunk 查 → 返 mock chunks
    vi.mocked(db.whereQuery).mockImplementation(async (coll: string, _filter: any) => {
      if (coll === "chunk") return [MOCK_CHUNK_1, MOCK_CHUNK_2, MOCK_CHUNK_3] as any;
      return [];
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("happy: 3 chunks 返 topK=10（默认）", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ vectors: [new Array(1536).fill(0.99)] }),
    } as Response);

    const ev = makeEvent({ q: "断奶" });
    const res = await searchMain(ev);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.length).toBeLessThanOrEqual(10);  // 默认 topK=10
  });

  it("limit query param: topK=3 限制返 3 条", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ vectors: [new Array(1536).fill(0.99)] }),
    } as Response);

    const ev = makeEvent({ q: "断奶", topK: "3" });
    const res = await searchMain(ev);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results.length).toBeLessThanOrEqual(3);
  });

  // ask-search-retrieval fix: 1000 chunks 模拟大数据场景 → handler 必须传 limit=8 给 DB（防 CloudBase 1MB 阻塞；chunk avg 87KB）
  it("1000 chunks mock 不 throw：handler 传 limit=8 给 DB", async () => {
    const bigChunks = Array.from({ length: 1000 }, (_, i) => ({
      ...MOCK_CHUNK_1,
      _id: `01K_CHUNK_${i}`,
      id: `01K_CHUNK_${i}`,
      content: `mock chunk ${i}: ${"x".repeat(1000)}`,
      embedding: new Array(1536).fill(0.5),
    }));
    vi.mocked(db.whereQuery).mockImplementation(async (coll: string, _filter: any, opts?: any) => {
      if (coll === "chunk") {
        // 验证 handler 传了 limit: 8（修复前不传；修复后传；防止 CloudBase 1MB 阻塞）
        expect(opts?.limit).toBe(8);
        return bigChunks as any;
      }
      return [];
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ vectors: [new Array(1536).fill(0.99)] }),
    } as Response);

    const ev = makeEvent({ q: "断奶", topK: "5" });
    const res = await searchMain(ev);

    // 不应 throw（修复前会因 1MB 限制 throw CloudBase LimitExceeded）
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeLessThanOrEqual(5);
  });
});
