import { describe, it, expect } from "vitest";
import { buildAskPrompt, ASK_SYSTEM_TEMPLATE, DISCLAIMER_TEXT, TRUST_LABELS } from "../src/prompt.js";

describe("buildAskPrompt", () => {
  const top3 = [
    { n: 1 as const, title: "美国儿科学会育儿百科", snippet: "三个月以下婴儿发烧应立即就医", trustLevel: 3 as const },
    { n: 2 as const, title: "崔玉涛：婴儿发烧的家庭处理", snippet: "婴儿发烧时先观察精神状态", trustLevel: 2 as const },
    { n: 3 as const, title: "宝爸笔记", snippet: "我家宝宝 5 个月时发烧 38.5", trustLevel: 1 as const },
  ];

  it("top3 → system 含 [1]/[2]/[3] + 信任标签", () => {
    const p = buildAskPrompt("5个月宝宝发烧38.5怎么办", { chunks: top3 });
    expect(p.system).toContain("[1] 《美国儿科学会育儿百科》/");
    expect(p.system).toContain("[2] 《崔玉涛：婴儿发烧的家庭处理》/");
    expect(p.system).toContain("[3] 《宝爸笔记》/");
    expect(p.system).toContain("(信源等级: 权威)");
    expect(p.system).toContain("(信源等级: 可信)");
    expect(p.system).toContain("(信源等级: 一般)");
  });

  it("system 含 ASK_SYSTEM_TEMPLATE 5 条硬约束", () => {
    const p = buildAskPrompt("q", { chunks: top3 });
    expect(p.system).toContain("【硬约束】");
    expect(p.system).toContain("不得使用任何不在参考资料里的常识");
    expect(p.system).toContain("答案末尾必须且只能输出一个 JSON 块");
    expect(p.system).toContain('{"citations": [N, M, ...]}');
    expect(p.system).toContain('"未在知识库中找到可靠来源"');
  });

  it("user prompt = 原问题", () => {
    const p = buildAskPrompt("5个月宝宝发烧38.5怎么办", { chunks: top3 });
    expect(p.user).toBe("5个月宝宝发烧38.5怎么办");
  });

  it("chunks 为空 → system 仍含模板（无 [N] 行）+ user 仍为问题", () => {
    const p = buildAskPrompt("q", { chunks: [] });
    expect(p.system).toContain(ASK_SYSTEM_TEMPLATE.split("{{CHUNKS}}")[0]);
    expect(p.system).not.toContain("[1] ");
    expect(p.user).toBe("q");
  });
});

describe("TRUST_LABELS", () => {
  it("4 个等级都有中文标签", () => {
    expect(TRUST_LABELS[0]).toBe("未评级");
    expect(TRUST_LABELS[1]).toBe("一般");
    expect(TRUST_LABELS[2]).toBe("可信");
    expect(TRUST_LABELS[3]).toBe("权威");
  });
});

describe("DISCLAIMER_TEXT", () => {
  it("是 spec §3.1 规定的字面文本", () => {
    expect(DISCLAIMER_TEXT).toBe(
      "以上信息来源于知识库内容，不构成医疗建议。具体情况请咨询专业儿科医生。"
    );
  });
});
