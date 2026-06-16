/**
 * M6.9 lib/token-mutex.ts 测试套件（spec §6 + §10）。
 *
 * 6 用例覆盖：
 * 1. 同 identifier 串行：2 个并发 fn → 第 2 个等第 1 个
 * 2. 不同 identifier 不阻塞：2 个并发不同 id → 并行
 * 3. fn throw：mutex 释放 + throw 透传
 * 4. map 自动清理：fn 完成后 entry 删除（间接验）
 * 5. 链式：3 个并发同 id → 1→2→3 串行
 * 6. 高并发：10 并发同 id → 全串行完成
 *
 * 测试策略：纯函数单元测试，不依赖 D1 / miniflare。
 */
import { describe, it, expect } from "vitest";
import { withTokenMutex } from "../../src/lib/token-mutex.js";

describe("token-mutex.withTokenMutex (M6.9)", () => {
  it("同 identifier 串行: 2 个并发 fn → 第 2 个等第 1 个", async () => {
    const order: number[] = [];
    const p1 = withTokenMutex("id1", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 50));
      order.push(2);
    });
    const p2 = withTokenMutex("id1", async () => {
      order.push(3);
      order.push(4);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("不同 identifier 不阻塞: 2 个并发不同 id → 并行", async () => {
    const start = Date.now();
    await Promise.all([
      withTokenMutex("id1", () => new Promise((r) => setTimeout(r, 50))),
      withTokenMutex("id2", () => new Promise((r) => setTimeout(r, 50))),
    ]);
    const elapsed = Date.now() - start;
    // 并行 ~50ms，串行 ~100ms；取 < 90ms 容忍 timer 抖动
    expect(elapsed).toBeLessThan(90);
  });

  it("fn throw: mutex 释放 + throw 透传", async () => {
    await expect(
      withTokenMutex("id1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // mutex 已释放：后续同 id 立即执行
    const start = Date.now();
    await withTokenMutex("id1", () => Promise.resolve());
    expect(Date.now() - start).toBeLessThan(10);
  });

  it("map 自动清理: fn 完成后 entry 删除（间接验）", async () => {
    await withTokenMutex("cleanup-test", () => Promise.resolve());
    const p = withTokenMutex("cleanup-test", () => Promise.resolve());
    await p;
    // 后续同 id 立即执行（map 已清）
    const start = Date.now();
    await withTokenMutex("cleanup-test", () => Promise.resolve());
    expect(Date.now() - start).toBeLessThan(10);
  });

  it("链式: 3 个并发同 id → 1→2→3 串行", async () => {
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) =>
      withTokenMutex("chained", async () => {
        order.push(n);
        await new Promise((r) => setTimeout(r, 30));
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });

  it("高并发: 10 并发同 id → 全串行完成", async () => {
    let counter = 0;
    const tasks = Array.from({ length: 10 }, () =>
      withTokenMutex("high", async () => {
        const current = counter;
        await new Promise((r) => setTimeout(r, 5));
        // 串行：每次读 counter 应该等于自己之前的值
        expect(counter).toBe(current);
        counter = current + 1;
      }),
    );
    await Promise.all(tasks);
    expect(counter).toBe(10);
  });
});
