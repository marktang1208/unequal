/**
 * api-chat handler 单元测试 — CP-7-B 重点：[N] 解析
 *
 * api-chat handler 强依赖 CloudBase DB + MiniMax embedding/chat，
 * 端到端测试由 admin ChatSim + minipgm 真接覆盖。
 * 本测试只覆盖 CP-7-B 新增的 [N] 解析 helper（export 出便于单测）。
 */

import { describe, it, expect } from "vitest";
import { parseAnswerSegments } from "../../src/handlers/api-chat.js";

describe("api-chat [N] 解析 (CP-7-B)", () => {
  it("happy: [1][3] → citedNums=[1,3]", () => {
    const r = parseAnswerSegments("宝宝发烧可能由病毒感染引起 [1] [2]。建议多喝水。", 5);
    expect(r.citedNums).toEqual([1, 2]);
  });

  it("happy: 全引 [1][2][3][4][5] → citedNums=[1,2,3,4,5]", () => {
    const r = parseAnswerSegments("答案 [1][2][3][4][5]", 5);
    expect(r.citedNums).toEqual([1, 2, 3, 4, 5]);
  });

  it("越界 [9] (top=5) → citedNums=[9] 但 rawNums=[9]（caller 过滤越界）", () => {
    const r = parseAnswerSegments("答案 [9]", 5);
    expect(r.citedNums).toEqual([9]); // helper 不过滤；调用方按 top.length 过滤
    expect(r.rawNums).toEqual([9]);
  });

  it("重复 [1][1][1] → citedNums=[1]（去重）", () => {
    const r = parseAnswerSegments("引用 [1][1][1] 又 [1]", 5);
    expect(r.citedNums).toEqual([1]);
  });

  it("0 个 → citedNums=[]", () => {
    const r = parseAnswerSegments("答案没有任何引用。", 5);
    expect(r.citedNums).toEqual([]);
  });

  it("乱序 [3][1] → citedNums=[3,1]（保持出现顺序）", () => {
    const r = parseAnswerSegments("先 [3] 再 [1]", 5);
    expect(r.citedNums).toEqual([3, 1]);
  });

  it("混合: 文字 + [2] + 文字 + [4]", () => {
    const r = parseAnswerSegments("前面 [2] 中间 [4]", 5);
    expect(r.citedNums).toEqual([2, 4]);
  });

  it("top=0: 任何 [N] 都越界", () => {
    const r = parseAnswerSegments("答案 [1]", 0);
    expect(r.rawNums).toEqual([1]);
    expect(r.citedNums).toEqual([1]); // helper 不过滤
  });

  it("非数字内容 [abc] 不解析", () => {
    const r = parseAnswerSegments("答案 [abc] [1]", 5);
    expect(r.citedNums).toEqual([1]);
  });
});