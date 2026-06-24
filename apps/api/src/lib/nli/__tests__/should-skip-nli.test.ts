/**
 * should-skip-nli.test.ts — P5 v1.2 短答案跳过 NLI (spec §2.4, §4.1)
 *
 * 1. cleaned.length < minLen → true (跳过)
 * 2. cleaned.length === minLen → false (调,边界)
 * 3. cleaned.length > minLen → false (调)
 * 4. 空字符串 → true (跳过,边界)
 * 5. envOverride 优先于 env
 * 6. env NLI_MIN_ANSWER_LEN 读取
 * 7. env 缺省 / 无效值 → 默认 100
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  shouldSkipNli,
  getNliMinAnswerLen,
  DEFAULT_NLI_MIN_ANSWER_LEN,
} from "../should-skip-nli.js";

describe("shouldSkipNli", () => {
  it("cleaned.length < minLen → true (跳过)", () => {
    expect(shouldSkipNli("短答案", 100)).toBe(true);
    expect(shouldSkipNli("a".repeat(99), 100)).toBe(true);
  });

  it("cleaned.length === minLen → false (调,边界含等号)", () => {
    expect(shouldSkipNli("a".repeat(100), 100)).toBe(false);
  });

  it("cleaned.length > minLen → false (调)", () => {
    expect(shouldSkipNli("a".repeat(101), 100)).toBe(false);
    expect(shouldSkipNli("a".repeat(500), 100)).toBe(false);
  });

  it("空字符串 → true (跳过,边界)", () => {
    expect(shouldSkipNli("", 100)).toBe(true);
    expect(shouldSkipNli("", 0)).toBe(false); // 阈值为 0 时空串也算
  });

  it("阈值 0 → 所有 cleaned 都调 NLI(等同 v1.1 行为)", () => {
    expect(shouldSkipNli("", 0)).toBe(false);
    expect(shouldSkipNli("任何字符", 0)).toBe(false);
  });

  it("中文场景 cleaned 长度按字符数计(JS .length 对中文=1)", () => {
    // "美林剂量0.4ml/kg,同时注意观察精神状态。" = 18 个字符(含中文标点)
    const short = "美林剂量0.4ml/kg,同时注意观察精神状态。";
    expect(shouldSkipNli(short, 100)).toBe(true);
    // 200 字中文(典型长答案)
    const long = "美林剂量".repeat(50);
    expect(shouldSkipNli(long, 100)).toBe(false);
  });
});

describe("getNliMinAnswerLen", () => {
  const originalEnv = process.env.NLI_MIN_ANSWER_LEN;

  beforeEach(() => {
    delete process.env.NLI_MIN_ANSWER_LEN;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NLI_MIN_ANSWER_LEN;
    else process.env.NLI_MIN_ANSWER_LEN = originalEnv;
  });

  it("envOverride 优先于 env", () => {
    process.env.NLI_MIN_ANSWER_LEN = "500";
    expect(getNliMinAnswerLen(200)).toBe(200);
  });

  it("env NLI_MIN_ANSWER_LEN=200 → 200", () => {
    process.env.NLI_MIN_ANSWER_LEN = "200";
    expect(getNliMinAnswerLen()).toBe(200);
  });

  it("env 缺省 → 默认 100", () => {
    expect(getNliMinAnswerLen()).toBe(DEFAULT_NLI_MIN_ANSWER_LEN);
    expect(DEFAULT_NLI_MIN_ANSWER_LEN).toBe(100);
  });

  it("env 空字符串 → 默认 100", () => {
    process.env.NLI_MIN_ANSWER_LEN = "";
    expect(getNliMinAnswerLen()).toBe(DEFAULT_NLI_MIN_ANSWER_LEN);
  });

  it("env 无效字符串 → 默认 100", () => {
    process.env.NLI_MIN_ANSWER_LEN = "abc";
    expect(getNliMinAnswerLen()).toBe(DEFAULT_NLI_MIN_ANSWER_LEN);
  });

  it("env 负数 → 默认 100(避免阈值倒挂误判)", () => {
    process.env.NLI_MIN_ANSWER_LEN = "-5";
    expect(getNliMinAnswerLen()).toBe(DEFAULT_NLI_MIN_ANSWER_LEN);
  });

  it("env 0 → 0(允许完全跳过阈值,即所有都调 NLI,v1.1 行为)", () => {
    process.env.NLI_MIN_ANSWER_LEN = "0";
    expect(getNliMinAnswerLen()).toBe(0);
  });
});