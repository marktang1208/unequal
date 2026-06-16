/**
 * M6.3a admin lib/api.ts handleApiResponse 401 handler 测试（spec §5.4 / plan §4 task 7）。
 *
 * 当前 admin 仅有 adminLogin 一个 fetch 端点，handleApiResponse 是备件 lib。
 * 本测试验证 401 时 localStorage "admin_token" 被清除 + window.location.href 跳 /login。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleApiResponse } from "./api.js";

beforeEach(() => {
  localStorage.clear();
  // jsdom 不允许直接修改 window.location.href，需替换整个 location 对象
  delete (window as { location?: unknown }).location;
  (window as { location: { href: string } }).location = { href: "" };
});

afterEach(() => {
  // 不需 restore — 每个 beforeEach 重建
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