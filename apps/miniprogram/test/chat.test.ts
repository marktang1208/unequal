/**
 * M6.3c chat 页 onLoad nickname modal 集成 smoke test。
 *
 * 范围：验证 chat 模块 import 无 type 错 + hasShownNicknameModal 行为。
 * Page lifecycle（onLoad 调 promptNickname）实际触发推 CP-5 微信开发者工具真机。
 */
import { describe, it, expect, vi } from "vitest";

// mock wx 全局（chat.ts module top-level 调 __setNicknameModalStorageImpl 时依赖 wx.getStorageSync）
// 简单内存 storage：set 后 get 可见
const storage: Record<string, string> = {};
const wxMock = {
  showModal: vi.fn(),
  showToast: vi.fn(),
  getStorageSync: vi.fn((k: string) => storage[k] ?? ""),
  setStorageSync: vi.fn((k: string, v: string) => {
    storage[k] = v;
  }),
  removeStorageSync: vi.fn((k: string) => {
    delete storage[k];
  }),
  request: vi.fn(),
  login: vi.fn(),
};
(globalThis as { wx?: unknown }).wx = wxMock;
// mock Page global（chat.ts module top-level 调 Page({...}) 注册页面）
(globalThis as { Page?: unknown }).Page = (config: unknown) => config;

describe("chat page nickname modal integration (M6.3c smoke)", () => {
  it("chat 模块 import 成功 + chat-storage helper 行为正确", async () => {
    // 动态 import 触发 module top-level __setNicknameModalStorageImpl 调用
    await import("../pages/chat/chat.js");
    const { hasShownNicknameModal, setShownNicknameModal } = await import(
      "../lib/chat-storage.js"
    );

    // 默认（storage 无 flag）→ false
    expect(hasShownNicknameModal()).toBe(false);

    // 设 flag → true
    setShownNicknameModal();
    // 验证 wx.setStorageSync 被调
    expect(wxMock.setStorageSync).toHaveBeenCalledWith(
      "unequal:nickname_modal_shown_v1",
      "true",
    );
    expect(hasShownNicknameModal()).toBe(true);

    // wx.showModal 在 setShown 之前未调（chat page onLoad 在 test 不会自动触发）
    expect(wxMock.showModal).not.toHaveBeenCalled();
  });
});
