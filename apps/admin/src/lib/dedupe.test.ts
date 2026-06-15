import { describe, it, expect, beforeEach } from "vitest";
import { addUrl, isUrlSeen, getSeenUrls, _resetForTest } from "./dedupe.js";

beforeEach(() => {
  _resetForTest();
  localStorage.clear();
});

describe("dedupe", () => {
  it("addUrl + isUrlSeen returns true after add", () => {
    addUrl("https://example.com/a");
    expect(isUrlSeen("https://example.com/a")).toBe(true);
    expect(isUrlSeen("https://example.com/b")).toBe(false);
  });

  it("getSeenUrls returns all stored URLs", () => {
    addUrl("https://example.com/a");
    addUrl("https://example.com/b");
    addUrl("https://example.com/c");
    expect(getSeenUrls().sort()).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
  });

  it("caps storage at 100 entries (FIFO)", () => {
    for (let i = 0; i < 105; i++) {
      addUrl(`https://example.com/${i}`);
    }
    const all = getSeenUrls();
    expect(all.length).toBe(100);
    expect(isUrlSeen("https://example.com/0")).toBe(false);
    expect(isUrlSeen("https://example.com/104")).toBe(true);
  });

  it("handles localStorage.getItem returning null (first run)", () => {
    // 初始 _resetForTest + clear 已模拟
    expect(getSeenUrls()).toEqual([]);
    expect(isUrlSeen("https://example.com/x")).toBe(false);
  });
});
