/**
 * CP-7-D #2: API 端 LLM Provider factory 单元测试
 *
 * 验证：
 * 1. getEmbedder 懒加载 + 单例（同 env 返同实例）
 * 2. getChatProvider 懒加载 + 单例
 * 3. resetProviders 清空单例
 * 4. __setEmbedderForTest / __setChatProviderForTest 注入 mock 后 getEmbedder/getChatProvider 返 mock
 * 5. chat 真发 HTTP（mock globalThis.fetch 验证 URL/headers/body）
 * 6. chat 失败：fetch 返非 2xx → throw 含 status + body
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const testEnv = {
  MINIMAX_API_KEY: "sk-test",
  MINIMAX_BASE_URL: "https://api.test/v1",
  EMBED_MODEL: "embo-01",
  LLM_MODEL: "MiniMax-Text-01",
  ADMIN_TOKEN: "x",
  JWT_SECRET: "x".repeat(32),
  KEK_SECRET_V1: "x".repeat(32),
  ENVIRONMENT: "test",
  ALLOWED_ORIGIN: "*",
  ADMIN_IP_ALLOWLIST: "127.0.0.1",
  DEFAULT_USER_ID: "u1",
  KEK_CURRENT_VERSION: "1",
};

vi.mock("../../src/lib/env.js", () => ({
  getEnv: () => testEnv,
}));

import {
  getEmbedder,
  getChatProvider,
  __setEmbedderForTest,
  __setChatProviderForTest,
  resetProviders,
  type ChatRequest,
  type ChatResponse,
} from "../../src/lib/llm-provider.js";

describe("API LLM Provider factory (CP-7-D #2)", () => {
  beforeEach(() => {
    resetProviders();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetProviders();
  });

  it("getEmbedder 懒加载 + 单例：两次调返同实例", () => {
    const a = getEmbedder();
    const b = getEmbedder();
    expect(a).toBe(b);
  });

  it("getChatProvider 懒加载 + 单例", () => {
    const a = getChatProvider();
    const b = getChatProvider();
    expect(a).toBe(b);
  });

  it("resetProviders 清空单例：重置后 getEmbedder 返新实例", () => {
    const a = getEmbedder();
    resetProviders();
    const b = getEmbedder();
    expect(a).not.toBe(b);
  });

  it("__setEmbedderForTest 注入 mock 后 getEmbedder 返 mock", () => {
    const mockEmbedder = { embed: vi.fn(async () => [[0.1, 0.2]]) };
    __setEmbedderForTest(mockEmbedder);
    expect(getEmbedder()).toBe(mockEmbedder);
  });

  it("__setChatProviderForTest 注入 mock 后 getChatProvider 返 mock", () => {
    const mockChat: { chat: (req: ChatRequest) => Promise<ChatResponse> } = {
      chat: vi.fn(async () => ({ content: "mocked" })),
    };
    __setChatProviderForTest(mockChat);
    expect(getChatProvider()).toBe(mockChat);
  });

  it("getChatProvider 真发 HTTP：fetch mock 收到正确 URL/headers/body", async () => {
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      // 验证 URL
      expect(input).toBe("https://api.test/v1/chat/completions");
      // 验证 headers
      const headers = init?.headers ?? {};
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers.authorization).toBe("Bearer sk-test");
      // 验证 body
      const body = JSON.parse(init?.body);
      expect(body.model).toBe("MiniMax-Text-01");
      expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
      expect(body.temperature).toBe(0.3);
      // 返 mock 响应
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Hello!" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = getChatProvider();
    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBe("Hello!");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getChatProvider 接受 model override", async () => {
    const fetchMock = vi.fn(async (_input: any, init?: any) => {
      const body = JSON.parse(init?.body);
      expect(body.model).toBe("custom-model-7");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = getChatProvider();
    await provider.chat({
      messages: [{ role: "user", content: "x" }],
      model: "custom-model-7",
      temperature: 0.7,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getChatProvider 接受 temperature override", async () => {
    const fetchMock = vi.fn(async (_input: any, init?: any) => {
      const body = JSON.parse(init?.body);
      expect(body.temperature).toBe(0.9);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = getChatProvider();
    await provider.chat({
      messages: [{ role: "user", content: "x" }],
      temperature: 0.9,
    });
  });

  it("getChatProvider 失败：fetch 返 500 → throw 含 status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("server error detail", { status: 500 })),
    );

    const provider = getChatProvider();
    await expect(
      provider.chat({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/chat failed: 500/);
  });

  it("getChatProvider 失败：fetch 返 401 → throw 含 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );

    const provider = getChatProvider();
    await expect(
      provider.chat({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/401/);
  });

  it("getChatProvider 响应无 choices → content 返空串", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );

    const provider = getChatProvider();
    const result = await provider.chat({ messages: [{ role: "user", content: "x" }] });
    expect(result.content).toBe("");
  });

  it("getChatProvider 响应 choices[0].message.content 缺失 → content 返空串", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: {} }] }),
            { status: 200 },
          ),
      ),
    );

    const provider = getChatProvider();
    const result = await provider.chat({ messages: [{ role: "user", content: "x" }] });
    expect(result.content).toBe("");
  });
});
