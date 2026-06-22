/**
 * P3-7: SeedsLoader 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SeedsLoader } from "../src/seeds-loader.js";
import { SeedsStore } from "@unequal/local-llm";

describe("SeedsLoader (P3-7)", () => {
  let tmpDir: string;
  let dbPath: string;
  let seedsDir: string;
  let store: SeedsStore;
  let loader: SeedsLoader;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "seeds-loader-"));
    dbPath = join(tmpDir, "test.db");
    seedsDir = join(tmpDir, "seeds");
    store = new SeedsStore(dbPath, seedsDir);
    // 预填 3 个 URL: 2 active + 1 inactive
    void store.add("xhs", "https://www.xiaohongshu.com/explore/1", 0);
    void store.add("xhs", "https://www.xiaohongshu.com/explore/2", 1);
    void store.add("wechat-mp", "https://mp.weixin.qq.com/s/1", 2).then(async () => {
      await store.toggleActive("wechat-mp", "https://mp.weixin.qq.com/s/1", false);
    });
    loader = new SeedsLoader(dbPath);
  });
  afterEach(() => {
    store.close();
    loader.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadOne: xhs active filter", async () => {
    // 等 beforeEach 的 async 完
    await new Promise((r) => setTimeout(r, 10));
    const records = loader.loadOne("xhs");
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.source === "xhs")).toBe(true);
    expect(records.every((r) => r.active)).toBe(true);
  });

  it("loadAll: 跨 source 合并 + active 过滤", async () => {
    await new Promise((r) => setTimeout(r, 10));
    const records = loader.loadAll();
    // xhs 2 active + wechat-mp 1 inactive (过滤掉) = 2
    expect(records).toHaveLength(2);
  });

  it("loadAll: 排序: active DESC + last_crawled_at IS NULL DESC + ASC", async () => {
    await new Promise((r) => setTimeout(r, 10));
    // markCrawled 其中一个
    loader.markCrawled("https://www.xiaohongshu.com/explore/1", "done");
    const records = loader.loadAll();
    // 期望：未拉过（last_crawled_at null）排前
    expect(records[0]?.url).toBe("https://www.xiaohongshu.com/explore/2");
    expect(records[1]?.url).toBe("https://www.xiaohongshu.com/explore/1");
  });

  it("limit: 限制返回数量", async () => {
    await new Promise((r) => setTimeout(r, 10));
    const records = loader.loadAll({ limit: 1 });
    expect(records).toHaveLength(1);
  });

  it("markCrawled: 更新 last_crawled_at + last_status + retry_count", async () => {
    await new Promise((r) => setTimeout(r, 10));
    const before = loader.loadOne("xhs").find((r) => r.url === "https://www.xiaohongshu.com/explore/1");
    const beforeRetry = before?.retry_count ?? 0;
    const beforeCrawled = before?.last_crawled_at_ms;

    loader.markCrawled("https://www.xiaohongshu.com/explore/1", "done");
    const after = loader.loadOne("xhs").find((r) => r.url === "https://www.xiaohongshu.com/explore/1");
    expect(after?.last_status).toBe("done");
    expect(after?.last_crawled_at_ms).not.toBeNull();
    expect(after?.last_crawled_at_ms).not.toBe(beforeCrawled);
    expect(after?.retry_count).toBe(beforeRetry + 1);
  });
});