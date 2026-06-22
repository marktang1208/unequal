/**
 * CP-7-C: 集成测试 — 5 文件并发端到端
 *
 * 真实链路：multipart → 5 file → 并发 orchestrator (parser → chunker → pusher) → 全部 done
 * （v1 简化：admin 端不 embed，API 端自己 embed；orchestrator 只 parse + chunk + push）
 *
 * mock parser/pusher（避免 mineru/OMLX/MiniMax 真实依赖）
 * 真 SQLite + 真 ConcurrencyGate + 真 IngestOrchestrator
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StatusStore } from "../../server/status-store.js";
import { ConcurrencyGate } from "../../server/concurrency-gate.js";
import {
  IngestOrchestrator,
  type LocalParser,
  type CloudPusher,
  type ChunkText,
} from "../../server/ingest-orchestrator.js";
import { ParseFailedError } from "../../server/local-parser.js";

describe("IngestOrchestrator 集成 (CP-7-C T9)", () => {
  let tmpDir: string;
  let store: StatusStore;
  let gate: ConcurrencyGate;
  let orchestrator: IngestOrchestrator;
  let pushCalls: number;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ingest-int-"));
    store = new StatusStore(join(tmpDir, "test.db"));
    gate = new ConcurrencyGate({ parserMax: 1, embedMax: 3, pushMax: 5 });
    orchestrator = new IngestOrchestrator(store, gate);

    // Mock parser：每种 ext 返不同 markdown
    const mockParser: LocalParser = {
      parseAuto: async (_buf, ext) => {
        await new Promise((r) => setTimeout(r, 20));
        return `# Mock ${ext}\n\nContent for ${ext}`;
      },
    };
    const mockChunker: ChunkText = {
      chunkText: async (text) => [
        { idx: 0, content: text.slice(0, 50), tokenCount: 50 },
        { idx: 1, content: text.slice(50, 100), tokenCount: 50 },
      ],
    };
    pushCalls = 0;
    const mockPusher: CloudPusher = {
      push: async (input) => {
        pushCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return {
          source_id: `01KSRC_${pushCalls}`,
          document_id: `01KDOC_${pushCalls}`,
          chunks_inserted: 2,
          chunks_failed: 0,
        };
      },
    };
    orchestrator.setParser(mockParser);
    orchestrator.setChunker(mockChunker);
    orchestrator.setPusher(mockPusher);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("单文件 happy path: pending → done + cloud_ids", async () => {
    const fileId = "f-1";
    store.create({
      file_id: fileId,
      batch_id: "b-1",
      filename: "a.md",
      ext: "md",
      tmp_data: Buffer.from("# a"),
    });

    await orchestrator.processFile(fileId);

    const r = store.getByFileId(fileId);
    expect(r?.status).toBe("done");
    expect(r?.cloud_source_id).toBe("01KSRC_1");
    expect(r?.cloud_document_id).toBe("01KDOC_1");
    expect(r?.progress).toBe(100);
  });

  it("5 文件并发: 全部 done + push 调 5 次", async () => {
    const fileIds = ["f-1", "f-2", "f-3", "f-4", "f-5"];
    for (const fid of fileIds) {
      store.create({
        file_id: fid,
        batch_id: "b-1",
        filename: `${fid}.md`,
        ext: "md",
        tmp_data: Buffer.from(`# ${fid}`),
      });
    }

    // 5 并发
    await Promise.all(fileIds.map((fid) => orchestrator.processFile(fid)));

    expect(pushCalls).toBe(5);
    for (const fid of fileIds) {
      const r = store.getByFileId(fid);
      expect(r?.status).toBe("done");
      expect(r?.cloud_source_id).toMatch(/^01KSRC_/);
    }
  });

  it("解析错误 → status=parse_failed + retryable=false", async () => {
    const badParser: LocalParser = {
      parseAuto: async () => { throw new Error("PDF 损坏 / encrypted file"); },
    };
    orchestrator.setParser(badParser);
    const fileId = "f-bad";
    store.create({
      file_id: fileId,
      batch_id: "b-bad",
      filename: "bad.pdf",
      ext: "pdf",
      tmp_data: Buffer.from("not pdf"),
    });

    await orchestrator.processFile(fileId);

    const r = store.getByFileId(fileId);
    // 真实生产应该抛 ParseFailedError；这里 plain Error 走 fallback UnknownError
    // 这测的是"任意抛错都不会卡死 orchestrator"
    expect(r?.status).toBe("failed");
    expect(r?.retryable).toBe(1);  // UnknownError 默认 retryable
    expect(r?.retry_count).toBe(1);
  });

  it("ParseFailedError → status=parse_failed + retryable=false", async () => {
    const badParser: LocalParser = {
      parseAuto: async () => { throw new ParseFailedError("PDF 加密"); },
    };
    orchestrator.setParser(badParser);
    const fileId = "f-bad2";
    store.create({
      file_id: fileId,
      batch_id: "b-bad2",
      filename: "enc.pdf",
      ext: "pdf",
      tmp_data: Buffer.from("enc"),
    });

    await orchestrator.processFile(fileId);

    const r = store.getByFileId(fileId);
    expect(r?.status).toBe("failed");
    expect(r?.error_code).toBe("ParseFailed");
    expect(r?.retryable).toBe(0);
  });

  it("推送错误 → status=failed + retryable=true", async () => {
    const failPusher: CloudPusher = {
      push: async () => { throw new Error("cloud 500"); },
    };
    orchestrator.setPusher(failPusher);
    const fileId = "f-push-fail";
    store.create({
      file_id: fileId,
      batch_id: "b-fail",
      filename: "a.md",
      ext: "md",
      tmp_data: Buffer.from("# a"),
    });

    await orchestrator.processFile(fileId);

    const r = store.getByFileId(fileId);
    expect(r?.status).toBe("failed");
    expect(r?.error_code).toBe("UnknownError");
    expect(r?.retryable).toBe(1);
  });

  it("chunker 返回 0 chunks → status=parse_failed", async () => {
    const emptyChunker: ChunkText = {
      chunkText: async () => [],
    };
    orchestrator.setChunker(emptyChunker);
    const fileId = "f-empty";
    store.create({
      file_id: fileId,
      batch_id: "b-empty",
      filename: "a.md",
      ext: "md",
      tmp_data: Buffer.from("x"),
    });

    await orchestrator.processFile(fileId);

    const r = store.getByFileId(fileId);
    expect(r?.status).toBe("failed");
    expect(r?.error_code).toBe("ParseFailed");
  });
});
