/**
 * api-ask handler 单元测试 — CP-7-D #1/#2 重点
 *
 * 验证 D-1 (model 抽 env) + D-2-a (引用 [N] 统一)：
 * 1. handler 用 env.LLM_MODEL/EMBED_MODEL（不是硬编码）
 * 2. 答案 [N] 解析复用 parseAnswerSegments（不是 JSON 块）
 * 3. citedNums → citations 映射正确（title/snippet/chunkId 来自真 topChunks）
 *
 * 端到端 mock：fetch (MiniMax embedding/chat) + getAllByFilter (CloudBase DB)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// 1. mock CloudBase DB — getAllByFilter 返 mock chunks + docs
vi.mock("../../src/lib/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/db.js")>();
  return {
    ...actual,
    getAllByFilter: vi.fn(),
  };
});

import { main as askMain } from "../../src/handlers/api-ask.js";
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
  embedding: new Array(1536).fill(0.01),
  tokenCount: 20,
  trustLevel: 2,
  createdAt: 1000,
};
const MOCK_CHUNK_2 = {
  ...MOCK_CHUNK_1,
  _id: "01K_CHUNK_2",
  id: "01K_CHUNK_2",
  content: "断奶期间需要保证每天 500ml 奶量。",
};
const MOCK_DOC_1 = {
  _id: "01K_DOC_1",
  id: "01K_DOC_1",
  sourceId: "01K_SRC_1",
  userId: MOCK_USER,
  title: "宝宝断奶指南",
  rawPath: "https://example.com/weaning",
  createdAt: 1000,
};

function makeEvent(body: unknown, headers: Record<string, string> = {}): Parameters<typeof askMain>[0] {
  return {
    httpMethod: "POST",
    path: "/api-ask",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "x-real-ip": ALLOW_IP,
      ...headers,
    },
    body: JSON.stringify(body),
    queryString: {},
    isBase64Encoded: false,
  } as unknown as Parameters<typeof askMain>[0];
}

describe("api-ask handler (CP-7-D #1/#2)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetEnv();
    resetProviders();  // CP-7-D #2: 懒加载单例必须 reset，避免前测试 embedder 复用
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

    // mock fetch（MiniMax embedding + chat 都走这里）
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // mock getAllByFilter：chunk 查 → 返 MOCK_CHUNK_1/2；document 查 → 返 MOCK_DOC_1
    vi.mocked(db.getAllByFilter).mockImplementation(async (coll: string, filter: any) => {
      if (coll === "chunk") return [MOCK_CHUNK_1, MOCK_CHUNK_2] as any;
      if (coll === "document") {
        if (filter && filter.id) return [MOCK_DOC_1] as any;
        return [];
      }
      return [];
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("D-1: handler 用 env.LLM_MODEL/EMBED_MODEL（不是硬编码字符串）", async () => {
    // 第 1 次 fetch = embedding → 返 1536 维向量
    // 第 2 次 fetch = chat → 返 [N] 答案
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ vectors: [new Array(1536).fill(0.01)] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "建议循序渐进断奶 [1]。" } }],
        }),
      } as Response);

    const ev = makeEvent({ q: "宝宝什么时候断奶" });
    const res = await askMain(ev);

    expect(res.statusCode).toBe(200);
    // 验证 fetch 被调了 2 次
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 验证 embedding call 用 env.EMBED_MODEL（默认 embo-01）
    const embedCall = fetchMock.mock.calls[0]!;
    expect(JSON.parse(embedCall[1]!.body as string).model).toBe("embo-01");
    // 验证 chat call 用 env.LLM_MODEL（默认 MiniMax-Text-01）
    const chatCall = fetchMock.mock.calls[1]!;
    expect(JSON.parse(chatCall[1]!.body as string).model).toBe("MiniMax-Text-01");
  });

  it("D-1: env.LLM_MODEL/EMBED_MODEL override 生效", async () => {
    resetEnv();
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
      // 覆盖
      LLM_MODEL: "MiniMax-Pro-01",
      EMBED_MODEL: "embo-02",
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ vectors: [new Array(1536).fill(0.02)] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok [1]." } }] }),
      } as Response);

    const ev = makeEvent({ q: "q" });
    await askMain(ev);

    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).model).toBe("embo-02");
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).model).toBe("MiniMax-Pro-01");
  });

  it("D-2-a: 答案 [N] 解析 → citations 包含 title/snippet/chunkId", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ vectors: [new Array(1536).fill(0.99)] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: "宝宝 6 个月可尝试断奶[1]，循序渐进最关键[2]。",
            },
          }],
        }),
      } as Response);

    const ev = makeEvent({ q: "宝宝什么时候断奶" });
    const res = await askMain(ev);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // 答案原文保留 [N] 标记（不再 strip）
    expect(body.answer).toContain("[1]");
    expect(body.answer).toContain("[2]");
    // 旧的 {"citations": [...]} JSON 块已不在答案里
    expect(body.answer).not.toContain('{"citations":');

    // citations 来自 citedNums 解析
    expect(body.citations).toHaveLength(2);
    expect(body.citations[0].n).toBe(1);
    expect(body.citations[0].title).toBe("宝宝断奶指南");
    expect(body.citations[0].snippet).toContain("断奶");
    expect(body.citations[0].chunkId).toBe("01K_CHUNK_1");
    expect(body.citations[1].n).toBe(2);
    expect(body.citations[1].chunkId).toBe("01K_CHUNK_2");
  });

  it("D-2-a: 越界 [9] 被过滤，valid subset 返回", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ vectors: [new Array(1536).fill(0.5)] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "答案 [1] [9]" } }],
        }),
      } as Response);

    const ev = makeEvent({ q: "q" });
    const res = await askMain(ev);
    const body = JSON.parse(res.body);

    // 越界 9 被过滤，只剩 [1]
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0].n).toBe(1);
  });

  it("D-2-a: 答案无 [N] → citations = []（不报错）", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ vectors: [new Array(1536).fill(0.5)] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "答案没有任何引用。" } }],
        }),
      } as Response);

    const ev = makeEvent({ q: "q" });
    const res = await askMain(ev);
    const body = JSON.parse(res.body);

    expect(body.answer).toBe("答案没有任何引用。");
    expect(body.citations).toEqual([]);
  });

  it("MiniMax API 失败 → 502 MINIMAX_FAILED", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ vectors: [new Array(1536).fill(0.5)] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "service unavailable",
      } as Response);

    const ev = makeEvent({ q: "q" });
    const res = await askMain(ev);
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(502);
    expect(body.error).toBe("MINIMAX_FAILED");
  });
});
