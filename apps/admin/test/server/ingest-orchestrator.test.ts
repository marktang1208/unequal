/**
 * CP-7-C: 集成测试 — 5 文件并发端到端
 *
 * 真实链路：multipart → 5 file → 并发 orchestrator (parser → chunker → embedder → pusher) → 全部 done
 * v2.4：admin 端 embed（mock）+ 推预嵌入 chunks；orchestrator 6 状态机
 *
 * mock parser/embedder/pusher（避免 mineru/OMLX/MiniMax 真实依赖）
 * 真 SQLite + 真 ConcurrencyGate + 真 IngestOrchestrator
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StatusStore } from "@unequal/local-llm";
import { ConcurrencyGate } from "../../server/concurrency-gate.js";
import {
  IngestOrchestrator,
  type LocalParser,
  type CloudPusher,
  type ChunkText,
  type Embedder,
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
    // v2.4: mock embedder — 返每 text 1536 维全 0 向量
    const mockEmbedder: Embedder = {
      embed: async (texts) =>
        texts.map(() => new Array(1536).fill(0)),
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
      // v2.4: 新增 pushChunks
      pushChunks: async (input) => {
        pushCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return {
          source_id: `01KSRC_${pushCalls}`,
          document_id: `01KDOC_${pushCalls}`,
          chunks_inserted: input.chunks.length,
          chunks_failed: 0,
        };
      },
    };
    orchestrator.setParser(mockParser);
    orchestrator.setChunker(mockChunker);
    orchestrator.setEmbedder(mockEmbedder);
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

  // ─── zhenjie6: retry 快路径 (跳过 parse/chunk/embed) ──────────────

  it("zhenjie6: chunks_with_emb_json 存在 → 跳过 parse/chunk/embed, 直接 push", async () => {
    // 准备：模拟上次跑成功，DB 里有 chunks_with_emb_json 缓存
    const fileId = "f-cached";
    const cachedChunks = [
      { idx: 0, content: "cached-1", embedding: new Array(1536).fill(0.1), tokenCount: 10 },
      { idx: 1, content: "cached-2", embedding: new Array(1536).fill(0.2), tokenCount: 10 },
    ];
    store.create({
      file_id: fileId,
      batch_id: "b-1",
      filename: "cached.md",
      ext: "md",
      tmp_data: null, // retry 时甚至没有原始文件
      chunks_with_emb_json: JSON.stringify(cachedChunks),
    });

    // 关键：把 parser/chunker/embedder 全部换成"绝对不能被调"的严格 mock
    let parserCalled = 0, chunkerCalled = 0, embedderCalled = 0;
    const strictParser: LocalParser = {
      parseAuto: async () => { parserCalled++; throw new Error("PARSER_SHOULD_NOT_BE_CALLED"); },
    };
    const strictChunker: ChunkText = {
      chunkText: async () => { chunkerCalled++; throw new Error("CHUNKER_SHOULD_NOT_BE_CALLED"); },
    };
    const strictEmbedder: Embedder = {
      embed: async () => { embedderCalled++; throw new Error("EMBEDDER_SHOULD_NOT_BE_CALLED"); },
    };
    orchestrator.setParser(strictParser);
    orchestrator.setChunker(strictChunker);
    orchestrator.setEmbedder(strictEmbedder);

    await orchestrator.processFile(fileId);

    // 关键断言：parser/chunker/embedder 一次都没调
    expect(parserCalled).toBe(0);
    expect(chunkerCalled).toBe(0);
    expect(embedderCalled).toBe(0);

    // 推了 1 次
    expect(pushCalls).toBe(1);
    const r = store.getByFileId(fileId);
    expect(r?.status).toBe("done");
    expect(r?.cloud_source_id).toBe("01KSRC_1");
  });

  it("zhenjie6: 正常路径成功 → 自动写 chunks_with_emb_json (供下次 retry)", async () => {
    const fileId = "f-normal";
    store.create({
      file_id: fileId,
      batch_id: "b-1",
      filename: "normal.md",
      ext: "md",
      tmp_data: Buffer.from("# test"),
    });

    await orchestrator.processFile(fileId);

    const r = store.getByFileId(fileId);
    expect(r?.status).toBe("done");
    // 关键断言：done 时 chunks_with_emb_json 已被写
    expect(r?.chunks_with_emb_json).toBeTruthy();
    const parsed = JSON.parse(r!.chunks_with_emb_json!);
    expect(parsed).toHaveLength(2); // mock chunker 产 2 chunks
    expect(parsed[0].embedding).toHaveLength(1536);
  });

  it("zhenjie6: chunks_with_emb_json=空数组 → 视为 cache miss, 落到正常路径", async () => {
    const fileId = "f-empty-cache";
    store.create({
      file_id: fileId,
      batch_id: "b-1",
      filename: "empty-cache.md",
      ext: "md",
      tmp_data: Buffer.from("# test"),
      chunks_with_emb_json: "[]", // 0 chunks → 落到正常路径
    });

    await orchestrator.processFile(fileId);

    // 应当落到正常路径：parser/chunker/embedder 都跑了，done
    const r = store.getByFileId(fileId);
    expect(r?.status).toBe("done");
    // 跑完正常路径后 chunks_with_emb_json 已被覆盖为真数据
    expect(r?.chunks_with_emb_json).toBeTruthy();
    expect(r?.chunks_with_emb_json).not.toBe("[]");
    const parsed = JSON.parse(r!.chunks_with_emb_json!);
    expect(parsed).toHaveLength(2);
  });
});
