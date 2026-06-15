/**
 * URL 去重（client-side localStorage，M5 mock-first 范围）。
 * v2+ 改为调 /sources?url=... 后端查 D1。
 */

const STORAGE_KEY = "unequal_seen_urls";
const MAX_ENTRIES = 100;

export function addUrl(url: string): void {
  const seen = getSeenUrls();
  if (seen.includes(url)) return;
  seen.push(url);
  // FIFO: 超 100 条砍前面的
  if (seen.length > MAX_ENTRIES) {
    seen.splice(0, seen.length - MAX_ENTRIES);
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seen));
  } catch {
    // localStorage 满 / disabled：静默忽略
  }
}

export function isUrlSeen(url: string): boolean {
  return getSeenUrls().includes(url);
}

export function getSeenUrls(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 测试用：reset module-level state（仅用于 dedupe.test.ts） */
export function _resetForTest(): void {
  // 当前实现完全基于 localStorage，无 module-level state — 留空以保持 API 稳定
}
