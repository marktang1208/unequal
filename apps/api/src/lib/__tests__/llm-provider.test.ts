/**
 * llm-provider.test.ts — TDD for max_tokens support (P7 follow-up #5)
 *
 * 覆盖 6 cases:
 *   1. ChatRequest.maxTokens 透传到 fetch body.max_tokens
 *   2. 不传 maxTokens → 用 env.LLM_MAX_TOKENS (mock env) → body.max_tokens = env value
 *   3. env LLM_MAX_TOKENS 未设 → 默认 2048 (safety net)
 *   4. fetch body 包含 max_tokens (不论来源)
 *   5. fetch body 包含 temperature (现有行为, regression)
 *   6. chat success 仍正常 (mock fetch OK)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getChatProvider, resetProviders } from "../llm-provider.js";
import * as envModule from "../env.js";

function makeFetchResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe("getChatProvider — max_tokens support (P7 #5)", () => {
  beforeEach(() => {
    resetProviders();
    // 默认 mock env LLM_MAX_TOKENS
    vi.spyOn(envModule, "getEnv").mockReturnValue({
      // 必填字段 stub
      MINIMAX_API_KEY: "test-key",
      MINIMAX_BASE_URL: "https://api.minimax.chat/v1",
      LLM_MODEL: "MiniMax-Text-01",
      LLM_MAX_TOKENS: 2048, // ← 测试 default
    } as ReturnType<typeof envModule.getEnv>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetProviders();
  });

  it("ChatRequest.maxTokens 显式传 → fetch body.max_tokens = 传入值", async () => {
    const fetchMock = vi.fn(async () => makeFetchResponse({
      choices: [{ message: { content: "ok" } }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getChatProvider().chat({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 512,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.max_tokens).toBe(512);
  });

  it("不传 maxTokens → body.max_tokens = env.LLM_MAX_TOKENS (=2048)", async () => {
    const fetchMock = vi.fn(async () => makeFetchResponse({
      choices: [{ message: { content: "ok" } }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getChatProvider().chat({
      messages: [{ role: "user", content: "hi" }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.max_tokens).toBe(2048);
  });

  it("env LLM_MAX_TOKENS = 1024 → body.max_tokens = 1024 (env 优先)", async () => {
    vi.spyOn(envModule, "getEnv").mockReturnValue({
      MINIMAX_API_KEY: "test-key",
      MINIMAX_BASE_URL: "https://api.minimax.chat/v1",
      LLM_MODEL: "MiniMax-Text-01",
      LLM_MAX_TOKENS: 1024,
    } as ReturnType<typeof envModule.getEnv>);
    resetProviders();

    const fetchMock = vi.fn(async () => makeFetchResponse({
      choices: [{ message: { content: "ok" } }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getChatProvider().chat({
      messages: [{ role: "user", content: "hi" }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.max_tokens).toBe(1024);
  });

  it("env LLM_MAX_TOKENS 未设 → 默认 2048 (safety net)", async () => {
    vi.spyOn(envModule, "getEnv").mockReturnValue({
      MINIMAX_API_KEY: "test-key",
      MINIMAX_BASE_URL: "https://api.minimax.chat/v1",
      LLM_MODEL: "MiniMax-Text-01",
      // LLM_MAX_TOKENS undefined
    } as unknown as ReturnType<typeof envModule.getEnv>);
    resetProviders(); // ← 必须 reset, 否则上一 case 的单例闭包缓存 defaultMaxTokens=1024

    const fetchMock = vi.fn(async () => makeFetchResponse({
      choices: [{ message: { content: "ok" } }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getChatProvider().chat({
      messages: [{ role: "user", content: "hi" }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.max_tokens).toBe(2048);
  });

  it("body 仍包含 model + messages + temperature (regression)", async () => {
    const fetchMock = vi.fn(async () => makeFetchResponse({
      choices: [{ message: { content: "ok" } }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getChatProvider().chat({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      temperature: 0.5,
      maxTokens: 800,
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("MiniMax-Text-01");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(800);
  });

  it("chat success → 返回 content", async () => {
    const fetchMock = vi.fn(async () => makeFetchResponse({
      choices: [{ message: { content: "answer here" } }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getChatProvider().chat({
      messages: [{ role: "user", content: "q" }],
    });

    expect(result.content).toBe("answer here");
  });
});