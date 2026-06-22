/**
 * P3-7 种子 URL 库: SeedsStore 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SeedsStore } from "../src/seeds-store.js";

describe("SeedsStore (P3-7)", () => {
  let tmpDir: string;
  let dbPath: string;
  let seedsDir: string;
  let store: SeedsStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "seeds-store-"));
    dbPath = join(tmpDir, "test.db");
    seedsDir = join(tmpDir, "seeds");
    store = new SeedsStore(dbPath, seedsDir);
  });
  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("add: 写 SQLite + 自动建 JSON 文件 + 文件内容正确", async () => {
    const r = await store.add("xhs", "https://www.xiaohongshu.com/explore/test1", 0);
    expect(r.url).toBe("https://www.xiaohongshu.com/explore/test1");
    expect(r.source).toBe("xhs");
    expect(r.trust_level).toBe(0);
    expect(r.active).toBe(true);

    // 验证 JSON 文件
    const file = store.loadFile("xhs");
    expect(file).not.toBeNull();
    expect(file?.urls).toHaveLength(1);
    expect(file?.urls[0]?.url).toBe("https://www.xiaohongshu.com/explore/test1");
    expect(file?.version).toBe(1);
  });

  it("add: URL 已存在 → throw", async () => {
    await store.add("xhs", "https://www.xiaohongshu.com/explore/dup", 0);
    await expect(store.add("xhs", "https://www.xiaohongshu.com/explore/dup", 1)).rejects.toThrow(/already exists/);
  });

  it("add: trust_level 非法 → throw", async () => {
    await expect(store.add("xhs", "https://x.com/x", 5 as any)).rejects.toThrow(/trust_level/);
  });

  it("add: URL 非法 → throw", async () => {
    await expect(store.add("xhs", "not-a-url", 0)).rejects.toThrow(/url invalid/);
  });

  it("add: source 非法 → throw", async () => {
    await expect(store.add("invalid" as any, "https://x.com/x", 0)).rejects.toThrow(/invalid source/);
  });

  it("toggleActive: 写 SQLite + 同步 JSON", async () => {
    await store.add("xhs", "https://www.xiaohongshu.com/explore/test-toggle", 0);
    await store.toggleActive("xhs", "https://www.xiaohongshu.com/explore/test-toggle", false);

    const fromDb = store.getByUrl("https://www.xiaohongshu.com/explore/test-toggle");
    expect(fromDb?.active).toBe(false);

    const file = store.loadFile("xhs");
    expect(file?.urls[0]?.active).toBe(false);
  });

  it("remove: 删 SQLite + JSON", async () => {
    await store.add("xhs", "https://www.xiaohongshu.com/explore/test-rm", 0);
    await store.remove("xhs", "https://www.xiaohongshu.com/explore/test-rm");

    const fromDb = store.getByUrl("https://www.xiaohongshu.com/explore/test-rm");
    expect(fromDb).toBeNull();

    const file = store.loadFile("xhs");
    expect(file?.urls).toHaveLength(0);
  });

  it("updateTrustLevel: 写 SQLite + JSON", async () => {
    await store.add("xhs", "https://www.xiaohongshu.com/explore/test-trust", 0);
    await store.updateTrustLevel("xhs", "https://www.xiaohongshu.com/explore/test-trust", 3);

    const fromDb = store.getByUrl("https://www.xiaohongshu.com/explore/test-trust");
    expect(fromDb?.trust_level).toBe(3);

    const file = store.loadFile("xhs");
    expect(file?.urls[0]?.trust_level).toBe(3);
  });

  it("syncFromJson: 读 JSON → 写 SQLite (INSERT OR REPLACE)", () => {
    // 预写 JSON 文件
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(seedsDir, { recursive: true });
    fs.writeFileSync(join(seedsDir, "xhs.json"), JSON.stringify({
      source: "xhs",
      version: 1,
      updated_at: "2026-06-22T12:00:00Z",
      urls: [
        { url: "https://www.xiaohongshu.com/explore/from-json-1", trust_level: 1, active: true, last_crawled_at: null, last_status: null },
        { url: "https://www.xiaohongshu.com/explore/from-json-2", trust_level: 2, active: false, last_crawled_at: null, last_status: null },
      ],
    }, null, 2));

    const records = store.syncFromJson("xhs");
    expect(records).toHaveLength(2);

    const list = store.listBySource("xhs");
    expect(list).toHaveLength(2);
    expect(list.find((r) => r.url === "https://www.xiaohongshu.com/explore/from-json-2")?.active).toBe(false);
  });

  it("syncFromJson: 保留已有 last_crawled_at (runtime 字段不丢)", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(seedsDir, { recursive: true });
    fs.writeFileSync(join(seedsDir, "xhs.json"), JSON.stringify({
      source: "xhs",
      version: 1,
      updated_at: "2026-06-22T12:00:00Z",
      urls: [
        { url: "https://www.xiaohongshu.com/explore/runtime-keep", trust_level: 0, active: true, last_crawled_at: null, last_status: null },
      ],
    }, null, 2));

    // 1. sync 一次，写入 SQLite
    store.syncFromJson("xhs");
    // 2. 模拟 crawler 标记 crawled
    store.markCrawled("https://www.xiaohongshu.com/explore/runtime-keep", "done");
    const afterCrawl = store.getByUrl("https://www.xiaohongshu.com/explore/runtime-keep");
    const crawledAtMs = afterCrawl?.last_crawled_at_ms;
    expect(crawledAtMs).not.toBeNull();

    // 3. 再次 sync（同一 URL），runtime 字段应保留
    store.syncFromJson("xhs");
    const afterReSync = store.getByUrl("https://www.xiaohongshu.com/explore/runtime-keep");
    expect(afterReSync?.last_crawled_at_ms).toBe(crawledAtMs);  // 保留
    expect(afterReSync?.last_status).toBe("done");  // 保留
  });

  it("markCrawled: 更新 last_crawled_at + last_status + retry_count", async () => {
    await store.add("xhs", "https://www.xiaohongshu.com/explore/mark-test", 0);
    const before = store.getByUrl("https://www.xiaohongshu.com/explore/mark-test");
    const beforeRetry = before?.retry_count ?? 0;

    store.markCrawled("https://www.xiaohongshu.com/explore/mark-test", "done");
    const after = store.getByUrl("https://www.xiaohongshu.com/explore/mark-test");
    expect(after?.last_status).toBe("done");
    expect(after?.last_crawled_at_ms).not.toBeNull();
    expect(after?.retry_count).toBe(beforeRetry + 1);
  });

  it("markCrawled: 失败 URL 写 last_error", async () => {
    await store.add("xhs", "https://www.xiaohongshu.com/explore/fail-test", 0);
    store.markCrawled("https://www.xiaohongshu.com/explore/fail-test", "failed", "ECONNREFUSED");
    const after = store.getByUrl("https://www.xiaohongshu.com/explore/fail-test");
    expect(after?.last_status).toBe("failed");
    expect(after?.last_error).toBe("ECONNREFUSED");
  });

  it("listBySource: 按 active DESC + last_crawled_at IS NULL DESC + last_crawled_at ASC 排序", async () => {
    // active=true 排前，null crawled 排前
    await store.add("xhs", "https://a.com/1", 0);
    await store.add("xhs", "https://a.com/2", 0);
    await store.add("xhs", "https://a.com/3", 0);

    store.markCrawled("https://a.com/3", "done");
    await store.toggleActive("xhs", "https://a.com/2", false);

    const list = store.listBySource("xhs");
    // 期望顺序：active=true (1, 3, 然后 null crawled 优先) → active=false (2)
    // 1: active=true, last_crawled_at=null → 优先
    // 3: active=true, last_crawled_at=now → 次之
    // 2: active=false → 最后
    expect(list[0]?.url).toBe("https://a.com/1");
    expect(list[1]?.url).toBe("https://a.com/3");
    expect(list[2]?.url).toBe("https://a.com/2");
  });
});