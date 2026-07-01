/**
 * SSR state 解析 utility 单元测试
 *
 * 测：
 * - 找 marker 失败 → SsrParseError
 * - 括号不匹配 → SsrParseError
 * - undefined → null 替换
 * - 字符串内括号豁免
 * - 真 xhs fixture: 解出 userInfo + noteData
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "url";
import { extractSsrState, extractXhsProfile, SsrParseError } from "../src/sources/ssr-state-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const XHS_FIXTURE = resolve(__dirname, "fixtures/xhs-dingxiangmama-profile.html");

describe("extractSsrState", () => {
  it("happy: 真 xhs HTML → 解出 state.profile.userInfo.nickname='丁香妈妈'", () => {
    const html = readFileSync(XHS_FIXTURE, "utf-8");
    const state = extractSsrState(html) as { profile?: { userInfo?: { nickname?: string } } };
    expect(state.profile?.userInfo?.nickname).toBe("丁香妈妈");
  });

  it("happy: 解出 6 个笔记，title 不空", () => {
    const html = readFileSync(XHS_FIXTURE, "utf-8");
    const data = extractXhsProfile(extractSsrState(html));
    expect(data).not.toBeNull();
    expect(data!.notes.length).toBeGreaterThanOrEqual(6);
    expect(data!.notes[0]!.title.length).toBeGreaterThan(0);
    // id 必须是 32 位 hex
    expect(data!.notes[0]!.id).toMatch(/^[a-f0-9]{32}$/);
    // noteUrl 派生正确
    expect(data!.notes[0]!.noteUrl).toBe(`https://www.xiaohongshu.com/explore/${data!.notes[0]!.id}`);
  });

  it("happy: userInfo.fans/redId 字段", () => {
    const html = readFileSync(XHS_FIXTURE, "utf-8");
    const data = extractXhsProfile(extractSsrState(html));
    expect(data!.userInfo.nickname).toBe("丁香妈妈");
    expect(data!.userInfo.redId).toBe("Dingxiangmama");
    expect(data!.userInfo.fans).toMatch(/\d+k\+/);
  });

  it("marker 找不到 → SsrParseError", () => {
    const html = "<html><body>no SSR</body></html>";
    expect(() => extractSsrState(html)).toThrow(SsrParseError);
    expect(() => extractSsrState(html)).toThrow(/marker.*not found/);
  });

  it("undefined → null 替换（xhs SSR 必含）", () => {
    const html = 'window.__INITIAL_STATE__ = {"a": undefined, "b": 1};';
    const state = extractSsrState(html) as { a: unknown; b: number };
    expect(state.a).toBeNull();
    expect(state.b).toBe(1);
  });

  it("字符串内括号豁免（不应提早终止）", () => {
    const html = 'window.__INITIAL_STATE__ = {"a": "has } inside", "b": 2};';
    const state = extractSsrState(html) as { a: string; b: number };
    expect(state.a).toBe("has } inside");
    expect(state.b).toBe(2);
  });

  it("字符串内转义引号豁免", () => {
    const html = 'window.__INITIAL_STATE__ = {"a": "with \\"quote\\"", "b": 3};';
    const state = extractSsrState(html) as { a: string; b: number };
    expect(state.a).toBe('with "quote"');
    expect(state.b).toBe(3);
  });

  it("嵌套对象正确终止（深度 > 1）", () => {
    const html = 'window.__INITIAL_STATE__ = {"outer": {"inner": {"deep": "value"}}, "after": true};';
    const state = extractSsrState(html) as { outer: { inner: { deep: string } }; after: boolean };
    expect(state.outer.inner.deep).toBe("value");
    expect(state.after).toBe(true);
  });

  it("数组内未定义值替换", () => {
    const html = 'window.__INITIAL_STATE__ = {"arr": [undefined, 1, undefined]};';
    const state = extractSsrState(html) as { arr: Array<unknown> };
    expect(state.arr).toEqual([null, 1, null]);
  });

  it("自定义 globalKey", () => {
    const html = 'window.__CUSTOM__ = {"x": 42};';
    const state = extractSsrState(html, { globalKey: "__CUSTOM__" }) as { x: number };
    expect(state.x).toBe(42);
  });
});

describe("extractXhsProfile", () => {
  it("state 非 object → null", () => {
    expect(extractXhsProfile(null)).toBeNull();
    expect(extractXhsProfile("string")).toBeNull();
    expect(extractXhsProfile(42)).toBeNull();
  });

  it("state 无 profile → null", () => {
    expect(extractXhsProfile({})).toBeNull();
    expect(extractXhsProfile({ noteData: {} })).toBeNull();
  });

  it("profile 无 noteData → 返 userInfo + 空 notes", () => {
    const state = { profile: { userInfo: { nickname: "X" } } };
    const data = extractXhsProfile(state);
    expect(data!.userInfo.nickname).toBe("X");
    expect(data!.notes).toEqual([]);
  });
});