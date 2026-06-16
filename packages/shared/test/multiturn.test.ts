import { describe, it, expect } from "vitest";
import {
  buildMultiturnPrefix,
  groupIntoRounds,
  DEFAULT_WINDOW_SIZE,
  DEFAULT_SUMMARY_FALLBACK_CHARS,
  type MultiturnMessage,
} from "../src/multiturn.js";

// 构造 N 轮完整对话（每轮 user + assistant），方便复用
function makeRounds(count: number): MultiturnMessage[] {
  const out: MultiturnMessage[] = [];
  for (let i = 0; i < count; i++) {
    const t = 1000 + i * 100;
    out.push({ role: "user", content: `问 ${i + 1}`, created_at: t });
    out.push({
      role: "assistant",
      content: `回答 ${i + 1} 的完整长内容，这里是一段超过 50 字的回答文本用于验证截断逻辑。`,
      summary: `摘要 ${i + 1}`,
      created_at: t + 50,
    });
  }
  return out;
}

describe("buildMultiturnPrefix", () => {
  it("0 轮历史 → 空 prefix", () => {
    expect(buildMultiturnPrefix([])).toBe("");
  });

  it("1 轮 → 1 段 context", () => {
    const msgs = makeRounds(1);
    const prefix = buildMultiturnPrefix(msgs);
    expect(prefix).toContain("[第 1 轮]");
    expect(prefix).toContain("用户: 问 1");
    expect(prefix).toContain("助手: 摘要 1");
    expect(prefix).not.toContain("[第 2 轮]");
  });

  it("5 轮 → 截断到最近 3 轮（默认 windowSize）", () => {
    const msgs = makeRounds(5);
    const prefix = buildMultiturnPrefix(msgs);
    expect(prefix).toContain("[第 1 轮]");
    expect(prefix).toContain("[第 2 轮]");
    expect(prefix).toContain("[第 3 轮]");
    expect(prefix).not.toContain("[第 4 轮]");
    expect(prefix).not.toContain("[第 5 轮]");
    // 保留最后 3 轮：3、4、5
    expect(prefix).toContain("用户: 问 3");
    expect(prefix).toContain("用户: 问 5");
    expect(prefix).not.toContain("用户: 问 1");
    expect(prefix).not.toContain("用户: 问 2");
  });

  it("7 轮 → 截断到 3 轮", () => {
    const msgs = makeRounds(7);
    const prefix = buildMultiturnPrefix(msgs, DEFAULT_WINDOW_SIZE);
    expect(prefix).toContain("[第 1 轮]");
    expect(prefix).toContain("[第 2 轮]");
    expect(prefix).toContain("[第 3 轮]");
    expect(prefix).not.toContain("[第 4 轮]");
    expect(prefix).toContain("用户: 问 5");
    expect(prefix).toContain("用户: 问 6");
    expect(prefix).toContain("用户: 问 7");
  });

  it("assistant 无 summary → fallback 到 content 前 50 字", () => {
    // fixture 必须 > 50 char，且 "末段标记XYZ123" 放在 50 char 之后，
    // 这样 slice(0, 50) 不会包含它，not.toContain 才有意义。
    const longContent =
      "宝宝发烧38.5以下可以物理降温，温水擦浴腋下腹股沟减衣观察精神状态。发热持续上升需就医。末段标记XYZ123";
    const msgs: MultiturnMessage[] = [
      { role: "user", content: "宝宝发烧怎么办", created_at: 1 },
      { role: "assistant", content: longContent, created_at: 2 },
    ];
    const prefix = buildMultiturnPrefix(msgs);
    expect(prefix).toContain("用户: 宝宝发烧怎么办");
    // summary 缺 → fallback 到 content.slice(0, 50)
    const expectedSummary = msgs[1]!.content.slice(0, DEFAULT_SUMMARY_FALLBACK_CHARS);
    expect(prefix).toContain(`助手: ${expectedSummary}`);
    // 不应包含 50 字之后的内容
    expect(prefix).not.toContain("末段标记XYZ123");
  });

  it("单 round 缺 user → 跳过该 round（不完整 round 不进 prefix）", () => {
    const msgs: MultiturnMessage[] = [
      { role: "user", content: "第一问", created_at: 1 },
      { role: "assistant", content: "第一答", summary: "答1", created_at: 2 },
      // 缺 user，只来一个 assistant → 应被丢弃
      { role: "assistant", content: "孤立的 assistant", summary: "孤儿", created_at: 3 },
    ];
    const prefix = buildMultiturnPrefix(msgs);
    expect(prefix).toContain("用户: 第一问");
    expect(prefix).not.toContain("孤儿");
    expect(prefix).not.toContain("孤立的 assistant");
  });

  it("单 round 缺 assistant → 不形成 round（只 user 不进 prefix）", () => {
    const msgs: MultiturnMessage[] = [
      { role: "user", content: "第一问", created_at: 1 },
      { role: "assistant", content: "第一答", summary: "答1", created_at: 2 },
      { role: "user", content: "第二问（无答）", created_at: 3 },
    ];
    const prefix = buildMultiturnPrefix(msgs);
    expect(prefix).toContain("用户: 第一问");
    expect(prefix).toContain("用户: 第二问（无答）");
    // 没有形成 round 2
    expect(prefix).not.toContain("[第 2 轮]");
    expect(prefix).toContain("[第 1 轮]");
  });

  it("windowSize=0 → 空 prefix", () => {
    const msgs = makeRounds(5);
    expect(buildMultiturnPrefix(msgs, 0)).toBe("");
  });
});

describe("groupIntoRounds", () => {
  it("把 user+assistant 配对正确（标准情况）", () => {
    const msgs = makeRounds(3);
    const rounds = groupIntoRounds(msgs);
    expect(rounds).toHaveLength(3);
    expect(rounds[0]).toHaveLength(2);
    expect(rounds[0]![0]!.role).toBe("user");
    expect(rounds[0]![1]!.role).toBe("assistant");
    expect(rounds[0]![0]!.content).toBe("问 1");
    expect(rounds[1]![0]!.content).toBe("问 2");
    expect(rounds[2]![0]!.content).toBe("问 3");
  });

  it("边界：完全空 messages → []", () => {
    expect(groupIntoRounds([])).toEqual([]);
  });

  it("边界：只有 user 没 assistant → 不形成 round", () => {
    const msgs: MultiturnMessage[] = [
      { role: "user", content: "u1", created_at: 1 },
      { role: "user", content: "u2", created_at: 2 },
      { role: "user", content: "u3", created_at: 3 },
    ];
    expect(groupIntoRounds(msgs)).toEqual([]);
  });

  it("边界：3 轮刚好 → 不截断（slice(-3) 保留全部）", () => {
    const msgs = makeRounds(3);
    const prefix = buildMultiturnPrefix(msgs);
    expect(prefix).toContain("[第 1 轮]");
    expect(prefix).toContain("[第 2 轮]");
    expect(prefix).toContain("[第 3 轮]");
    expect(prefix).toContain("用户: 问 1");
    expect(prefix).toContain("用户: 问 2");
    expect(prefix).toContain("用户: 问 3");
    // 没有第 4 轮
    expect(prefix).not.toContain("[第 4 轮]");
  });
});
