// @ts-nocheck wx 全局类型 mock-first 缺失（miniprogram-api-typings 未安装，按 CP-1 决策容忍）
import { listSessions, renameSession, deleteSession } from "../../lib/api.js";
import { saveCurrentSessionId, loadCurrentSessionId } from "../../lib/chat-storage.js";
import type { ChatSessionRow } from "../../lib/types.js";

interface AppWithGlobals {
  globalData: { apiBaseUrl: string };
}

Page({
  data: {
    sessions: [] as ChatSessionRow[],
    loading: false,
    error: "",
  },

  onShow(): void {
    this.refresh();
  },

  /** 拉服务端 session 列表（spec §3.3 GET /sessions） */
  async refresh(): Promise<void> {
    const app = getApp<AppWithGlobals>();
    const baseUrl = app?.globalData?.apiBaseUrl ?? "http://localhost:8787";
    this.setData({ loading: true, error: "" });
    try {
      const res = await listSessions({ baseUrl });
      this.setData({ sessions: res.sessions, loading: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "加载失败";
      this.setData({ loading: false, error: msg });
    }
  },

  /** 点击 session → 切到 chat 页继续对话 */
  onTapSession(e: WechatMiniprogram.TouchEvent): void {
    // longpress 触发后 350ms 内 tap 也会触发；用 flag 抑制紧随其后的 tap
    // @ts-expect-error data 临时挂载
    if (this.data._suppressTap) return;
    const id = (e.currentTarget.dataset.id as string | undefined) ?? "";
    if (!id) return;
    saveCurrentSessionId(id);
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.switchTab({ url: "/pages/chat/chat" });
  },

  /** 长按 → 弹"重命名 / 删除"操作表 */
  onLongPressSession(e: WechatMiniprogram.TouchEvent): void {
    // 标记 1s 内 tap 跳过（longpress 后会跟一个 tap，需要抑制）
    this.setData({ _suppressTap: true });
    setTimeout(() => this.setData({ _suppressTap: false }), 1000);

    const id = (e.currentTarget.dataset.id as string | undefined) ?? "";
    const title = (e.currentTarget.dataset.title as string | undefined) ?? "";
    if (!id) return;
    const app = getApp<AppWithGlobals>();
    const baseUrl = app?.globalData?.apiBaseUrl ?? "http://localhost:8787";
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.showActionSheet({
      itemList: ["重命名", "删除"],
      success: async (res: { tapIndex: number }) => {
        if (res.tapIndex === 0) {
          this.promptRename(id, title, baseUrl);
        } else if (res.tapIndex === 1) {
          this.confirmDelete(id, baseUrl);
        }
      },
    });
  },

  promptRename(id: string, currentTitle: string, baseUrl: string): void {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.showModal({
      title: "重命名会话",
      content: "新标题（<= 100 字）",
      editable: true,
      placeholderText: currentTitle || "会话标题",
      success: async (modalRes: { confirm: boolean; content?: string }) => {
        if (!modalRes.confirm) return;
        const newTitle = (modalRes.content ?? "").trim();
        if (!newTitle) return;
        try {
          await renameSession(id, newTitle, { baseUrl });
          this.refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : "重命名失败";
          // @ts-expect-error wx 全局类型 mock-first 缺失
          wx.showToast({ title: msg, icon: "none" });
        }
      },
    });
  },

  confirmDelete(id: string, baseUrl: string): void {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.showModal({
      title: "删除会话",
      content: "确认删除此会话？服务端会软删（不再出现在列表），可在回收站恢复（M6.2 推出）。",
      success: async (modalRes: { confirm: boolean }) => {
        if (!modalRes.confirm) return;
        try {
          await deleteSession(id, { baseUrl });
          // 如果删的是当前正在用的 session → 清空
          if (loadCurrentSessionId() === id) {
            saveCurrentSessionId(null);
          }
          this.refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : "删除失败";
          // @ts-expect-error wx 全局类型 mock-first 缺失
          wx.showToast({ title: msg, icon: "none" });
        }
      },
    });
  },
});
