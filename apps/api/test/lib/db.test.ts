/**
 * CP-7-C #4: db.add() 自动填 schema id 字段 unit test
 *
 * 覆盖行为矩阵：
 * - id: "" / undefined / null / "   " → 自动填 = _id
 * - id: "01HABC..." (有效值) → 保留 caller 值
 * - data 不含 id 字段 → 自动填 = _id
 * - 返回值始终是新生成的 _id（不是 caller id）
 *
 * Mock 模式：mock getDB() 返 mockDB，mockDB.collection(name).add(doc) 捕获 doc
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vitest 2.x vi.fn 泛型约束是 Procedure；用 implementation infer 类型
const mockAdd = vi.fn(async (_doc: Record<string, unknown>) => ({
  id: "mock-cloudbase-id",
}));
const mockCollection = { add: mockAdd };
const mockDB = { collection: vi.fn(() => mockCollection) };

/** 取出最后一次 add() 调用的 doc（test helper；cast any 因为 vitest mock tuple 推断有限） */
function lastWrittenDoc(): Record<string, unknown> {
  return (mockAdd.mock.calls[0] as unknown as [Record<string, unknown>] | undefined)?.[0] ?? {};
}

vi.mock("../../src/lib/cloudbase.js", () => ({
  getDB: () => mockDB,
}));

import { add } from "../../src/lib/db.js";
import { COLLECTIONS } from "../../src/lib/collections.js";

beforeEach(() => {
  mockAdd.mockClear();
  mockDB.collection.mockClear();
});

describe("db.add() 自动填 schema id (CP-7-C #4)", () => {
  it("id: '' (empty) → 自动填 = _id", async () => {
    const result = await add(COLLECTIONS.user, { id: "", name: "test" });
    expect(mockAdd).toHaveBeenCalledTimes(1);
    const writtenDoc = lastWrittenDoc();
    expect(writtenDoc.id).toBe(result);
    expect(writtenDoc._id).toBe(result);
  });

  it("id: undefined → 自动填 = _id", async () => {
    const data: { id?: string; name: string } = { name: "test" };
    const result = await add(COLLECTIONS.user, data);
    const writtenDoc = lastWrittenDoc();
    expect(writtenDoc.id).toBe(result);
  });

  it("id: null → 自动填 = _id", async () => {
    const data = { id: null as unknown as string, name: "test" };
    const result = await add(COLLECTIONS.user, data);
    const writtenDoc = lastWrittenDoc();
    expect(writtenDoc.id).toBe(result);
  });

  it("id: '   ' (whitespace) → 自动填 = _id", async () => {
    const data = { id: "   ", name: "test" };
    const result = await add(COLLECTIONS.user, data);
    const writtenDoc = lastWrittenDoc();
    expect(writtenDoc.id).toBe(result);
  });

  it("id: '01HABC...' (有效值) → 保留 caller 值", async () => {
    const callerId = "01HABCDEFG123456789012345";
    await add(COLLECTIONS.user, { id: callerId, name: "test" });
    const writtenDoc = lastWrittenDoc();
    expect(writtenDoc.id).toBe(callerId);
  });

  it("data 不含 id 字段 → 自动填 = _id", async () => {
    const result = await add(COLLECTIONS.user, { name: "test" });
    const writtenDoc = lastWrittenDoc();
    expect(writtenDoc.id).toBe(result);
  });

  it("返回值始终是新生成的 _id（不是 caller id）", async () => {
    const callerId = "01HABCDEFG123456789012345";
    const result = await add(COLLECTIONS.user, { id: callerId, name: "test" });
    expect(result).not.toBe(callerId);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});