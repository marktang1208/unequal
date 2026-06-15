import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchUrl } from "../src/sources/webpage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_HTML = readFileSync(resolve(__dirname, "fixtures/sample-article.html"), "utf-8");

describe("fetchUrl", () => {
  it("happy: fetch 200 + HTML → CrawledDocument (title + paragraphs + totalChars + fetchedAt)", async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://example.com/article");
      return new Response(FIXTURE_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    };

    const r = await fetchUrl("https://example.com/article", { fetchImpl: fetchMock });
    expect(r.url).toBe("https://example.com/article");
    expect(r.title).toBe("婴儿发烧 38.5℃ 的家庭处理");
    expect(r.paragraphs.length).toBe(4);
    expect(r.totalChars).toBeGreaterThan(100);
    expect(r.fetchedAt).toBeGreaterThan(0);
  });

  it("fetch 404 → 抛 Error 含 '404'", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response("not found", { status: 404 });
    await expect(fetchUrl("https://example.com/404", { fetchImpl: fetchMock })).rejects.toThrow(/404/);
  });

  it("fetch 500 → 抛 Error 含 '500'", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response("server error", { status: 500 });
    await expect(fetchUrl("https://example.com/500", { fetchImpl: fetchMock })).rejects.toThrow(/500/);
  });

  it("fetch 网络错误 (fetch reject) → 抛 Error", async () => {
    const fetchMock: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(fetchUrl("https://example.com/down", { fetchImpl: fetchMock })).rejects.toThrow(/ECONNREFUSED/);
  });
});
