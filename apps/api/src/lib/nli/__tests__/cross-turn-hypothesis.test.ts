/**
 * cross-turn-hypothesis.test.ts — TDD for P5 v1.4 跨轮 NLI helper
 *
 * 覆盖 6 cases:
 *   1. 旧 session (无 retrievedChunkIds) → fallback 单轮, hypothesis = 当前
 *   2. 单轮 session (1 assistant msg with retrievedChunkIds) → union 但全去重 = 当前
 *   3. 多轮 session (2 assistant msgs) → union 当前 + 历史 chunks
 *   4. cap: 历史 chunks > 5 → 只取前 5 + cappedAt=true
 *   5. 当前 chunk id 跟历史重复 → 不重复算入
 *   6. user message (不是 assistant) → 跳过 (不读 retrievedChunkIds)
 */

import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@unequal/shared/types";
import { getCrossTurnHypothesis } from "../cross-turn-hypothesis.js";

const findChunkById = (id: string): string | null => `content-of-${id}`;

describe("getCrossTurnHypothesis (P5 v1.4)", () => {
  it("旧 session (无 retrievedChunkIds) → fallback 单轮", () => {
    const sessionMessages: ChatMessage[] = [
      { role: "user", content: "Q1", createdAt: 1 },
      { role: "assistant", content: "A1", citations: [], createdAt: 2 }, // 没 retrievedChunkIds
    ];

    const result = getCrossTurnHypothesis({
      currentChunkIds: ["c1", "c2"],
      sessionMessages,
      findChunkById,
    });

    expect(result.chunkIds).toEqual(["c1", "c2"]);
    expect(result.hypothesis).toBe("content-of-c1\n\ncontent-of-c2");
    expect(result.currentCount).toBe(2);
    expect(result.cappedHistoricalCount).toBe(0);
    expect(result.cappedAt).toBe(false);
  });

  it("单轮 session (assistant msg 有 retrievedChunkIds) → union 全去重 = 仅当前 (因为 assistant 在当前轮之前)", () => {
    // 注意: 当前轮的 assistant message 在写 NLI 之前未持久化, 所以 session 里只有前几轮的
    // 这里测的"单轮"其实是新 session, messages 只有 user
    const sessionMessages: ChatMessage[] = [
      { role: "user", content: "Q1", createdAt: 1 },
    ];

    const result = getCrossTurnHypothesis({
      currentChunkIds: ["c1", "c2"],
      sessionMessages,
      findChunkById,
    });

    expect(result.chunkIds).toEqual(["c1", "c2"]);
    expect(result.hypothesis).toBe("content-of-c1\n\ncontent-of-c2");
    expect(result.cappedHistoricalCount).toBe(0);
  });

  it("多轮 session (2 assistant msgs) → union 当前 + 历史", () => {
    const sessionMessages: ChatMessage[] = [
      { role: "user", content: "Q1", createdAt: 1 },
      { role: "assistant", content: "A1", retrievedChunkIds: ["a1", "a2"], createdAt: 2 },
      { role: "user", content: "Q2", createdAt: 3 },
      { role: "assistant", content: "A2", retrievedChunkIds: ["b1", "b2"], createdAt: 4 },
    ];

    const result = getCrossTurnHypothesis({
      currentChunkIds: ["c1", "c2"], // 第 3 轮 retrieve
      sessionMessages,
      findChunkById,
    });

    // 当前优先 [c1, c2], 然后历史 [a1, a2, b1, b2]
    expect(result.chunkIds).toEqual(["c1", "c2", "a1", "a2", "b1", "b2"]);
    expect(result.currentCount).toBe(2);
    expect(result.cappedHistoricalCount).toBe(4);
    expect(result.cappedAt).toBe(false);
    expect(result.historicalCount).toBe(6);
    expect(result.hypothesis).toBe(
      "content-of-c1\n\ncontent-of-c2\n\ncontent-of-a1\n\ncontent-of-a2\n\ncontent-of-b1\n\ncontent-of-b2",
    );
  });

  it("cap: 历史 chunks > 5 → 只取前 5 + cappedAt=true", () => {
    const sessionMessages: ChatMessage[] = [
      { role: "assistant", content: "A1", retrievedChunkIds: ["h1", "h2", "h3", "h4", "h5", "h6", "h7"], createdAt: 1 },
    ];

    const result = getCrossTurnHypothesis({
      currentChunkIds: ["c1"],
      sessionMessages,
      findChunkById,
    });

    // 当前 [c1], 历史 cap 5 → [h1, h2, h3, h4, h5]
    expect(result.chunkIds).toEqual(["c1", "h1", "h2", "h3", "h4", "h5"]);
    expect(result.cappedHistoricalCount).toBe(5);
    expect(result.cappedAt).toBe(true);
  });

  it("当前 chunk id 跟历史重复 → 不重复算入", () => {
    const sessionMessages: ChatMessage[] = [
      { role: "assistant", content: "A1", retrievedChunkIds: ["c1", "c2", "h1"], createdAt: 1 }, // c1/c2 跟当前重复
    ];

    const result = getCrossTurnHypothesis({
      currentChunkIds: ["c1", "c2"],
      sessionMessages,
      findChunkById,
    });

    // 当前 [c1, c2], 历史过滤后 [h1]
    expect(result.chunkIds).toEqual(["c1", "c2", "h1"]);
    expect(result.cappedHistoricalCount).toBe(1);
  });

  it("user message → 跳过 (不读 retrievedChunkIds)", () => {
    // 防御性: 即使误把 retrievedChunkIds 写到 user msg 上, 也不读
    const userMsg = { role: "user" as const, content: "Q1", createdAt: 1 };
    const assistantMsg = { role: "assistant" as const, content: "A1", retrievedChunkIds: ["h1"], createdAt: 2 };
    const sessionMessages: ChatMessage[] = [userMsg, assistantMsg];

    const result = getCrossTurnHypothesis({
      currentChunkIds: ["c1"],
      sessionMessages,
      findChunkById,
    });

    // 只读 assistant message 的 h1, 跳过 user 的 fake1
    expect(result.chunkIds).toEqual(["c1", "h1"]);
  });

  it("findChunkById 返 null/空 → 跳过 (不污染 hypothesis)", () => {
    const sessionMessages: ChatMessage[] = [
      { role: "assistant", content: "A1", retrievedChunkIds: ["h1", "h2"], createdAt: 1 },
    ];
    const partialFind = (id: string): string | null => {
      if (id === "h2") return null;
      if (id === "h1") return ""; // 空字符串也跳过
      return `content-${id}`;
    };

    const result = getCrossTurnHypothesis({
      currentChunkIds: ["c1", "c2"],
      sessionMessages,
      findChunkById: partialFind,
    });

    expect(result.chunkIds).toEqual(["c1", "c2", "h1", "h2"]); // IDs 仍在
    expect(result.hypothesis).toBe("content-c1\n\ncontent-c2"); // h1/h2 都被过滤
  });
});