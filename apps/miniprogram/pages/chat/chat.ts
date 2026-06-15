// @ts-nocheck wx 全局类型 mock-first 缺失（miniprogram-api-typings 未安装，按 CP-1 决策容忍）
import { ask } from "../../lib/api.js";
import {
  loadHistory,
  appendHistory,
  __setStorageImpl,
} from "../../lib/storage.js";
import type { AskResponse, HistoryEntry } from "../../lib/types.js";

// 注入 wx storage 实现（运行时由小程序 runtime 提供，测试桩 vitest 替换）
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

interface MessageItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  cached: boolean;
  citations: AskResponse["citations"];
}

const MAX_HISTORY_RENDER = 10;

interface AppWithGlobals {
  globalData: { apiBaseUrl: string };
}

Page({
  data: {
    messages: [] as MessageItem[],
    q: "",
    submitting: false,
    error: "",
  },

  onLoad(): void {
    this.loadFromStorage();
  },

  onShow(): void {
    this.loadFromStorage();
  },

  loadFromStorage(): void {
    const entries = loadHistory().slice(0, MAX_HISTORY_RENDER);
    const messages: MessageItem[] = [];
    for (const e of entries.slice().reverse()) {
      messages.push({
        id: `${e.q}-q`,
        role: "user",
        text: e.q,
        cached: false,
        citations: [],
      });
      messages.push({
        id: `${e.q}-a`,
        role: "assistant",
        text: e.answer,
        cached: e.cached,
        citations: e.citations,
      });
    }
    this.setData({ messages });
  },

  onQInput(e: WechatMiniprogram.Input): void {
    this.setData({ q: e.detail.value });
  },

  onSubmit(): void {
    if (this.data.submitting) return;
    const q = this.data.q.trim();
    if (!q) return;

    const userMsg: MessageItem = {
      id: `${q}-${Date.now()}-u`,
      role: "user",
      text: q,
      cached: false,
      citations: [],
    };
    this.setData({
      messages: [...this.data.messages, userMsg],
      q: "",
      submitting: true,
      error: "",
    });

    void this.callAsk(q);
  },

  async callAsk(q: string): Promise<void> {
    const app = getApp<AppWithGlobals>();
    const baseUrl = app?.globalData?.apiBaseUrl ?? "http://localhost:8787";
    try {
      const resp: AskResponse = await ask(q, { baseUrl });
      const botMsg: MessageItem = {
        id: `${q}-${Date.now()}-a`,
        role: "assistant",
        text: resp.answer,
        cached: resp.cached,
        citations: resp.citations,
      };
      this.setData({
        messages: [...this.data.messages, botMsg],
        submitting: false,
      });
      appendHistory({
        q,
        answer: resp.answer,
        citations: resp.citations,
        cached: resp.cached,
        timestamp: Date.now(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "未知错误";
      this.setData({
        submitting: false,
        error: msg,
      });
    }
  },

  onTapCitation(): void {
    // citation-card 自带 bindtap 触发 wx.navigateTo，无需在父页处理
  },
});
