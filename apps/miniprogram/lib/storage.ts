import type { HistoryEntry } from "./types.js";

const STORAGE_KEY = "unequal:history";
const MAX_ENTRIES = 50;

/**
 * 小程序端历史问答 localStorage 封装。
 * 真机运行时由 wx.getStorageSync/wx.setStorageSync 替代（Task 15 chat 页）。
 * 本步骤只提供抽象层 + 测试桩，方便 Vitest 单测。
 */

export function loadHistory(): HistoryEntry[] {
  // 测试桩：单元测试中替换；运行时由 chat 页用 wx.getStorageSync 包装
  return _loadHistoryImpl();
}

export function saveHistory(entries: HistoryEntry[]): void {
  const trimmed = entries.slice(0, MAX_ENTRIES);
  _saveHistoryImpl(trimmed);
}

export function appendHistory(entry: HistoryEntry): HistoryEntry[] {
  const existing = loadHistory();
  const next = [entry, ...existing].slice(0, MAX_ENTRIES);
  saveHistory(next);
  return next;
}

export function clearHistory(): void {
  saveHistory([]);
}

// 默认实现：测试中通过 stub 替换
let _loadHistoryImpl: () => HistoryEntry[] = () => [];
let _saveHistoryImpl: (entries: HistoryEntry[]) => void = () => {};

export function __setStorageImpl(
  load: () => HistoryEntry[],
  save: (entries: HistoryEntry[]) => void,
): void {
  _loadHistoryImpl = load;
  _saveHistoryImpl = save;
}

export function __resetStorageImpl(): void {
  _loadHistoryImpl = () => [];
  _saveHistoryImpl = () => {};
}
