/**
 * LocalIngestMiddleware 单元测试
 *
 * 测 POST /api/upload + GET /api/ingest-status + POST /api/retry
 * 用 supertest 模拟 HTTP 请求 + Connect.Server
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { StatusStore } from "@unequal/local-llm";
import { ConcurrencyGate } from "../../server/concurrency-gate.js";
import {
  IngestOrchestrator,
  type LocalParser,
  type CloudPusher,
  type ChunkText,
} from "../../server/ingest-orchestrator.js";
import { localIngestMiddleware, __setDepsForTest, __resetForTest } from "../../server/local-ingest.js";

// T2 测试用 mock：注入 stub parser/pusher/chunker 避免 T5/T8 真实依赖（admin 端不 embed）
function setupMockDeps(orchestrator: IngestOrchestrator): void {
  const mockParser: LocalParser = {
    parseAuto: async () => "# Mock Markdown\n\nParsed content",
  };
  const mockPusher: CloudPusher = {
    push: async () => ({ source_id: "01KSRC_MOCK", document_id: "01KDOC_MOCK", chunks_inserted: 1, chunks_failed: 0 }),
  };
  const mockChunker: ChunkText = {
    chunkText: async (text) => [{ idx: 0, content: text, tokenCount: text.length }],
  };
  orchestrator.setParser(mockParser);
  orchestrator.setPusher(mockPusher);
  orchestrator.setChunker(mockChunker);
}

describe("LocalIngestMiddleware (CP-7-C T2)", () => {
  let tmpDir: string;
  let store: StatusStore;
  let gate: ConcurrencyGate;
  let orchestrator: IngestOrchestrator;
  let handler: any;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "local-ingest-"));
    store = new StatusStore(join(tmpDir, "test.db"));
    gate = new ConcurrencyGate();
    orchestrator = new IngestOrchestrator(store, gate);
    setupMockDeps(orchestrator);
    __setDepsForTest({ store, orchestrator, gate });
    handler = localIngestMiddleware;
  });

  afterEach(() => {
    __resetForTest();
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRequest(): any {
    // supertest 不能直接用 Connect.Server；用 http.createServer 包装
    const http = require("node:http");
    return (req: any, res: any, next: any) => {
      const wrapped = handler(req, res, next);
      if (wrapped && typeof wrapped.then === "function") {
        return wrapped;
      }
    };
  }

  it("POST /api/upload: 单文件 → 202 + batch_id + file_id", async () => {
    // 用 http server 包装 Connect middleware（supertest 模式）
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      void handler(req as any, res as any, () => {
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as any).port;

    const res = await request(`http://localhost:${port}`)
      .post("/api/upload")
      .field("trust_level", "2")
      .attach("file", Buffer.from("# Hello\n\nWorld"), { filename: "hello.md" });

    expect(res.status).toBe(202);
    expect(res.body.batch_id).toBeDefined();
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].filename).toBe("hello.md");
    expect(res.body.files[0].status).toBe("pending");

    server.close();
  });

  it("POST /api/upload: 5 文件 → 5 file_id + 同一 batch_id", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      void handler(req as any, res as any, () => { res.statusCode = 404; res.end(); });
    });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as any).port;

    const res = await request(`http://localhost:${port}`)
      .post("/api/upload")
      .field("trust_level", "1")
      .attach("file", Buffer.from("a"), { filename: "a.md" })
      .attach("file", Buffer.from("b"), { filename: "b.md" })
      .attach("file", Buffer.from("c"), { filename: "c.md" })
      .attach("file", Buffer.from("d"), { filename: "d.md" })
      .attach("file", Buffer.from("e"), { filename: "e.md" });

    expect(res.status).toBe(202);
    expect(res.body.files).toHaveLength(5);
    const ids = res.body.files.map((f: any) => f.file_id);
    console.log("file_ids:", ids);
    console.log("batch_ids:", res.body.files.map((f: any) => f.batch_id));
    console.log("top batch_id:", res.body.batch_id);
    expect(new Set(ids).size).toBe(5);  // 5 个不同 file_id
    expect(res.body.files.every((f: any) => f.batch_id === res.body.batch_id)).toBe(true);

    server.close();
  });

  it("POST /api/upload: 无文件 → 400 INVALID_REQUEST", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      void handler(req as any, res as any, () => { res.statusCode = 404; res.end(); });
    });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as any).port;

    const res = await request(`http://localhost:${port}`)
      .post("/api/upload")
      .field("trust_level", "1");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_REQUEST");
    server.close();
  });

  it("POST /api/upload: trust_level 越界 → 400", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      void handler(req as any, res as any, () => { res.statusCode = 404; res.end(); });
    });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as any).port;

    const res = await request(`http://localhost:${port}`)
      .post("/api/upload")
      .field("trust_level", "5")  // out of range
      .attach("file", Buffer.from("x"), { filename: "x.md" });
    expect(res.status).toBe(400);
    server.close();
  });

  it("GET /api/ingest-status: 返 batch files", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      void handler(req as any, res as any, () => { res.statusCode = 404; res.end(); });
    });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as any).port;

    // 先上传
    const uploadRes = await request(`http://localhost:${port}`)
      .post("/api/upload")
      .field("trust_level", "1")
      .attach("file", Buffer.from("a"), { filename: "a.md" });
    const batchId = uploadRes.body.batch_id;

    // 查 status
    const statusRes = await request(`http://localhost:${port}`)
      .get(`/api/ingest-status?batch_id=${batchId}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.batch_id).toBe(batchId);
    expect(statusRes.body.files).toHaveLength(1);
    expect(statusRes.body.files[0].filename).toBe("a.md");
    server.close();
  });

  it("GET /api/ingest-status: 缺 batch_id → 400", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      void handler(req as any, res as any, () => { res.statusCode = 404; res.end(); });
    });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as any).port;

    const res = await request(`http://localhost:${port}`).get("/api/ingest-status");
    expect(res.status).toBe(400);
    server.close();
  });

  it("POST /api/retry: file_id 不存在 → 404", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      void handler(req as any, res as any, () => { res.statusCode = 404; res.end(); });
    });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as any).port;

    const res = await request(`http://localhost:${port}`).post("/api/retry?file_id=nope");
    expect(res.status).toBe(404);
    server.close();
  });

  it("POST /api/retry: 缺 file_id → 400", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      void handler(req as any, res as any, () => { res.statusCode = 404; res.end(); });
    });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as any).port;

    const res = await request(`http://localhost:${port}`).post("/api/retry");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_REQUEST");
    server.close();
  });

  it("POST /api/retry: retryable=0 文件 → 400 NOT_RETRYABLE", async () => {
    // 显式造一个 retryable=0 的 record（模拟 ParseFailedError 后果）
    store.create({
      file_id: "f-not-retryable",
      batch_id: "b-nr",
      filename: "bad.pdf",
      ext: "pdf",
      tmp_data: Buffer.from("x"),
      status: "failed",
      retryable: 0,
      retry_count: 1,
      error_code: "ParseFailed",
      error_message: "PDF 加密",
    });

    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      void handler(req as any, res as any, () => { res.statusCode = 404; res.end(); });
    });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as any).port;

    const res = await request(`http://localhost:${port}`).post("/api/retry?file_id=f-not-retryable");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("NOT_RETRYABLE");
    expect(res.body.message).toContain("not retryable");
    server.close();
  });

  it("POST /api/retry: 失败文件 retryable=1 → 202 + status=pending → done", async () => {
    // mock pusher 第一次失败、第二次成功
    let pushAttempts = 0;
    const flakyPusher: CloudPusher = {
      push: async () => {
        pushAttempts++;
        if (pushAttempts === 1) throw new Error("cloud 500");
        return { source_id: "01KSRC_RETRY", document_id: "01KDOC_RETRY" };
      },
    };
    orchestrator.setPusher(flakyPusher);

    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      void handler(req as any, res as any, () => { res.statusCode = 404; res.end(); });
    });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as any).port;

    const uploadRes = await request(`http://localhost:${port}`)
      .post("/api/upload")
      .field("trust_level", "1")
      .attach("file", Buffer.from("# x"), { filename: "x.md" });
    const fileId = uploadRes.body.files[0].file_id;

    // 等第一次失败
    await new Promise((r) => setTimeout(r, 100));
    const after1st = store.getByFileId(fileId);
    expect(after1st?.status).toBe("failed");
    expect(after1st?.retryable).toBe(1);

    // 触发 retry
    const retryRes = await request(`http://localhost:${port}`).post(`/api/retry?file_id=${fileId}`);
    expect(retryRes.status).toBe(202);
    expect(retryRes.body.status).toBe("pending");

    // 等第二次成功
    await new Promise((r) => setTimeout(r, 100));
    const after2nd = store.getByFileId(fileId);
    expect(after2nd?.status).toBe("done");
    expect(after2nd?.cloud_source_id).toBe("01KSRC_RETRY");
    expect(pushAttempts).toBe(2);

    server.close();
  });

  it("GET /api/llm-status: 返 omlx probe + fallback 状态", async () => {
    // mock fetchImpl 让 probe 返 offline
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;
    try {
      const http = await import("node:http");
      const server = http.createServer((req, res) => {
        void handler(req as any, res as any, () => { res.statusCode = 404; res.end(); });
      });
      await new Promise((r) => server.listen(0, r));
      const port = (server.address() as any).port;

      const res = await request(`http://localhost:${port}`).get("/api/llm-status");
      expect(res.status).toBe(200);
      expect(res.body.omlx).toBeDefined();
      expect(res.body.omlx.available).toBe(false);  // mock 返 500
      expect(res.body.omlx.url).toContain("11434");
      expect(res.body.fallback).toBeDefined();
      expect(res.body.fallback.embed).toBeDefined();
      expect(res.body.fallback.llm).toBeDefined();
      server.close();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("非 /api 路径 → 调 next() (404)", async () => {
    const http = await import("node:http");
    let nextCalled = false;
    const server = http.createServer((req, res) => {
      void handler(req as any, res as any, () => {
        nextCalled = true;
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as any).port;

    const res = await request(`http://localhost:${port}`).get("/not-api");
    expect(nextCalled).toBe(true);
    expect(res.status).toBe(404);
    server.close();
  });
});
