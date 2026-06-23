/**
 * transformers-provider.test.ts — 8 cases (spec §11.1)
 *
 * 1. entailment=0.9 → {verdict: "entailed", ...}
 * 2. entailment=0.3, neutral=0.6 → {verdict: "neutral", ...}
 * 3. contradiction=0.7 → {verdict: "contradiction", ...}
 * 4. pipeline reject → throw NliRuntimeError
 * 5. pipeline 3s 不返回 → throw NliTimeoutError
 * 6. 空 premise → throw NliRuntimeError
 * 7. 单例 cache：第二次调用复用同一 pipeline 实例
 *
 * mock 模式：pipeline() 返回一个 callable function（thunk），每次 verify 调一次
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPipeline, mockEnv } = vi.hoisted(() => ({
  mockPipeline: vi.fn(),
  mockEnv: { cacheDir: "/tmp/test-nli" },
}));

vi.mock("@xenova/transformers", () => ({
  pipeline: mockPipeline,
  env: mockEnv,
}));

import { TransformersNliProvider } from "../transformers-provider.js";
import { NliRuntimeError, NliTimeoutError } from "../errors.js";

type NliOutput = Array<{ label: string; score: number }>;
type CallablePipeline = (text: string) => Promise<NliOutput>;

/** 创建一个可调用的 mock pipeline，每次调用返回固定输出 */
function makeStaticPipeline(output: NliOutput): CallablePipeline {
  const fn = vi.fn(() => Promise.resolve(output)) as unknown as CallablePipeline;
  return fn;
}

/** 创建一个 reject 的 mock pipeline */
function makeRejectingPipeline(err: Error): CallablePipeline {
  return (() => Promise.reject(err)) as unknown as CallablePipeline;
}

/** 创建一个永远不返回的 mock pipeline（用于 timeout 测试）*/
function makeHangingPipeline(): CallablePipeline {
  return (() => new Promise(() => {})) as unknown as CallablePipeline;
}

describe("TransformersNliProvider", () => {
  beforeEach(() => {
    mockPipeline.mockReset();
  });

  it("entailment 最高 → verdict 'entailed'", async () => {
    mockPipeline.mockResolvedValue(
      makeStaticPipeline([
        { label: "entailment", score: 0.9 },
        { label: "neutral", score: 0.05 },
        { label: "contradiction", score: 0.05 },
      ]),
    );
    const provider = new TransformersNliProvider();
    const result = await provider.verify("p", "h");
    expect(result.verdict).toBe("entailed");
    expect(result.scores.entailment).toBe(0.9);
    expect(result.score).toBe(0.9);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("neutral 最高 → verdict 'neutral'", async () => {
    mockPipeline.mockResolvedValue(
      makeStaticPipeline([
        { label: "entailment", score: 0.3 },
        { label: "neutral", score: 0.6 },
        { label: "contradiction", score: 0.1 },
      ]),
    );
    const provider = new TransformersNliProvider();
    const result = await provider.verify("p", "h");
    expect(result.verdict).toBe("neutral");
    expect(result.score).toBe(0.6);
  });

  it("contradiction 最高 → verdict 'contradiction'", async () => {
    mockPipeline.mockResolvedValue(
      makeStaticPipeline([
        { label: "entailment", score: 0.1 },
        { label: "neutral", score: 0.2 },
        { label: "contradiction", score: 0.7 },
      ]),
    );
    const provider = new TransformersNliProvider();
    const result = await provider.verify("p", "h");
    expect(result.verdict).toBe("contradiction");
    expect(result.score).toBe(0.7);
  });

  it("pipeline reject → throw NliRuntimeError", async () => {
    mockPipeline.mockResolvedValue(makeRejectingPipeline(new Error("model corrupted")));
    const provider = new TransformersNliProvider();
    await expect(provider.verify("p", "h")).rejects.toThrow(NliRuntimeError);
  });

  it("pipeline 3s 不返回 → throw NliTimeoutError", async () => {
    mockPipeline.mockResolvedValue(makeHangingPipeline());
    const provider = new TransformersNliProvider("m", true, 100);
    await expect(provider.verify("p", "h")).rejects.toThrow(NliTimeoutError);
  });

  it("空 premise → throw NliRuntimeError", async () => {
    const provider = new TransformersNliProvider();
    await expect(provider.verify("", "h")).rejects.toThrow(NliRuntimeError);
  });

  it("空 hypothesis → throw NliRuntimeError", async () => {
    const provider = new TransformersNliProvider();
    await expect(provider.verify("p", "")).rejects.toThrow(NliRuntimeError);
  });

  it("单例 cache：两次 verify 复用同一 pipeline 实例", async () => {
    let inferenceCount = 0;
    const sharedInstance = (() => {
      const fn = ((_text: string) => {
        inferenceCount++;
        return Promise.resolve([
          { label: "entailment", score: 0.9 },
          { label: "neutral", score: 0.05 },
          { label: "contradiction", score: 0.05 },
        ]);
      }) as unknown as CallablePipeline;
      return fn;
    })();
    mockPipeline.mockResolvedValue(sharedInstance);

    const provider = new TransformersNliProvider();
    await provider.verify("p1", "h1");
    await provider.verify("p2", "h2");
    await provider.verify("p3", "h3");

    // pipeline() 应该只被调一次（单例 lazy init）
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    // sharedInstance 推理 3 次
    expect(inferenceCount).toBe(3);
  });
});
