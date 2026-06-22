/**
 * P3-7 / Phase B: CrawlerTrigger.runCrawler 单元测试
 *
 * 测：单条 url 跑通整链（fetch + chunk + embed + 写 SQLite）
 * P3-7 (种子 URL 库) 阶段补: --url 走原 path, --source 走 seeds-loader
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCrawler, type CrawlerResult } from "../src/trigger.js";
import type { Embedder } from "@unequal/local-llm";
import { SeedsStore } from "@unequal/local-llm";

function fakeFetch(html: string): typeof fetch {
  return (async () => new Response(html, { status: 200 })) as typeof fetch;
}

function fakeEmbedder(dim: number = 1536): Embedder {
  return {
    embed: async (texts: string[]) =>
      texts.map((_, i) => new Array(dim).fill(0.1 * (i + 1))),
  };
}

describe("runCrawler (P3-7)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "crawler-trigger-"));
    dbPath = join(tmpDir, "trigger.db");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("happy: 1 url webpage → 跑通 fetch+chunk+embed+SQLite", async () => {
    const html = `
      <html><head><title>婴儿发烧处理</title></head><body>
        <article>
          <h1>婴儿发烧 38.5℃</h1>
          <p>婴儿发烧时先观察精神状态比体温数字更重要。</p>
          <p>对乙酰氨基酚（泰诺林）是 3 个月以上婴儿首选退烧药。</p>
        </article>
      </body></html>
    `;
    const r: CrawlerResult = await runCrawler({
      url: "https://example.com/articles/weaning-guide",
      source: "webpage",
      trustLevel: 1,
      dbPath,
      fetchImpl: fakeFetch(html),
      embedderOverride: fakeEmbedder(),
    });
    expect(r.total).toBe(1);
    expect(r.succeeded).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.file_ids).toHaveLength(1);
    expect(r.errors).toHaveLength(0);
  });

  it("1 条 fetch 失败不影响其他（partial fail 模式 v1 未实现：v1 同步串行）", async () => {
    // v1 串行：1 条失败返 r.failed=1（runCrawler 内有 try/catch）
    // 但 resolveSeedUrls 在 v1 简化下只返 1 条（opts.url）— 这个 case 只能测单条 fail
    const failFetch: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const r = await runCrawler({
      url: "https://example.com/will-fail",
      source: "webpage",
      trustLevel: 1,
      dbPath,
      fetchImpl: failFetch,
      embedderOverride: fakeEmbedder(),
    });
    expect(r.total).toBe(1);
    expect(r.succeeded).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.errors[0]?.error).toMatch(/ECONNREFUSED/);
  });

  it("无 url 无 source → 空 seed → 返 0/0/0 + 警告", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runCrawler({
      source: "xhs",
      limit: 10,
      dbPath,
      embedderOverride: fakeEmbedder(),
    });
    expect(r.total).toBe(0);
    expect(r.succeeded).toBe(0);
    expect(r.file_ids).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/no seed urls/));
    consoleSpy.mockRestore();
  });

  it("--full-scan + 无 url → 返 0/0/0（v1 简化 fullScan 暂未实现 seed 列表）", async () => {
    const r = await runCrawler({
      fullScan: true,
      source: "all",
      dbPath,
      embedderOverride: fakeEmbedder(),
    });
    expect(r.total).toBe(0);
  });

  // P3-7 种子 URL 库：--source 走 seeds-loader
  // 用 webpage source 因为 fakeFetch 返回通用 HTML（xhs/wechat-mp fetcher 期望特定选择器）
  it("P3-7: --source=webpage + seeds SQLite 有 URL → 跑通整链", async () => {
    const store = new SeedsStore(dbPath, join(tmpDir, "seeds"));
    await store.add("webpage", "https://example.com/articles/seed-1", 1);
    await store.add("webpage", "https://example.com/articles/seed-2", 1);
    store.close();

    const html = `<html><body><article><h1>seed test</h1><p>婴儿发烧时先观察精神状态比体温数字更重要。对乙酰氨基酚（泰诺林）是 3 个月以上婴儿首选退烧药。布洛芬（美林）适合 6 个月以上婴儿，需按体重计算剂量。多喝水，注意休息。</p><p>第二段。补充说明。</p></article></body></html>`;
    const r: CrawlerResult = await runCrawler({
      source: "webpage",
      dbPath,
      fetchImpl: fakeFetch(html),
      embedderOverride: fakeEmbedder(),
    });
    expect(r.total).toBe(2);
    expect(r.succeeded).toBe(2);
    expect(r.failed).toBe(0);
  });

  it("P3-7: --source=webpage + limit=1 → 只跑 1 条", async () => {
    const store = new SeedsStore(dbPath, join(tmpDir, "seeds"));
    await store.add("webpage", "https://example.com/articles/limit-1", 1);
    await store.add("webpage", "https://example.com/articles/limit-2", 1);
    await store.add("webpage", "https://example.com/articles/limit-3", 1);
    store.close();

    const html = `<html><body><article><h1>seed test</h1><p>婴儿发烧时先观察精神状态比体温数字更重要。对乙酰氨基酚（泰诺林）是 3 个月以上婴儿首选退烧药。布洛芬（美林）适合 6 个月以上婴儿，需按体重计算剂量。多喝水，注意休息。</p><p>第二段。补充说明。</p></article></body></html>`;
    const r = await runCrawler({
      source: "webpage",
      limit: 1,
      dbPath,
      fetchImpl: fakeFetch(html),
      embedderOverride: fakeEmbedder(),
    });
    expect(r.total).toBe(1);
    expect(r.succeeded).toBe(1);
  });

  it("P3-7: --url 走原 path（不读 seeds-loader）", async () => {
    // 即使 seeds 里有其他 URL，--url 优先走单条 path
    const store = new SeedsStore(dbPath, join(tmpDir, "seeds"));
    await store.add("xhs", "https://www.xiaohongshu.com/explore/seed-ignored", 0);
    store.close();

    const html = `<html><body><article><h1>seed test</h1><p>婴儿发烧时先观察精神状态比体温数字更重要。对乙酰氨基酚（泰诺林）是 3 个月以上婴儿首选退烧药。布洛芬（美林）适合 6 个月以上婴儿，需按体重计算剂量。多喝水，注意休息。</p><p>第二段。补充说明。</p></article></body></html>`;
    const r = await runCrawler({
      url: "https://www.xiaohongshu.com/explore/explicit-url",
      dbPath,
      fetchImpl: fakeFetch(html),
      embedderOverride: fakeEmbedder(),
    });
    expect(r.total).toBe(1);
    expect(r.succeeded).toBe(1);
  });
});
