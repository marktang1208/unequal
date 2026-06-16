/**
 * M6.3a admin lib/api.ts handleApiResponse 401 handler 测试（spec §5.4 / plan §4 task 7）。
 *
 * 当前 admin 仅有 adminLogin 一个 fetch 端点，handleApiResponse 是备件 lib。
 * 本测试验证 401 时 localStorage "admin_token" 被清除 + window.location.href 跳 /login。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleApiResponse, ask, chat, listSessions, renameSession, deleteSession, uploadFile, search, crawlUrl } from "./api.js";
import fs from "node:fs";
import path from "node:path";

beforeEach(() => {
  localStorage.clear();
  // jsdom 不允许直接修改 window.location.href，需替换整个 location 对象
  delete (window as { location?: unknown }).location;
  (window as { location: { href: string } }).location = { href: "" };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleApiResponse (M6.3a B3 — 401 handler)", () => {
  it("收到 401 → localStorage admin_token 被清除 + window.location.href 设为 /login", () => {
    // 预先写入 admin_token
    localStorage.setItem("admin_token", "eyJhbGciOiJIUzI1NiJ9.xxx");
    expect(localStorage.getItem("admin_token")).toBe(
      "eyJhbGciOiJIUzI1NiJ9.xxx",
    );

    const fakeRes = new Response("{}" satisfies string, { status: 401 });
    const result = handleApiResponse(fakeRes);

    // 原 Response 应被透传
    expect(result).toBe(fakeRes);
    expect(result.status).toBe(401);

    // localStorage 应被清除
    expect(localStorage.getItem("admin_token")).toBeNull();

    // window.location.href 应跳 /login
    expect(window.location.href).toBe("/login");
  });
});

describe("认证 fetch 调用点 wrap handleApiResponse (M6.3a D2)", () => {
  it("ask() mock fetch 返 401 → 抛 /ask 401 + 副作用清 token + 跳 /login", async () => {
    // 注入有效 token，让 getToken() 不走 throw 分支
    localStorage.setItem("admin_token", "expired-jwt-token");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "jwt expired" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    // ask() 应 throw Error（包含 "/ask 401"）
    await expect(ask("test query")).rejects.toThrow(/ask 401/);

    // handleApiResponse 副作用已触发
    expect(localStorage.getItem("admin_token")).toBeNull();
    expect(window.location.href).toBe("/login");
  });

  it("authedJson 共用 fetch 点 (chat) mock 返 401 → 抛 /chat 401 + 副作用清 token + 跳 /login", async () => {
    // authedJson 是 chat / listSessions / renameSession / deleteSession 共用的私有 helper。
    // 任一调用都会触发 wrap，这里用 chat 覆盖，listSessions/renameSession/deleteSession 走同路径。
    localStorage.setItem("admin_token", "expired-jwt-token");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "jwt expired" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(chat("test query")).rejects.toThrow(/chat 401/);

    expect(localStorage.getItem("admin_token")).toBeNull();
    expect(window.location.href).toBe("/login");
  });

  it("grep api.ts 源码：5 个认证 fetch 调用点都 wrap handleApiResponse（防回退）", () => {
    // 静态 source-of-truth 测试：确保未来 refactor 不会悄悄 unwrap 任意一个认证 fetch。
    // 如果有人移除某处 wrap，本测试会失败并指出哪个函数漏了。
    const apiSrc = fs.readFileSync(
      path.join(__dirname, "api.ts"),
      "utf-8",
    );

    // 5 个认证 fetch 调用点必须都出现 handleApiResponse(...)
    // 注意正则用 [\s\S]* 通配跨行，确保 wrap 在 fetch 表达式外层
    const patterns: Array<{ fn: string; re: RegExp }> = [
      { fn: "uploadFile", re: /uploadFile[\s\S]*?handleApiResponse/ },
      { fn: "search", re: /\bsearch\b[\s\S]*?handleApiResponse/ },
      { fn: "ask", re: /\bask\b[\s\S]*?handleApiResponse/ },
      { fn: "authedJson", re: /authedJson[\s\S]*?handleApiResponse/ },
      { fn: "crawlUrl", re: /crawlUrl[\s\S]*?handleApiResponse/ },
    ];

    for (const { fn, re } of patterns) {
      expect(
        apiSrc,
        `${fn} 函数应 wrap handleApiResponse（spec §5.4 / §7.3 401 自动跳 /login）`,
      ).toMatch(re);
    }
  });
});