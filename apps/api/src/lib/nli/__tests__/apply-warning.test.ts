/**
 * apply-warning.test.ts — 6 cases (spec §11.1)
 *
 * 1. entailed → 返回原 cleaned
 * 2. neutral → 加 neutral prefix
 * 3. contradiction → 加 contradiction prefix
 * 4. cleaned 已有 "⚠️" → 不重复加
 * 5. cleaned 空 → 返回空
 * 6. prefix 长度 ≤ 60 字符
 */

import { describe, it, expect } from "vitest";
import { applyWarning } from "../apply-warning.js";
import type { NliVerdict } from "../types.js";

const entailedVerdict: NliVerdict = {
  verdict: "entailed",
  score: 0.9,
  scores: { entailment: 0.9, neutral: 0.05, contradiction: 0.05 },
  latencyMs: 80,
};

const neutralVerdict: NliVerdict = {
  verdict: "neutral",
  score: 0.6,
  scores: { entailment: 0.3, neutral: 0.6, contradiction: 0.1 },
  latencyMs: 100,
};

const contradictionVerdict: NliVerdict = {
  verdict: "contradiction",
  score: 0.7,
  scores: { entailment: 0.1, neutral: 0.2, contradiction: 0.7 },
  latencyMs: 90,
};

describe("applyWarning", () => {
  it("entailed → 返回原 cleaned 无 prefix", () => {
    const cleaned = "发烧 38.5 吃 0.4ml/kg";
    expect(applyWarning(cleaned, entailedVerdict)).toBe(cleaned);
  });

  it("neutral → 加 '部分未提及' prefix", () => {
    const cleaned = "建议就医";
    const result = applyWarning(cleaned, neutralVerdict);
    expect(result).toContain("⚠️ 以下回答部分参考资料未提及，请谨慎参考");
    expect(result).toContain(cleaned);
    expect(result.startsWith("⚠️")).toBe(true);
  });

  it("contradiction → 加 '存在冲突' prefix", () => {
    const cleaned = "不需要就医";
    const result = applyWarning(cleaned, contradictionVerdict);
    expect(result).toContain("⚠️ 以下回答与参考资料存在冲突，请谨慎参考");
    expect(result).toContain(cleaned);
  });

  it("cleaned 已有 '⚠️' → 不重复加", () => {
    const cleaned = "⚠️ custom warning\n\n发烧";
    const result = applyWarning(cleaned, neutralVerdict);
    expect(result).toBe(cleaned);
  });

  it("cleaned 是空字符串 → 返回空", () => {
    expect(applyWarning("", neutralVerdict)).toBe("");
    expect(applyWarning("", contradictionVerdict)).toBe("");
  });

  it("prefix 长度 ≤ 60 字符", () => {
    // sanity check: 实际 prefix 字符串没超 60 字符
    const result = applyWarning("test", neutralVerdict);
    const prefixEnd = result.indexOf("\n\n");
    const prefix = result.slice(0, prefixEnd);
    expect(prefix.length).toBeLessThanOrEqual(60);
  });
});
