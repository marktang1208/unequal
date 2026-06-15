import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fetchXiaohongshuNote } from "../src/sources/xiaohongshu.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures/xiaohongshu-note.html");

function loadFixture(): string {
  return readFileSync(FIXTURE_PATH, "utf-8");
}

/** mock fetch: 返 fixture HTML with status 200 */
function mockFetchFixture(): typeof fetch {
  return (async (_url: string) => {
    return new Response(loadFixture(), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
}

describe("fetchXiaohongshuNote", () => {
  it("extracts title from og:title meta", async () => {
    const doc = await fetchXiaohongshuNote("https://xiaohongshu.com/explore/abc123", {
      fetchImpl: mockFetchFixture(),
    });
    expect(doc.title).toBe("5个月宝宝辅食添加全攻略");
  });

  it("extracts author from .author .username", async () => {
    const doc = await fetchXiaohongshuNote("https://xiaohongshu.com/explore/abc123", {
      fetchImpl: mockFetchFixture(),
    });
    expect(doc.platformSpecific?.author).toBe("小红书用户A");
  });

  it("extracts publishedAt from article:published_time meta", async () => {
    const doc = await fetchXiaohongshuNote("https://xiaohongshu.com/explore/abc123", {
      fetchImpl: mockFetchFixture(),
    });
    expect(doc.platformSpecific?.publishedAt).toBe("2026-05-12T10:30:00+08:00");
  });

  it("extracts paragraphs from #detail-desc and computes totalChars", async () => {
    const doc = await fetchXiaohongshuNote("https://xiaohongshu.com/explore/abc123", {
      fetchImpl: mockFetchFixture(),
    });
    expect(doc.paragraphs.length).toBeGreaterThanOrEqual(4);
    expect(doc.totalChars).toBeGreaterThan(100);
    expect(doc.paragraphs[0]).toContain("米粉是首选");
  });
});
