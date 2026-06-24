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

  // ── P5 v1.1 真接 production bug fix (2026-06-24) ────────────
  // Qwen2.5-7B-Instruct 真接始终返 {label, score} 格式
  // （真接验证 4/5 case 完美工作），不是 spec 设计的 {entailment, neutral, contradiction}
  // 三个分数格式。单元测试原 mock 假设错，导致 production 100% 解析失败 → fail-open
  // 降级 verdict=entailed → NLI 后置验证从未生效。修复后兼容 label+score。

  it("Qwen 真接格式: {label:'entailment', score:0.8} → entailed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(200, {
        choices: [
          { message: { content: '{"label":"entailment","score":0.8}' } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    const result = await provider.verify("p", "h");

    expect(result.verdict).toBe("entailed");
    // label=entailment, score=0.8 → e=0.8, n=c=(1-0.8)/2=0.1
    expect(result.scores.entailment).toBeCloseTo(0.8, 2);
    expect(result.scores.neutral).toBeCloseTo(0.1, 2);
    expect(result.scores.contradiction).toBeCloseTo(0.1, 2);
    // 归一化后 sum=1.0
    const sum =
      result.scores.entailment +
      result.scores.neutral +
      result.scores.contradiction;
    expect(sum).toBeCloseTo(1.0, 2);
  });

  it("Qwen 真接格式: {label:'neutral', score:0.5} → neutral", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(200, {
        choices: [
          { message: { content: '{"label":"neutral","score":0.5}' } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    const result = await provider.verify("p", "h");

    expect(result.verdict).toBe("neutral");
    expect(result.scores.neutral).toBeCloseTo(0.5, 2);
  });

  it("Qwen 真接格式: {label:'contradiction', score:0.9} → contradiction", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(200, {
        choices: [
          { message: { content: '{"label":"contradiction","score":0.9}' } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    const result = await provider.verify("p", "h");

    expect(result.verdict).toBe("contradiction");
    expect(result.scores.contradiction).toBeCloseTo(0.9, 2);
  });

  it("Qwen 偶发格式: label 字符串但 score 缺失 → 用 unit score 0.8 兜底", async () => {
    // Qwen 偶发返 `{"label":"contradiction","," ,"score":...}` 这种 typo，
    // JSON parse 后只剩 label 字段。本测试模拟 parse 后的中间状态。
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(200, {
        choices: [
          { message: { content: '{"label":"contradiction"}' } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    const result = await provider.verify("p", "h");

    expect(result.verdict).toBe("contradiction");
    // score=0.8 兜底 → c=0.8, e=n=0.1
    expect(result.scores.contradiction).toBeCloseTo(0.8, 2);
  });

  it("未知 label 字符串 → throw NliRuntimeError (不兜底未知语义)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(200, {
        choices: [
          { message: { content: '{"label":"foobar","score":0.5}' } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    await expect(provider.verify("p", "h")).rejects.toThrow(NliRuntimeError);
  });

  it("未识别 schema (无 label 也没三 score) → throw NliRuntimeError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(200, {
        choices: [
          { message: { content: '{"foo":"bar","baz":0.1}' } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    await expect(provider.verify("p", "h")).rejects.toThrow(NliRuntimeError);
  });

  // ── P5 v1.1 真接 production bug fix #3 (2026-06-24) ────────────
  // Qwen 偶发返 label 缩写 "ent" / "neu" / "con" (单次 1.4s 内返，score=0.7-0.8，
  // 但 label 不在原白名单),触发 NliRuntimeError。修复：接受 ent/neu/con + startsWith 前缀。

  it("Qwen 缩写 label 'ent' → 仍归一化到 entailed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(200, {
        choices: [
          { message: { content: '{"label":"ent","score":0.75}' } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    const result = await provider.verify("p", "h");

    expect(result.verdict).toBe("entailed");
    expect(result.scores.entailment).toBeCloseTo(0.75, 2);
  });

  it("Qwen 缩写 label 'neu' → neutral", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(200, {
        choices: [
          { message: { content: '{"label":"neu","score":0.6}' } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    const result = await provider.verify("p", "h");

    expect(result.verdict).toBe("neutral");
    expect(result.scores.neutral).toBeCloseTo(0.6, 2);
  });

  it("Qwen 缩写 label 'con' → contradiction", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(200, {
        choices: [
          { message: { content: '{"label":"con","score":0.85}' } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    const result = await provider.verify("p", "h");

    expect(result.verdict).toBe("contradiction");
    expect(result.scores.contradiction).toBeCloseTo(0.85, 2);
  });

  it("label 'entailments' (复数变体) → 仍归一化到 entailed (startsWith 匹配)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeFetchResponse(200, {
        choices: [
          { message: { content: '{"label":"entailments","score":0.7}' } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpNliProvider("sk-test", "https://api.test/v1", "m", 5000, 0);
    const result = await provider.verify("p", "h");

    expect(result.verdict).toBe("entailed");
  });
});
