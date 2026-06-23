/**
 * noop-provider.test.ts — 3 cases (spec §11.1)
 *
 * 1. 任意输入 → {verdict: "entailed", score: 1, scores: {all: 1}}
 * 2. 不抛错
 * 3. 不写 console
 */

import { describe, it, expect, vi } from "vitest";
import { NoopNliProvider } from "../noop-provider.js";

describe("NoopNliProvider", () => {
  it("任意输入返回 entailed score=1", async () => {
    const provider = new NoopNliProvider();
    const result = await provider.verify("发烧 38.5 吃多少 ml", "美林剂量标准 0.4ml/kg");
    expect(result.verdict).toBe("entailed");
    expect(result.score).toBe(1);
    expect(result.scores).toEqual({ entailment: 1, neutral: 0, contradiction: 0 });
    expect(result.latencyMs).toBe(0);
  });

  it("空输入也不抛错", async () => {
    const provider = new NoopNliProvider();
    await expect(provider.verify("", "")).resolves.toBeDefined();
  });

  it("不写 console.warn / console.error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = new NoopNliProvider();
    await provider.verify("a", "b");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("name 字段是 'noop'", () => {
    const provider = new NoopNliProvider();
    expect(provider.name).toBe("noop");
  });
});
