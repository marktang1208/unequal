// @ts-nocheck wx 全局类型 mock-first 缺失（miniprogram-api-typings 未安装，按 CP-1 决策容忍）
// M7-D settings page — 显示当前用户信息 + 数据隔离 + 登出
import { me, type MeResponse } from "../../lib/api.js";
import { saveJwt } from "../../lib/chat-storage.js";
import { ApiError } from "../../lib/cloud-call.js";

/** epoch ms → 友好日期（YYYY-MM-DD） */
function formatDate(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const date = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}

Page({
  data: {
    loading: true,
    error: "",
    me: null as MeResponse | null,
    createdAtText: "",
    /** P11.2: 法律文档 URL (用于点击跳转) */
    legalUrls: {
      agreement: "https://marktang1208.github.io/unequal/",
      privacy: "https://marktang1208.github.io/unequal/privacy.html",
    },
  },

  onShow(): void {
    this.refresh();
  },

  /** 调 /api-auth-me 拉用户信息 */
  async refresh(): Promise<void> {
    this.setData({ loading: true, error: "" });
    try {
      const data = await me();
      this.setData({
        loading: false,
        me: data,
        createdAtText: formatDate(data.created_at),
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : "加载失败";
      // 401 不算"错误"，是未登录状态
      if (err instanceof ApiError && err.statusCode === 401) {
        this.setData({ loading: false, me: null });
        return;
      }
      this.setData({ loading: false, error: msg });
    }
  },

  /** 登出：清 jwt + 清当前 session_id（避免下次 chat 误用） */
  onTapLogout(): void {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.showModal({
      title: "退出登录",
      content: "退出后将清空本地登录态。再次打开小程序会重新走微信登录。",
      success: (res: { confirm: boolean }) => {
        if (!res.confirm) return;
        saveJwt(null);
        // @ts-expect-error wx 全局类型 mock-first 缺失
        wx.removeStorageSync?.("unequal:currentSessionId");
        // @ts-expect-error wx 全局类型 mock-first 缺失
        wx.showToast({ title: "已退出", icon: "success" });
        // 跳回问答页触发重新登录
        setTimeout(() => {
          // @ts-expect-error wx 全局类型 mock-first 缺失
          wx.switchTab({ url: "/pages/chat/chat" });
        }, 800);
      },
    });
  },

  /** P11.2: 跳用户协议 (在微信内置浏览器打开 GitHub Pages) */
  onTapAgreement(e: WechatMiniprogram.Tap): void {
    const url = e.currentTarget?.dataset?.url as string;
    if (!url) return;
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.navigateTo({
      url: `/pages/webview/webview?url=${encodeURIComponent(url)}&title=用户协议`,
    });
  },

  /** P11.2: 跳隐私政策 */
  onTapPrivacy(e: WechatMiniprogram.Tap): void {
    const url = e.currentTarget?.dataset?.url as string;
    if (!url) return;
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.navigateTo({
      url: `/pages/webview/webview?url=${encodeURIComponent(url)}&title=隐私政策`,
    });
  },
});
