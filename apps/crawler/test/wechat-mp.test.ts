import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fetchWechatMpArticle } from "../src/sources/wechat-mp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures/wechat-mp-article.html");

function loadFixture(): string {
  return readFileSync(FIXTURE_PATH, "utf-8");
}

function mockFetchFixture(): typeof fetch {
  return (async (_url: string) => {
    return new Response(loadFixture(), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
}

describe("fetchWechatMpArticle", () => {
  it("extracts title from #activity-name (overrides og:title)", async () => {
    const doc = await fetchWechatMpArticle("https://mp.weixin.qq.com/s/abc", {
      fetchImpl: mockFetchFixture(),
    });
    expect(doc.title).toBe("宝宝发烧38.5度怎么办？儿科医生这样说");
  });

  it("extracts account from #js_name (公众号名)", async () => {
    const doc = await fetchWechatMpArticle("https://mp.weixin.qq.com/s/abc", {
      fetchImpl: mockFetchFixture(),
    });
    expect(doc.platformSpecific?.author).toBe("儿科王医生");
  });

  it("extracts publishedAt from #publish_time text", async () => {
    const doc = await fetchWechatMpArticle("https://mp.weixin.qq.com/s/abc", {
      fetchImpl: mockFetchFixture(),
    });
    expect(doc.platformSpecific?.publishedAt).toBe("2026-06-08 14:23");
  });

  it("filters display:none (广告段落) from paragraphs", async () => {
    const doc = await fetchWechatMpArticle("https://mp.weixin.qq.com/s/abc", {
      fetchImpl: mockFetchFixture(),
    });
    // fixture 5 段，1 段 style="display:none" 应被过滤 → 4 段
    expect(doc.paragraphs.length).toBe(4);
    expect(doc.paragraphs.find((p) => p.includes("赞助"))).toBeUndefined();
    expect(doc.totalChars).toBeGreaterThan(100);
  });
});
