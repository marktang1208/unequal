import { describe, it, expect } from "vitest";
import { chunkText } from "../src/chunking.js";

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    const chunks = chunkText("hello world", { maxTokens: 100, overlapTokens: 10 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("hello world");
    expect(chunks[0]?.tokenCount).toBeGreaterThan(0);
  });

  it("splits long text into multiple chunks with overlap", () => {
    // 制造一段约 100 token 的中文文本
    const longText = "育儿知识。".repeat(100);
    const chunks = chunkText(longText, { maxTokens: 30, overlapTokens: 5 });
    expect(chunks.length).toBeGreaterThan(1);
    // 每个 chunk 都有 idx，从 0 开始递增
    chunks.forEach((c, i) => expect(c.idx).toBe(i));
  });

  it("preserves content when joining chunks covers original (overlap allowed)", () => {
    const text = "第一段内容。第二段内容。第三段内容。";
    const chunks = chunkText(text, { maxTokens: 10, overlapTokens: 3 });
    // 拼回去的字符应该覆盖原文（允许 overlap 重复）
    const joined = chunks.map((c) => c.content).join("");
    expect(joined.length).toBeGreaterThanOrEqual(text.length);
  });

  it("handles empty text", () => {
    expect(chunkText("", { maxTokens: 100, overlapTokens: 10 })).toEqual([]);
  });

  it("handles text with only whitespace", () => {
    expect(chunkText("   \n  \n", { maxTokens: 100, overlapTokens: 10 })).toEqual([]);
  });
});
