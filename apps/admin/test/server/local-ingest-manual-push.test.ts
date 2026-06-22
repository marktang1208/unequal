/**
 * P3-7 / Phase C: /api/manual-push 集成测试
 *
 * mock CloudPusher（fetch 拦截）+ 真实 StatusStore
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { StatusStore } from "@unequal/local-llm";

// 在 import middleware 前 mock CloudPusher fetch
function makeMockFetch(responses: Array<{ status: number; body?: unknown }>): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[i++];
    if (!r) throw new Error(`unexpected call #${i}`);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("/api/manual-push (P3-7)", () => {
  let tmpDir: string;
  let store: StatusStore;
  let originalFetch: typeof fetch;
  let mockFetch: typeof fetch;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "manual-push-"));
    store = new StatusStore(join(tmpDir, "test.db"));

    // 创建 3 条 pending crawler 记录（带 markdown + chunks_json）
    for (let i = 0; i < 3; i++) {
      store.create({
        file_id: `f${i}`,
        batch_id: "b1",
        filename: `https://x.example/${i}`,
        ext: "crawler",
        source: "crawler",
        markdown: `markdown content ${i}`,
        chunks_json: JSON.stringify([]),
        markdown_chars: 100,
        chunks_count: 0,
        status: "pending",
      });
    }

    originalFetch = globalThis.fetch;
    mockFetch = makeMockFetch([
      { status: 200, body: { source_id: "s1", document_id: "d1" } },
      { status: 200, body: { source_id: "s2", document_id: "d2" } },
      { status: 200, body: { source_id: "s3", document_id: "d3" } },
    ]);
    globalThis.fetch = mockFetch;

    // 延迟 import middleware（确保 mock fetch 已就位）
    const mod = await import("../../server/local-ingest.js");
    mod.__setDepsForTest({
      store,
      orchestrator: {} as any,
      gate: {} as any,
    });
    (globalThis as any).__middleware = mod.localIngestMiddleware;
  });

  afterEach(() => {
    store.close();
    globalThis.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("happy: 推送 3 条 pending → 返 {pushed: 3, failed: 0, skipped: 0}", async () => {
    const res = await request((globalThis as any).__middleware)
      .post("/api/manual-push")
      .send({ file_ids: ["f0", "f1", "f2"] });
    expect(res.status).toBe(200);
    expect(res.body.pushed).toBe(3);
    expect(res.body.failed).toBe(0);
    expect(res.body.skipped).toBe(0);
    // 状态变 done
    expect(store.getByFileId("f0")?.status).toBe("done");
    expect(store.getByFileId("f1")?.cloud_source_id).toBe("s2");
  });

  it("推送 3 条 + 第 2 条 mock 失败 → 返 {pushed: 2, failed: 1, skipped: 0}", async () => {
    // 5xx 会触发 CloudPusher 内部重试 2 次（默认 backoff 1ms）—— 给 4xx 401 让 CloudPusher 立即抛（不重试）
    // 每个 push 调用 1 次 fetch；给 2 个 200 + 1 个 401 + 1 个 buffer 401
    globalThis.fetch = makeMockFetch([
      { status: 200, body: { source_id: "s1", document_id: "d1" } },
      { status: 401, body: { error: "UNAUTHORIZED" } },
      { status: 200, body: { source_id: "s3", document_id: "d3" } },
    ]);

    const res = await request((globalThis as any).__middleware)
      .post("/api/manual-push")
      .send({ file_ids: ["f0", "f1", "f2"] });
    expect(res.status).toBe(200);
    expect(res.body.pushed).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.errors[0]?.file_id).toBe("f1");
    expect(store.getByFileId("f1")?.status).toBe("failed");
    expect(store.getByFileId("f1")?.retryable).toBe(1);
  });

  it("推送包含非 pending 记录 → 跳过", async () => {
    // f1 改成 done
    store.markDone("f1", "s-old", "d-old");
    const res = await request((globalThis as any).__middleware)
      .post("/api/manual-push")
      .send({ file_ids: ["f0", "f1", "f2"] });
    expect(res.status).toBe(200);
    expect(res.body.pushed).toBe(2);
    expect(res.body.skipped).toBe(1);
  });

  it("trust_level_overrides 正确传", async () => {
    const res = await request((globalThis as any).__middleware)
      .post("/api/manual-push")
      .send({
        file_ids: ["f0"],
        trust_level_overrides: { f0: 3 },
      });
    expect(res.status).toBe(200);
    expect(res.body.pushed).toBe(1);
  });

  it("file_ids 为空 → 400 INVALID_REQUEST", async () => {
    const res = await request((globalThis as any).__middleware)
      .post("/api/manual-push")
      .send({ file_ids: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_REQUEST");
  });

  it("body 非 JSON → 400 INVALID_JSON", async () => {
    const res = await request((globalThis as any).__middleware)
      .post("/api/manual-push")
      .set("Content-Type", "application/json")
      .send("not json");
    expect(res.status).toBe(400);
  });
});
