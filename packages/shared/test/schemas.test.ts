import { describe, it, expect } from "vitest";
import { SourceSchema, ChunkSchema, TrustLevelSchema } from "../src/schemas.js";

describe("TrustLevelSchema", () => {
  it("accepts 0,1,2,3", () => {
    for (const t of [0, 1, 2, 3]) {
      expect(TrustLevelSchema.parse(t)).toBe(t);
    }
  });
  it("rejects 4 and -1", () => {
    expect(() => TrustLevelSchema.parse(4)).toThrow();
    expect(() => TrustLevelSchema.parse(-1)).toThrow();
  });
});

describe("SourceSchema", () => {
  it("accepts a minimal file source", () => {
    const src = {
      id: "01H...",
      userId: "u1",
      type: "file" as const,
      trustLevel: 1 as const,
      createdAt: Date.now(),
    };
    expect(SourceSchema.parse(src)).toEqual(src);
  });
  it("rejects invalid type", () => {
    expect(() =>
      SourceSchema.parse({
        id: "01H...",
        userId: "u1",
        type: "bogus",
        trustLevel: 1,
        createdAt: Date.now(),
      })
    ).toThrow();
  });
});

describe("ChunkSchema", () => {
  it("accepts a valid chunk", () => {
    const c = {
      id: "01H...",
      documentId: "d1",
      sourceId: "s1",
      userId: "u1",
      idx: 0,
      content: "hello",
      tokenCount: 1,
      trustLevel: 0 as const,
      createdAt: Date.now(),
    };
    expect(ChunkSchema.parse(c)).toEqual(c);
  });
});