/**
 * OMLX probe 单元测试（T12）
 *
 * mock fetch 验 4 类响应：200 + 模型列表 / 5xx / timeout / 网络错
 */

import { describe, it, expect, vi } from "vitest";
import { probeOmlx } from "../../server/omlx-probe.js";

describe("probeOmlx (CP-7-C T12)", () => {
  it("200 + 模型列表 → available=true + models", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "bge-m3" }, { id: "Qwen3.6-35B-A3B-4bit" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await probeOmlx("http://x/v1", fetchImpl as any);
    expect(r.available).toBe(true);
    expect(r.models).toEqual(["bge-m3", "Qwen3.6-35B-A3B-4bit"]);
    expect(r.error).toBeUndefined();
  });

  it("5xx → available=false + error 含 status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    const r = await probeOmlx("http://x/v1", fetchImpl as any);
    expect(r.available).toBe(false);
    expect(r.models).toEqual([]);
    expect(r.error).toContain("500");
  });

  it("fetch reject → available=false + error 含 ECONNREFUSED", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:11434"));
    const r = await probeOmlx("http://x/v1", fetchImpl as any);
    expect(r.available).toBe(false);
    expect(r.error).toContain("ECONNREFUSED");
  });

  it("超时 → available=false + error 含 'timeout'", async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url, init) => new Promise((_resolve, reject) => {
        // 监听 abort signal 模拟超时
        const signal = (init as RequestInit | undefined)?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      }),
    );
    const r = await probeOmlx("http://x/v1", fetchImpl as any, 50);
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/timeout|abort/i);
  });

  it("data 字段缺失 → models=空数组", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const r = await probeOmlx("http://x/v1", fetchImpl as any);
    expect(r.available).toBe(true);
    expect(r.models).toEqual([]);
  });
});