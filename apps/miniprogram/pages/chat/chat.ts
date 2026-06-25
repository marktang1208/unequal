// @ts-nocheck wx 全局类型 mock-first 缺失（miniprogram-api-typings 未安装，按 CP-1 决策容忍）
import { chat, updateNickname, getSession } from "../../lib/api.js";
import { getJwtToken } from "../../lib/auth.js";
import { __setStorageImpl } from "../../lib/storage.js";
import { __setSessionStorageImpl, loadCurrentSessionId, saveCurrentSessionId, hasShownNicknameModal, setShownNicknameModal, __setNicknameModalStorageImpl } from "../../lib/chat-storage.js";
import { parseAnswerSegments } from "../../lib/citation-parser.js";
import type { AskResponse, ChatResponse, HistoryEntry } from "../../lib/types.js";

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

// 注入 chat-storage 默认 wx 实现（M6.1 持久化当前 session_id）
__setSessionStorageImpl(
  // @ts-nocheck wx 全局类型 mock-first 缺失
  (key: string) => {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    const raw = wx.getStorageSync(key);
    return typeof raw === "string" ? raw : "";
  },
  // @ts-nocheck wx 全局类型 mock-first 缺失
  (key: string, value: string) => {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.setStorageSync(key, value);
  },
);

// 注入 chat-storage nickname modal 默认 wx 实现（M6.3c）
__setNicknameModalStorageImpl(
  // @ts-nocheck wx 全局类型 mock-first 缺失
  (key: string) => {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    const raw = wx.getStorageSync(key);
    return typeof raw === "string" ? raw : "";
  },
  // @ts-nocheck wx 全局类型 mock-first 缺失
  (key: string, value: string) => {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.setStorageSync(key, value);
  },
);

interface MessageItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  cached: boolean;
  citations: AskResponse["citations"];
  /** CP-7-B 新增：富文本 segments（解析 [N] 后的 text/cite 数组） */
  segments?: ReturnType<typeof parseAnswerSegments>;
  /** P9: 该 assistant 轮的 NLI 异步 verdict (命中轮询后填) */
  nliVerdict?: "entailed" | "neutral" | "contradiction";
}

interface AppWithGlobals {
  globalData: { apiBaseUrl: string };
}

interface NliResultResponse {
  found: boolean;
  verdict?: "entailed" | "neutral" | "contradiction";
  score?: number;
  latencyMs?: number;
  isWarning?: boolean;
}

/**
 * P9: 轮询 GET /api-nli-result?turnId=<id> 拿 NLI async verdict
 * 3s 起始 + 2s × 5 间隔 (13s 总), 命中即停
 * @param baseUrl api base URL (跟 chat 用同一)
 * @param turnId chat response.nliTurnId
 * @returns NLI result or null (5 次后 fallback 不返)
 */
async function pollNliResult(baseUrl: string, turnId: string): Promise<NliResultResponse | null> {
  const url = `${baseUrl}/api-nli-result?turnId=${encodeURIComponent(turnId)}`;
  const token = getJwtToken();
  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 1 ? 3000 : 2000));
    try {
      // @ts-nocheck wx 全局类型 mock-first 缺失
      const res = await wx.cloud.callFunction({
        name: "api-router",
        data: { route: "/api-nli-result", method: "GET", query: { turnId } },
        header: { Authorization: `Bearer ${token}` },
      });
      const body = (res?.result ?? {}) as NliResultResponse;
      if (body.found) return body;
    } catch {
      // 轮询失败继续下一次
    }
  }
  return null;
}

