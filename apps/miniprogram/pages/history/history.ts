// @ts-nocheck wx 全局类型 mock-first 缺失（miniprogram-api-typings 未安装，按 CP-1 决策容忍）
import { listSessions, renameSession, deleteSession } from "../../lib/api.js";
import { saveCurrentSessionId, loadCurrentSessionId } from "../../lib/chat-storage.js";
import type { ChatSessionRow } from "../../lib/types.js";

interface AppWithGlobals {
  globalData: { apiBaseUrl: string };
}

/** CP-7-B round 4: epoch ms → 友好相对时间（今天/昨天/N天前/日期） */
function formatRelativeTime(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return "";
  const now = Date.now();
  const diffMs = now - ts;
  const min = 60 * 1000;
  const hr = 60 * min;
  const day = 24 * hr;

  if (diffMs < min) return "刚刚";
  if (diffMs < hr) return `${Math.floor(diffMs / min)} 分钟前`;
  if (diffMs < day) return `${Math.floor(diffMs / hr)} 小时前`;
  if (diffMs < 2 * day) return "昨天";
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)} 天前`;

  // 超过 7 天显示日期
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const date = String(d.getDate()).padStart(2, "0");
  if (d.getFullYear() === new Date().getFullYear()) {
    return `${month}/${date}`;
  }
  return `${d.getFullYear()}/${month}/${date}`;
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
      // CP-7-B round 4: 给每个 session 加 updatedAtText（格式化时间戳）
      const sessions = res.sessions.map((s) => ({
        ...s,
        updatedAtText: formatRelativeTime(s.updatedAt),
      }));
      this.setData({ sessions, loading: false });
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
