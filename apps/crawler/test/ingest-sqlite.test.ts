/**
 * P3-7 / Phase B: ingest-sqlite 单元测试
 *
 * 测 ingestCrawlerMarkdown 写 local_ingest 表 + 校验 chunks。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StatusStore } from "@unequal/local-llm";
import { ingestCrawlerMarkdown, type CrawlerChunk } from "../src/ingest-sqlite.js";

function makeChunks(n: number, dim: number = 1536): CrawlerChunk[] {
  return Array.from({ length: n }, (_, i) => ({
    content: `chunk ${i} content for testing`,
    embedding: new Array(dim).fill(0.1 * (i + 1)),
    idx: i,
    token_count: 10,
  }));
}

describe("ingestCrawlerMarkdown (P3-7)", () => {
  let tmpDir: string;
  let store: StatusStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "crawler-test-"));
    store = new StatusStore(join(tmpDir, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("happy: 5 chunks → file_id + batch_id + status=pending 写入 SQLite", () => {
    const r = ingestCrawlerMarkdown(store, {
      url: "https://example.com/article-123",
      title: "婴儿发烧 38.5℃",
      sourceType: "webpage",
      markdown: "# 婴儿发烧\n\n先观察精神状态...",
      chunks: makeChunks(5),
      trustLevel: 1,
    });
    expect(r.file_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(r.batch_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(r.status).toBe("pending");

    const record = store.getByFileId(r.file_id);
    expect(record).not.toBeNull();
    expect(record?.status).toBe("pending");
    expect(record?.markdown).toContain("婴儿发烧");
    expect(record?.chunks_count).toBe(5);
    expect(record?.markdown_chars).toBeGreaterThan(0);
    expect(record?.ext).toBe("crawler");        // 临时区分
    expect(record?.filename).toBe("article-123"); // URL 末段
  });

  it("chunks 为空 → 抛 NO_CHUNKS-style error", () => {
    expect(() =>
      ingestCrawlerMarkdown(store, {
        url: "https://example.com/x",
        sourceType: "webpage",
        markdown: "x",
        chunks: [],
        trustLevel: 1,
      }),
    ).toThrow(/chunks must be non-empty/);
  });

  it("embedding dim != 1536 → 抛 DIM_MISMATCH-style error", () => {
    expect(() =>
      ingestCrawlerMarkdown(store, {
        url: "https://example.com/x",
        sourceType: "webpage",
        markdown: "x",
        chunks: makeChunks(1, 768),   // 768 维错
        trustLevel: 1,
      }),
    ).toThrow(/embedding must be number\[1536\]/);
  });

  it("filename 推导：URL 末段", () => {
    const r = ingestCrawlerMarkdown(store, {
      url: "https://blog.example.com/posts/2026/weaning-guide",
      sourceType: "webpage",
      markdown: "x",
      chunks: makeChunks(1),
      trustLevel: 0,
    });
    const record = store.getByFileId(r.file_id);
    expect(record?.filename).toBe("weaning-guide");
  });

  it("filename 推导：URL 末段空 → 用 title", () => {
    const r = ingestCrawlerMarkdown(store, {
      url: "https://example.com/",
      title: "无 URL 末段时用 title",
      sourceType: "webpage",
      markdown: "x",
      chunks: makeChunks(1),
      trustLevel: 0,
    });
    const record = store.getByFileId(r.file_id);
    expect(record?.filename).toBe("无 URL 末段时用 title");
  });

  it("trust_level + sourceType 透传", () => {
    const r = ingestCrawlerMarkdown(store, {
      url: "https://xhs.example.com/note/abc",
      sourceType: "xhs",
      markdown: "小红书笔记内容",
      chunks: makeChunks(3),
      trustLevel: 2,
    });
    const record = store.getByFileId(r.file_id);
    expect(record?.chunks_count).toBe(3);
    expect(record?.markdown).toBe("小红书笔记内容");
  });

  /** P3-7 / Phase C: source 列写 "crawler"（区分 upload 路径） */
  it("P3-7 / Phase C: 写入时 source='crawler'（不被默认 'upload' 覆盖）", () => {
    const r = ingestCrawlerMarkdown(store, {
      url: "https://example.com/x",
      sourceType: "webpage",
      markdown: "x",
      chunks: makeChunks(1),
      trustLevel: 1,
    });
    const record = store.getByFileId(r.file_id);
    expect(record?.source).toBe("crawler");
    // 同时 listBySource("crawler") 也能查到
    const crawlerRows = store.listBySource("crawler");
    expect(crawlerRows.map((r) => r.file_id)).toContain(r.file_id);
  });

  it("chunks_json 正确序列化（admin UI 推送时用）", () => {
    const chunks = makeChunks(2);
    const r = ingestCrawlerMarkdown(store, {
      url: "https://x",
      sourceType: "webpage",
      markdown: "x",
      chunks,
      trustLevel: 1,
    });
    const record = store.getByFileId(r.file_id);
    expect(record?.chunks_json).toBe(JSON.stringify(chunks));
    const parsed = JSON.parse(record?.chunks_json ?? "[]");
    expect(parsed[0].embedding).toHaveLength(1536);
  });
});
