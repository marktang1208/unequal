/**
 * apps/miniprogram/lib/citation-parser 单测（CP-7-B）
 *
 * 6 用例覆盖核心场景（与后端 api-chat.parseAnswerSegments 对称）。
 */

import { describe, it, expect } from "vitest";
import { parseAnswerSegments, extractCitedNums } from "../lib/citation-parser.js";

describe("parseAnswerSegments (CP-7-B)", () => {
  it("无 [N] → 1 text segment", () => {
    const r = parseAnswerSegments("宝宝发烧建议多喝水");
    expect(r).toEqual([{ type: "text", text: "宝宝发烧建议多喝水" }]);
  });

  it("[1] → 1 cite segment with n=1", () => {
    const r = parseAnswerSegments("答案 [1]");
    expect(r).toEqual([
      { type: "text", text: "答案 " },
      { type: "cite", n: 1 },
    ]);
  });

  it("[1][2] → 2 cite segments", () => {
    const r = parseAnswerSegments("答案 [1][2]");
    expect(r).toEqual([
      { type: "text", text: "答案 " },
      { type: "cite", n: 1 },
      { type: "cite", n: 2 },
    ]);
  });

  it("混合: text + cite + text", () => {
    const r = parseAnswerSegments("前面 [2] 中间 [4] 后面");
    expect(r).toEqual([
      { type: "text", text: "前面 " },
      { type: "cite", n: 2 },
      { type: "text", text: " 中间 " },
      { type: "cite", n: 4 },
      { type: "text", text: " 后面" },
    ]);
  });

  it("[abc] 非数字 → 不 split，整段保留为 text", () => {
    // 正则 /\[\d+\]/g 只匹配数字，所以 [abc] 不 split，整个 "答案 [abc] " 是 text
    const r = parseAnswerSegments("答案 [abc] [1]");
    expect(r).toEqual([
      { type: "text", text: "答案 [abc] " },
      { type: "cite", n: 1 },
    ]);
  });

  it("空字符串 → []", () => {
    expect(parseAnswerSegments("")).toEqual([]);
  });

  it("[0] → split 后当 text 渲染（n=0 不合法）", () => {
    // 正则匹配 [0] → split 成 3 段；[0] 被识别为 n=0 → 兜底为 text
    const r = parseAnswerSegments("答案 [0] 引用");
    expect(r).toEqual([
      { type: "text", text: "答案 " },
      { type: "text", text: "[0]" },
      { type: "text", text: " 引用" },
    ]);
  });
});

describe("extractCitedNums (CP-7-B)", () => {
  it("提取 [1][3] → [1, 3]", () => {
    expect(extractCitedNums("答案 [1] 又 [3]")).toEqual([1, 3]);
  });

  it("去重: [1][1][1] → [1]", () => {
    expect(extractCitedNums("[1] [1] [1]")).toEqual([1]);
  });

  it("0 个 → []", () => {
    expect(extractCitedNums("无引用")).toEqual([]);
  });

  it("乱序 [3][1] → [3, 1]（保 first 顺序）", () => {
    expect(extractCitedNums("先 [3] 再 [1]")).toEqual([3, 1]);
  });
});