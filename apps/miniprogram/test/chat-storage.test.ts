/**
 * M6.3c chat-storage nickname modal helpers 测试。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  hasShownNicknameModal,
  setShownNicknameModal,
  __setNicknameModalStorageImpl,
} from "../lib/chat-storage.js";

describe("nickname modal storage helpers (M6.3c)", () => {
  beforeEach(() => {
    // 每个用例前重置 impl 到默认（用 vi.fn 让 spy 可验证）
  });

  it("hasShownNicknameModal 返 false 当 storage 无 'true'", () => {
    const getMock = vi.fn((_k: string) => "");
    const setMock = vi.fn();
    __setNicknameModalStorageImpl(getMock, setMock);
    expect(hasShownNicknameModal()).toBe(false);
    expect(getMock).toHaveBeenCalledWith("unequal:nickname_modal_shown_v1");
  });

  it("hasShownNicknameModal 返 true 当 storage = 'true'", () => {
    const getMock = vi.fn((_k: string) => "true");
    const setMock = vi.fn();
    __setNicknameModalStorageImpl(getMock, setMock);
    expect(hasShownNicknameModal()).toBe(true);
  });

  it("setShownNicknameModal 写 storage key = 'unequal:nickname_modal_shown_v1' + value 'true'", () => {
    const getMock = vi.fn((_k: string) => "");
    const setMock = vi.fn();
    __setNicknameModalStorageImpl(getMock, setMock);
    setShownNicknameModal();
    expect(setMock).toHaveBeenCalledWith("unequal:nickname_modal_shown_v1", "true");
  });
});
