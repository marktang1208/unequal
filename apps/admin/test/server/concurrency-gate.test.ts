/**
 * ConcurrencyGate 单元测试
 */

import { describe, it, expect } from "vitest";
import { ConcurrencyGate } from "../../server/concurrency-gate.js";

describe("ConcurrencyGate (CP-7-C T4)", () => {
  it("parserSem: 5 并发 → 只 1 同时跑", async () => {
    const gate = new ConcurrencyGate({ parserMax: 1 });
    let concurrentMax = 0;
    let concurrentNow = 0;
    const tasks = Array.from({ length: 5 }, () =>
      gate.parser(async () => {
        concurrentNow++;
        concurrentMax = Math.max(concurrentMax, concurrentNow);
        await new Promise((r) => setTimeout(r, 50));
        concurrentNow--;
        return 1;
      }),
    );
    await Promise.all(tasks);
    expect(concurrentMax).toBe(1);
  });

  it("embedSem: 5 并发 → 3 同时跑", async () => {
    const gate = new ConcurrencyGate({ embedMax: 3 });
    let concurrentMax = 0;
    let concurrentNow = 0;
    const tasks = Array.from({ length: 5 }, () =>
      gate.embed(async () => {
        concurrentNow++;
        concurrentMax = Math.max(concurrentMax, concurrentNow);
        await new Promise((r) => setTimeout(r, 50));
        concurrentNow--;
      }),
    );
    await Promise.all(tasks);
    expect(concurrentMax).toBe(3);
  });

  it("pushSem: 10 并发 → 5 同时跑", async () => {
    const gate = new ConcurrencyGate({ pushMax: 5 });
    let concurrentMax = 0;
    let concurrentNow = 0;
    const tasks = Array.from({ length: 10 }, () =>
      gate.push(async () => {
        concurrentNow++;
        concurrentMax = Math.max(concurrentMax, concurrentNow);
        await new Promise((r) => setTimeout(r, 30));
        concurrentNow--;
      }),
    );
    await Promise.all(tasks);
    expect(concurrentMax).toBe(5);
  });

  it("getStats: 实时返回 active + queue", async () => {
    const gate = new ConcurrencyGate({ parserMax: 1, embedMax: 2, pushMax: 3 });
    const tasks = [
      gate.parser(async () => new Promise((r) => setTimeout(r, 50))),
      gate.parser(async () => new Promise((r) => setTimeout(r, 50))),  // queue
      gate.embed(async () => new Promise((r) => setTimeout(r, 50))),
      gate.push(async () => new Promise((r) => setTimeout(r, 50))),
    ];
    await new Promise((r) => setTimeout(r, 10));
    const stats = gate.getStats();
    expect(stats.parser.active).toBe(1);
    expect(stats.parser.queue).toBe(1);
    expect(stats.embed.active).toBe(1);
    expect(stats.push.active).toBe(1);
    await Promise.all(tasks);
    const finalStats = gate.getStats();
    expect(finalStats.parser.active).toBe(0);
    expect(finalStats.parser.queue).toBe(0);
  });

  it("3 semaphore 独立计数", async () => {
    const gate = new ConcurrencyGate();
    await Promise.all([
      gate.parser(async () => 1),
      gate.embed(async () => 1),
      gate.push(async () => 1),
    ]);
    // 各自释放
    expect(gate.parserSem.activeCount).toBe(0);
    expect(gate.embedSem.activeCount).toBe(0);
    expect(gate.pushSem.activeCount).toBe(0);
  });

  it("错误抛出后仍 release（不卡死）", async () => {
    const gate = new ConcurrencyGate({ parserMax: 1 });
    await expect(gate.parser(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(gate.parserSem.activeCount).toBe(0);
    // 下个任务能正常进
    const r = await gate.parser(async () => 42);
    expect(r).toBe(42);
  });
});
