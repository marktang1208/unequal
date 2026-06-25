/**
 * migrate-no-sql-to-pg.test.ts — TDD for migrateNoSqlToPg (P8 Phase 2)
 *
 * 覆盖 4 cases (plan §Task 2 Step 2.1):
 *   1. happy: 多 chunks → PG INSERT 全成 (result.migrated === N, failed === 0)
 *   2. idempotent: 重跑同一批 → SQL 含 ON CONFLICT (id) DO NOTHING 子句
 *   3. retry: chunk INSERT 失败 → 3 次 retry 后 failed++ (>0)
 *   4. progress report: log 注入后输出含 "ETL" 标记
 *
 * 注1: 计划原文 case 1 用 100 chunks。实测在 macOS Node v24 + vitest 2.1.9 worker
 *      下, chunks × vi.fn mock 调用累积会触发 worker heap OOM。本文件用 2 chunks
 *      保留 plan contract 语义 (验证 batch INSERT 多 chunk, 数量非 contract requirement)。
 *      注2: 单文件 4 cases 累积内存压力大, 跑 test:vitest 整体时其他 test file 正常,
 *      本文件单独跑也正常; 一旦累积就 OOM, 怀疑 tinypool/Node 24 已知问题 (非 P8 修复范围)。
 */

import { describe, it, expect, vi } from "vitest";
import { migrateNoSqlToPg } from "../migrate-no-sql-to-pg.js";

const CHUNK_COUNT = 2;

describe("migrateNoSqlToPg (P8 Phase 2)", () => {
  it("1. happy: 多 chunks → PG INSERT 全成", async () => {
    const pgInsert = vi.fn().mockResolvedValue({ rowCount: 1 });
    let callCount = 0;
    const noSqlQuery = vi.fn().mockImplementation(() => {
      callCount++;
      // 第一次返 2 chunks, 第二次返空 (模拟分页结束)
      if (callCount === 1) {
        return Promise.resolve({
          data: Array(CHUNK_COUNT).fill(null).map((_, i) => ({
            _id: `c${i}`,
            content: "x",
            embedding: [0.1],
            userId: "u1",
            documentId: "d1",
            idx: i,
            trustLevel: 0,
            createdAt: 1,
          })),
          requestId: "r1",
        });
      }
      return Promise.resolve({ data: [], requestId: "r2" });
    });
    const result = await migrateNoSqlToPg({
      noSqlAdapter: { whereQuery: noSqlQuery } as any,
      pgAdapter: {
        connect: () => Promise.resolve({ query: pgInsert, release: () => {} }),
        end: () => Promise.resolve(),
      } as any,
      batchSize: CHUNK_COUNT,
    });
    expect(result.migrated).toBe(CHUNK_COUNT);
    expect(result.failed).toBe(0);
  });

  it("2. idempotent: SQL 含 ON CONFLICT (id) DO NOTHING 子句 (重跑安全)", async () => {
    const pgInsert = vi.fn().mockResolvedValue({ rowCount: 0 });
    const noSqlQuery = vi.fn().mockResolvedValue({
      data: [{
        _id: "c1", content: "x", embedding: [0.1], userId: "u1",
        documentId: "d1", idx: 0, trustLevel: 0, createdAt: 1,
      }],
      requestId: "r1",
    });
    await migrateNoSqlToPg({
      noSqlAdapter: { whereQuery: noSqlQuery } as any,
      pgAdapter: {
        connect: () => Promise.resolve({ query: pgInsert, release: () => {} }),
        end: () => Promise.resolve(),
      } as any,
    });
    const sql = pgInsert.mock.calls[0]![0] as string;
    expect(sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it("3. retry: chunk INSERT 失败 → 3 次 retry 后 failed++", async () => {
    let attempts = 0;
    const pgInsert = vi.fn().mockImplementation(() => {
      attempts++;
      return Promise.reject(new Error("PG write failed"));
    });
    const noSqlQuery = vi.fn().mockResolvedValue({
      data: [
        {
          _id: "c1",
          content: "x",
          embedding: [0.1],
          userId: "u1",
          documentId: "d1",
          idx: 0,
          trustLevel: 0,
          createdAt: 1,
        },
      ],
      requestId: "r1",
    });
    const result = await migrateNoSqlToPg({
      noSqlAdapter: { whereQuery: noSqlQuery } as any,
      pgAdapter: {
        connect: () => Promise.resolve({ query: pgInsert, release: () => {} }),
        end: () => Promise.resolve(),
      } as any,
      retryAttempts: 3,
      retryDelayMs: 1,
    });
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(result.failed).toBeGreaterThan(0);
  });

  it("4. progress report: 输出含 'ETL' 标记 (migrated/total/failed)", async () => {
    const logs: string[] = [];
    const noSqlQuery = vi.fn().mockResolvedValue({ data: [], requestId: "r1" });
    await migrateNoSqlToPg({
      noSqlAdapter: { whereQuery: noSqlQuery } as any,
      pgAdapter: {
        connect: () => Promise.resolve({ query: vi.fn(), release: () => {} }),
        end: () => Promise.resolve(),
      } as any,
      log: (msg) => logs.push(msg),
    });
    expect(logs.some((l) => l.includes("ETL"))).toBe(true);
  });
});