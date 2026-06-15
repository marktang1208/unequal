// @ts-nocheck wx 全局类型 mock-first 缺失（miniprogram-api-typings 未安装，按 CP-1 决策容忍）
import {
  loadHistory,
  clearHistory,
  __setStorageImpl,
} from "../../lib/storage.js";
import type { HistoryEntry } from "../../lib/types.js";

// 注入 wx storage 实现
// @ts-expect-error wx 全局类型 mock-first 缺失
__setStorageImpl(
  // @ts-nocheck wx 全局类型 mock-first 缺失
  // wx.getStorageSync 缺失 key 时返回 ""（空字符串），不是 null/undefined；
  // 空字符串 .slice() 工作但 .reverse() 抛 TypeError。用 Array.isArray 守门。
  () => {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    const raw = wx.getStorageSync("unequal:history");
    return Array.isArray(raw) ? (raw as HistoryEntry[]) : [];
  },
  // @ts-nocheck wx 全局类型 mock-first 缺失
  (entries: HistoryEntry[]) => {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.setStorageSync("unequal:history", entries);
  },
);

Page({
  data: {
    entries: [] as HistoryEntry[],
    loading: false,
  },

  onShow(): void {
    this.refresh();
  },

  refresh(): void {
    this.setData({ loading: true });
    const entries = loadHistory();
    this.setData({ entries, loading: false });
  },

  onAskAgain(e: WechatMiniprogram.TouchEvent): void {
    const q = (e.currentTarget.dataset.q as string | undefined) ?? "";
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.redirectTo({
      url: `/pages/chat/chat?q=${encodeURIComponent(q)}`,
    });
  },

  onClear(): void {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.showModal({
      title: "清空历史",
      content: "确认清空全部历史问答？此操作不可撤销。",
      success: (res: { confirm: boolean }) => {
        if (res.confirm) {
          clearHistory();
          this.setData({ entries: [] });
        }
      },
    });
  },
});
