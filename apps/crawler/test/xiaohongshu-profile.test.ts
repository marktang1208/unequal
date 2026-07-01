/**
 * xhs 博主主页抓取 fetchXhsProfileNotes 单元测试
 *
 * 测：
 * - 真丁香妈妈 HTML fixture: 解出 6 note + userInfo
 * - captcha 拦截（HTML 无 SSR state）→ Error
 * - HTTP 404 → Error
 * - URL 路由判断 isXhsProfileUrl
 *
 * v1 fetchXiaohongshuNote 单测在 xiaohongshu.test.ts 已有，本文件专注 v2。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "url";
import { fetchXhsProfileNotes, isXhsProfileUrl } from "../src/sources/xiaohongshu.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const XHS_FIXTURE = resolve(__dirname, "fixtures/xhs-dingxiangmama-profile.html");
const XHS_PROFILE_URL = "https://www.xiaohongshu.com/user/profile/5c010c88000000000801ae4f?xsec_token=AB6QF4raPMwn3H1esA3tf4xPSLai1SNIw8aoRFwMpvDpU%3D&xsec_source=pc_search";

describe("fetchXhsProfileNotes (v2)", () => {
  it("happy: 真丁香妈妈 HTML → 6 note 解出", async () => {
    const html = readFileSync(XHS_FIXTURE, "utf-8");
    const fetchMock: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe(XHS_PROFILE_URL);
      return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    };

    const docs = await fetchXhsProfileNotes(XHS_PROFILE_URL, { fetchImpl: fetchMock });
    expect(docs.length).toBeGreaterThanOrEqual(6);

    const first = docs[0]!;
    expect(first.url).toMatch(/^https:\/\/www\.xiaohongshu\.com\/explore\/[a-f0-9]{32}$/);
    expect(first.title.length).toBeGreaterThan(0);
    expect(first.paragraphs.length).toBeGreaterThan(0);
    // profile 模式拼占位段（含 title/作者/点赞）
    expect(first.paragraphs[0]).toContain(first.title);
    expect(first.platformSpecific?.author).toBeTruthy();
    expect(first.fetchedAt).toBeGreaterThan(0);
  });

  it("note URL 派生自 id (explore/<id>)，不是原 profile URL", async () => {
    const html = readFileSync(XHS_FIXTURE, "utf-8");
    const fetchMock: typeof fetch = async () =>
      new Response(html, { status: 200 });

    const docs = await fetchXhsProfileNotes(XHS_PROFILE_URL, { fetchImpl: fetchMock });
    for (const d of docs) {
      expect(d.url).not.toBe(XHS_PROFILE_URL);
      expect(d.url).toContain("/explore/");
    }
  });

  it("captcha 拦截（HTML 无 SSR state）→ 抛 Error 含 'SSR state not found'", async () => {
    // 模拟 captcha 拦截页：HTTP 200 但 HTML 是登录页，无 window.__INITIAL_STATE__
    const captchaHtml = "<html><body>登录验证</body></html>";
    const fetchMock: typeof fetch = async () =>
      new Response(captchaHtml, { status: 200 });

    await expect(
      fetchXhsProfileNotes(XHS_PROFILE_URL, { fetchImpl: fetchMock })
    ).rejects.toThrow(/SSR state not found|captcha/i);
  });

  it("HTTP 404 → 抛 Error 含 '404'", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response("not found", { status: 404 });

    await expect(
      fetchXhsProfileNotes(XHS_PROFILE_URL, { fetchImpl: fetchMock })
    ).rejects.toThrow(/404/);
  });

  it("profile 无 noteData（罕见 SSR）→ 返空数组", async () => {
    const html = 'window.__INITIAL_STATE__ = {"profile": {"userInfo": {"nickname": "empty"}, "noteData": {}}};';
    const fetchMock: typeof fetch = async () =>
      new Response(html, { status: 200 });

    const docs = await fetchXhsProfileNotes(XHS_PROFILE_URL, { fetchImpl: fetchMock });
    expect(docs).toEqual([]);
  });

  it("fetch 网络错误 → 抛 Error", async () => {
    const fetchMock: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    await expect(
      fetchXhsProfileNotes(XHS_PROFILE_URL, { fetchImpl: fetchMock })
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("isXhsProfileUrl", () => {
  it("user/profile/<id> → true", () => {
    expect(isXhsProfileUrl("https://www.xiaohongshu.com/user/profile/5c010c88000000000801ae4f")).toBe(true);
    expect(isXhsProfileUrl("https://www.xiaohongshu.com/user/profile/5c010c88000000000801ae4f?xsec_token=ABC")).toBe(true);
  });

  it("explore/<id> 单帖 URL → false", () => {
    expect(isXhsProfileUrl("https://www.xiaohongshu.com/explore/abc123def456")).toBe(false);
  });

  it("其他 URL → false", () => {
    expect(isXhsProfileUrl("https://example.com/foo")).toBe(false);
  });
});