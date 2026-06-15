import { describe, it, expect } from "vitest";
import { verifyCitations } from "../src/cite-verify.js";

describe("verifyCitations", () => {
  it("happy: 文本引 1,3 + JSON 引 1,3 → verified=[1,3]", () => {
    const answer = "5个月宝宝腋温 38.5°C 建议先 [来源 1] [来源 3]\n\n{\"citations\":[1,3]}";
    const r = verifyCitations(answer);
    expect(r.textCitations).toEqual([1, 3]);
    expect(r.jsonCitations).toEqual([1, 3]);
    expect(r.verified).toEqual([1, 3]);
    expect(r.malformed).toBe(false);
  });

  it("cite_mismatch: 文本引 1 但 JSON 引 2 → verified=[]", () => {
    const answer = "5个月宝宝 [来源 1] ...\n\n{\"citations\":[2]}";
    const r = verifyCitations(answer);
    expect(r.textCitations).toEqual([1]);
    expect(r.jsonCitations).toEqual([2]);
    expect(r.verified).toEqual([]);
    expect(r.malformed).toBe(false);
  });

  it("malformed_json: 有 citations 关键字但 JSON 坏 → verified=[], malformed=true", () => {
    const answer = "... [来源 1] ...\n\n{\"citations\": not valid json}";
    const r = verifyCitations(answer);
    expect(r.verified).toEqual([]);
    expect(r.malformed).toBe(true);
  });

  it("越界编号: 文本引 100 + JSON 引 100 → 都被过滤 → verified=[]", () => {
    const answer = "... [来源 100] ...\n\n{\"citations\":[100]}";
    const r = verifyCitations(answer);
    expect(r.textCitations).toEqual([]);
    expect(r.jsonCitations).toEqual([]);
    expect(r.verified).toEqual([]);
    expect(r.malformed).toBe(false);
  });
});