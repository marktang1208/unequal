/**
 * PDF → CrawledDocument 单元测试
 *
 * 5 case：
 * - URL happy（mock fetchImpl 返真 PDF Buffer → pdf-parse fallback 解析成功）
 * - 本地路径 happy（real fixture 01-valid.pdf）
 * - file:// URL 走 localPath（同本地路径路径）
 * - 损坏 PDF → 抛错（fallback 都失败）
 * - 文件不存在 → 抛错
 *
 * 默认走 pdf-parse fallback（preferMineru=false）避免 CI 拉模型
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "url";
import { fetchPdf } from "../src/sources/pdf.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALID_PDF = resolve(__dirname, "fixtures/01-valid.pdf");
const INVALID_PDF = resolve(__dirname, "fixtures/03-invalid.pdf");

describe("fetchPdf", () => {
  it("URL happy: fetch 200 + 真 PDF → CrawledDocument", async () => {
    expect(existsSync(VALID_PDF)).toBe(true);
    const pdfBuf = readFileSync(VALID_PDF);

    const fetchMock: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://example.com/article.pdf");
      return new Response(pdfBuf, { status: 200, headers: { "content-type": "application/pdf" } });
    };

    const r = await fetchPdf("https://example.com/article.pdf", {
      fetchImpl: fetchMock,
      preferMineru: false,  // CI 跳过 mineru，走 pdf-parse fallback
    });
    expect(r.url).toBe("https://example.com/article.pdf");
    expect(r.title).toBe("article");  // basename 去 .pdf
    expect(r.paragraphs.length).toBeGreaterThan(5);
    expect(r.totalChars).toBeGreaterThan(1000);
    expect(r.fetchedAt).toBeGreaterThan(0);
    expect(r.platformSpecific).toBeUndefined();
  });

  it("本地路径 happy: 直接读 fs → 解析成功", async () => {
    expect(existsSync(VALID_PDF)).toBe(true);

    const r = await fetchPdf("file:///dummy/url", {
      localPath: VALID_PDF,
      preferMineru: false,
    });
    expect(r.url).toBe("file:///dummy/url");
    expect(r.title).toBe("01-valid");  // basename 去 .pdf
    expect(r.paragraphs.length).toBeGreaterThan(5);
    expect(r.totalChars).toBeGreaterThan(1000);
  });

  it("file:// URL 自动识别走本地路径", async () => {
    const r = await fetchPdf(`file://${VALID_PDF}`, {
      preferMineru: false,
    });
    expect(r.title).toBe("01-valid");
    expect(r.totalChars).toBeGreaterThan(1000);
  });

  it("损坏 PDF → pdf-parse 抛错（fallback 都失败）", async () => {
    expect(existsSync(INVALID_PDF)).toBe(true);

    await expect(
      fetchPdf("https://example.com/broken.pdf", {
        localPath: INVALID_PDF,
        preferMineru: false,
      })
    ).rejects.toThrow(/pdf-parse|pdf|invalid/i);
  });

  it("文件不存在 → 抛 Error 含 ENOENT 或 path", async () => {
    await expect(
      fetchPdf("file:///nonexistent.pdf", {
        preferMineru: false,
      })
    ).rejects.toThrow(/nonexistent\.pdf|ENOENT|fail/i);
  });

  it("fetch 404 → 抛 Error 含 '404'", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response("not found", { status: 404 });
    await expect(
      fetchPdf("https://example.com/missing.pdf", { fetchImpl: fetchMock, preferMineru: false })
    ).rejects.toThrow(/404/);
  });

  it("title 从 URL 末段提取（fetch 模式无 localPath）", async () => {
    const pdfBuf = readFileSync(VALID_PDF);
    const fetchMock: typeof fetch = async () =>
      new Response(pdfBuf, { status: 200 });

    const r = await fetchPdf("https://example.com/path/to/feeding-guide.pdf", {
      fetchImpl: fetchMock,
      preferMineru: false,
    });
    expect(r.title).toBe("feeding-guide");
  });

  it("中文 URL encoded file:// → decode 后 fs.readFile 成功", async () => {
    // 模拟 `file:///Users/Mark/Downloads/pdf/2%E3%80%81%E5%B4%94%E7%8E%89%E6%B6%9B...pdf`
    // encodeURIComponent 对中文字符 → `%E5%B4%94...`
    // pdf.ts resolveLocalPath 应 decode URI 后 fs.readFile 找原文件
    const originalPath = "/Users/Mark/Downloads/pdf/2、崔玉涛自然养育法.pdf";
    if (!existsSync(originalPath)) {
      console.warn("[skip] 本地 PDF 不存在，跳过此 case");
      return;
    }
    const encodedUrl =
      "file://" +
      originalPath.split("/").map((seg) => encodeURIComponent(seg)).join("/");
    // 验证 URL 真的被编码
    expect(encodedUrl).toContain("%E5%B4%94");

    const r = await fetchPdf(encodedUrl, { preferMineru: false });
    expect(r.title).toBe("2、崔玉涛自然养育法");
    expect(r.totalChars).toBeGreaterThan(1000);
  });

  it("扫描版 PDF (font=false) → pdf-parse 返空文本 → throw 友好提示", async () => {
    // 真 82MB 崔玉涛育儿百科扫描版测试
    const scanPdf = "/Users/Mark/Downloads/pdf/3、崔玉涛育儿百科.pdf";
    if (!existsSync(scanPdf)) {
      console.warn("[skip] 本地扫描版 PDF 不存在，跳过此 case");
      return;
    }
    await expect(
      fetchPdf("file://" + scanPdf, { preferMineru: false })
    ).rejects.toThrow(/扫描版|empty/);
  });
});