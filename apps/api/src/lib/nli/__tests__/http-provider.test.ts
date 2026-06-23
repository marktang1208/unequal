/**
 * http-provider.test.ts — 10 cases (spec §11.1)
 *
 * 1. 推理成功 e=0.85 → entailed
 * 2. 推理成功 n=0.6 最高 → neutral
 * 3. 推理成功 c=0.7 最高 → contradiction
 * 4. 三个分数和不为 1.0 → 归一化
 * 5. API 4xx → throw NliRuntimeError
 * 6. API timeout > 5s → throw NliTimeoutError
 * 7. 第一次 JSON 解析失败 → 1 次重试 (不同 temperature)
 * 8. 第二次 JSON 解析失败 → throw NliRuntimeError
 * 9. 空 premise / 空 hypothesis → throw NliRuntimeError
 * 10. 缺 apiKey → constructor throw NliConfigError
 *
 * mock fetch via vi.stubGlobal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpNliProvider } from "../http-provider.js";
import { NliConfigError, NliRuntimeError, NliTimeoutError } from "../errors.js";

function makeFetchResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  } as unknown as Response;
}

describe("HttpNliProvider", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("推理成功 e=0.85 → entailed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(200, {
        choices: [{ message: { content: '{"entailment":0.85,"neutral":0.10,"contradiction":0.05}' } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "test/model", 5000, 0);
    const result = await provider.verify("premise", "hypothesis");

    expect(result.verdict).toBe("entailed");
    expect(result.scores.entailment).toBeCloseTo(0.85, 2);
    expect(result.score).toBeCloseTo(0.85, 2);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("推理成功 n=0.6 最高 → neutral", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(200, {
        choices: [{ message: { content: '{"entailment":0.3,"neutral":0.6,"contradiction":0.1}' } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    const result = await provider.verify("p", "h");

    expect(result.verdict).toBe("neutral");
    expect(result.score).toBeCloseTo(0.6, 2);
  });

  it("推理成功 c=0.7 最高 → contradiction", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(200, {
        choices: [{ message: { content: '{"entailment":0.1,"neutral":0.2,"contradiction":0.7}' } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    const result = await provider.verify("p", "h");

    expect(result.verdict).toBe("contradiction");
    expect(result.score).toBeCloseTo(0.7, 2);
  });

  it("分数和不为 1.0 → 归一化", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(200, {
        // 总和 = 2.0，应归一化到 1.0
        choices: [{ message: { content: '{"entailment":1.0,"neutral":0.5,"contradiction":0.5}' } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    const result = await provider.verify("p", "h");

    // 1.0 + 0.5 + 0.5 = 2.0，归一化
    expect(result.scores.entailment).toBeCloseTo(0.5, 2);
    expect(result.scores.neutral).toBeCloseTo(0.25, 2);
    expect(result.scores.contradiction).toBeCloseTo(0.25, 2);
  });

  it("API 4xx → throw NliRuntimeError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(401, "Unauthorized: invalid api key"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-bad", "https://api.test/v1", "m", 5000, 0);
    await expect(provider.verify("p", "h")).rejects.toThrow(NliRuntimeError);
  });

  it("API timeout > 5s → throw NliTimeoutError", async () => {
    // 用 vi.useFakeTimers + AbortSignal 模拟超时
    const fetchMock = vi.fn().mockImplementation((_url, opts) => {
      return new Promise<Response>((_, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 50, 0);
    await expect(provider.verify("p", "h")).rejects.toThrow(NliTimeoutError);
  });

  it("第一次 JSON 解析失败 → 1 次重试 (不同 temperature)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeFetchResponse(200, {
          choices: [{ message: { content: "not valid json" } }],
        }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse(200, {
          choices: [{ message: { content: '{"entailment":0.9,"neutral":0.05,"contradiction":0.05}' } }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 1);
    const result = await provider.verify("p", "h");

    expect(result.verdict).toBe("entailed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 第 2 次调用 temperature 应该是 0.2（重试）
    const secondCallBody = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(secondCallBody.temperature).toBe(0.2);
  });

  it("第二次 JSON 解析失败 → throw NliRuntimeError", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse(200, { choices: [{ message: { content: "bad" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 1);
    await expect(provider.verify("p", "h")).rejects.toThrow(NliRuntimeError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("空 premise → throw NliRuntimeError", async () => {
    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    await expect(provider.verify("", "h")).rejects.toThrow(NliRuntimeError);
  });

  it("空 hypothesis → throw NliRuntimeError", async () => {
    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    await expect(provider.verify("p", "")).rejects.toThrow(NliRuntimeError);
  });

  it("缺 apiKey → constructor throw NliConfigError", () => {
    expect(() => new HttpNliProvider("")).toThrow(NliConfigError);
    expect(() => new HttpNliProvider("")).toThrow(/apiKey/);
  });
});