Page({
  data: {
    messages: [] as MessageItem[],
    q: "",
    submitting: false,
    error: "",
    sessionId: "" as string, // 空 → 新 session；非空 → 复用
    sessionTitle: "" as string,
    /** M7-B: 选中的 sourceType；空数组 = 不过滤（默认全部） */
    selectedSourceTypes: [] as string[],
    /** M7-B: sourceType 候选（硬编码全集；未来可改成从 user source 动态拉） */
    availableSourceTypes: [
      { value: "webpage", label: "网页" },
      { value: "file", label: "文件" },
      { value: "pdf", label: "PDF" },
      { value: "xiaohongshu", label: "小红书" },
      { value: "wechat-mp", label: "公众号" },
    ],
    /** P9: NLI async polling 进行中 (spinner UI) */
    nliPending: false,
    /** P9: NLI 异步 verdict 警告 (轮询命中后显示) */
    showWarning: false,
    /** P9: NLI 警告文本 */
    warningText: "" as string,
  },

  onLoad(): void {
    // M6.1: 加载持久化的 session_id（关掉重开继续上一轮）
    const sid = loadCurrentSessionId();
    if (sid) {
      this.setData({ sessionId: sid });
    }
    // M6.3c: 首次昵称 modal（仅弹 1 次；跳过 / 填过都不再弹）
    if (!hasShownNicknameModal()) {
      void this.promptNickname();
    }
  },

  /**
   * M6.3c: 弹 modal 让 user 填 nickname。
   * - 跳过 / 确认都设 hasShown=true（避免反复弹）
   * - 填了非空 → 调 updateNickname PATCH /user/nickname
   * - PATCH 失败仅 showToast 提示，flag 仍置 true（M6.3c 不做 settings 页 retry）
   */
  // @ts-expect-error 微信 Page method 类型不强制匹配
  async promptNickname(this: WechatMiniprogram.Page.TrivialInstance): Promise<void> {
    // @ts-nocheck wx 全局类型 mock-first 缺失
    const res = await wx.showModal({
      title: "请输入昵称",
      editable: true,
      placeholderText: "1-20 字符（可跳过）",
      confirmText: "保存",
      cancelText: "跳过",
    });
    if (res.confirm && res.content?.trim()) {
      try {
        await updateNickname(res.content.trim());
        // @ts-nocheck wx 全局类型 mock-first 缺失
        wx.showToast({ title: "昵称已保存", icon: "success" });
      } catch {
        // @ts-nocheck wx 全局类型 mock-first 缺失
        wx.showToast({ title: "保存失败", icon: "none" });
      }
    }
    setShownNicknameModal();
  },

  onShow(): void {
    // history 页切换 session 后回 chat 页会触发 onShow → 用最新 sid
    const sid = loadCurrentSessionId();
    if (sid && sid !== this.data.sessionId) {
      // 切到不同 session → 清空 + 拉新历史
      this.setData({ sessionId: sid, messages: [] });
      void this.loadSessionMessages(sid);
    } else if (sid && this.data.messages.length === 0) {
      // CP-7-B round 9 bugfix：同 sid 但 messages 为空（冷启动 / 首次点击恰好命中持久化 sid）
      // 此时也需要拉历史，否则页面永远是空白
      void this.loadSessionMessages(sid);
    }
  },

  /** 拉 session 完整详情 → 转 MessageItem[] 含 segments（CP-7-B 真接 round 3） */
  async loadSessionMessages(sid: string): Promise<void> {
    try {
      const detail = await getSession(sid);
      const messages: MessageItem[] = detail.messages.map((m, i) => ({
        id: `${sid}-${i}-${m.role}`,
        role: m.role,
        text: m.content,
        cached: false,
        citations: [],
        // user msg segments 空；assistant msg 解析 [N] 富文本
        segments: m.role === "assistant" ? parseAnswerSegments(m.content) : [],
      }));
      this.setData({
        messages,
        sessionTitle: detail.title ?? "",
      });
    } catch (err) {
      // 拉失败仅 warn；不阻塞页面（user 可以继续问新问题，但旧消息看不到）
      // eslint-disable-next-line no-console
      console.warn("[unequal] loadSessionMessages failed:", err instanceof Error ? err.message : err);
    }
  },

  onUnload(): void {
    // 用户从 chat 页离开不清 session_id（让他能从 history 切回）
  },

  onQInput(e: WechatMiniprogram.Input): void {
    this.setData({ q: e.detail.value });
  },

  /** M7-B: chip toggle — 多选/取消 sourceType；空数组 = 不过滤 */
  onToggleSourceType(e: WechatMiniprogram.Tap): void {
    const value = e.currentTarget.dataset.value as string;
    const current = this.data.selectedSourceTypes;
    const next = current.indexOf(value) >= 0
      ? current.filter((v) => v !== value)
      : [...current, value];
    this.setData({ selectedSourceTypes: next });
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
      // CP-7-B bugfix：message-bubble 要求 segments 是 Segment[] 数组（user msg 无 [N] 解析需求，传空数组）
      segments: [],
    };
    this.setData({
      messages: [...this.data.messages, userMsg],
      q: "",
      submitting: true,
      error: "",
    });

    void this.callChat(q);
  },

  /** 调 /chat（多轮）；返回的 session_id 持久化 */
  async callChat(q: string): Promise<void> {
    const app = getApp<AppWithGlobals>();
    const baseUrl = app?.globalData?.apiBaseUrl ?? "http://localhost:8787";
    try {
      // M7-B: 透传 source 过滤；空数组 = 不过滤（caller 端不传字段）
      const selectedSourceTypes = this.data.selectedSourceTypes;
      const resp: ChatResponse = await chat(
        {
          q,
          ...(this.data.sessionId ? { session_id: this.data.sessionId } : {}),
          ...(selectedSourceTypes.length > 0 ? { source_types: selectedSourceTypes } : {}),
        },
        { baseUrl },
      );
      // 服务端返的 session_id 持久化（新建时才有意义）
      if (resp.session_id && resp.session_id !== this.data.sessionId) {
        saveCurrentSessionId(resp.session_id);
        this.setData({ sessionId: resp.session_id, sessionTitle: resp.session_title ?? "" });
      }
      const botMsg: MessageItem = {
        id: `${q}-${Date.now()}-a`,
        role: "assistant",
        text: resp.answer,
        cached: resp.cached,
        citations: resp.citations as unknown as AskResponse["citations"],
        segments: parseAnswerSegments(resp.answer),
      };
      this.setData({
        messages: [...this.data.messages, botMsg],
        submitting: false,
        nliPending: !!resp.nliTurnId,
      });
      // P9: NLI async polling 3-2-5 节奏 (3s 起始 + 2s × 5, 13s 总)
      if (resp.nliTurnId) {
        const nli = await pollNliResult(baseUrl, resp.nliTurnId);
        if (nli?.isWarning) {
          this.setData({
            showWarning: true,
            warningText: "该回答可能与文档不符，请参考引用核实",
            nliPending: false,
          });
        } else {
          this.setData({ nliPending: false });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "未知错误";
      this.setData({
        submitting: false,
        error: msg,
      });
    }
  },

  /** 长按消息 → 弹"新建会话"或"清空当前" */
  onTapNewSession(): void {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.showModal({
      title: "新建会话",
      content: "开始一个新的对话？当前会话会保留在历史里。",
      success: (res: { confirm: boolean }) => {
        if (res.confirm) {
          saveCurrentSessionId(null);
          this.setData({ sessionId: "", sessionTitle: "", messages: [] });
        }
      },
    });
  },

  // M7-D: 跳转到 settings 页（右上角 ⚙ 入口）
  onTapSettings(): void {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.navigateTo({ url: "/pages/settings/settings" });
  },

  onTapCitation(): void {
    // citation-card 自带 bindtap 触发 wx.navigateTo，无需在父页处理
  },
});
