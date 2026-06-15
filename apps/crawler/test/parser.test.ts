import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseHtml } from "../src/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures/sample-article.html");

describe("parseHtml", () => {
  it("happy: 提取 title + 4 段落（去 header/footer/nav/script）", () => {
    const html = readFileSync(FIXTURE_PATH, "utf-8");
    const r = parseHtml(html);
    expect(r.title).toBe("婴儿发烧 38.5℃ 的家庭处理");
    expect(r.paragraphs.length).toBe(4);
    expect(r.paragraphs[0]).toContain("婴儿发烧时先观察精神状态");
    expect(r.paragraphs[1]).toContain("不推荐用酒精擦浴");
    expect(r.paragraphs[2]).toContain("对乙酰氨基酚");
    expect(r.paragraphs[3]).toContain("三个月以下婴儿发烧");
  });

  it("段落不含 HTML 标签和 script 内容", () => {
    const html = readFileSync(FIXTURE_PATH, "utf-8");
    const r = parseHtml(html);
    for (const p of r.paragraphs) {
      expect(p).not.toMatch(/<[^>]+>/);
      expect(p).not.toContain("analytics.track");
      expect(p).not.toContain("© 2024");  // footer 不应混入
    }
  });

  it("totalChars = 段落拼接总字符数（去 HTML 后）", () => {
    const html = readFileSync(FIXTURE_PATH, "utf-8");
    const r = parseHtml(html);
    const expected = r.paragraphs.reduce((sum, p) => sum + p.length, 0);
    expect(r.totalChars).toBe(expected);
    expect(r.totalChars).toBeGreaterThan(100);
  });

  it("空 HTML: title='', paragraphs=[]", () => {
    const r = parseHtml("<html><body></body></html>");
    expect(r.title).toBe("");
    expect(r.paragraphs).toEqual([]);
    expect(r.totalChars).toBe(0);
  });
});
