/**
 * M6.1 当前 session_id 持久化（spec §3.4 chat-storage）。
 *
 * 小程序关掉重开仍能继续上一轮对话。wx.setStorageSync / getStorageSync 同步 API。
 *
 * Mock-first：跟 storage.ts 一样用 __setStorageImpl 让测试桩替换 wx storage。
 * 单测里不依赖 wx 全局。
 */

const STORAGE_KEY = "unequal:currentSessionId";

let getImpl: (key: string) => string = (k) => {
  // @ts-expect-error wx 全局类型 mock-first 缺失
  const raw = wx.getStorageSync(k);
  return typeof raw === "string" ? raw : "";
};
let setImpl: (key: string, value: string) => void = (k, v) => {
  // @ts-expect-error wx 全局类型 mock-first 缺失
  wx.setStorageSync(k, v);
};

export function __setSessionStorageImpl(
  g: (key: string) => string,
  s: (key: string, value: string) => void,
): void {
  getImpl = g;
  setImpl = s;
}

/** 读当前 session_id。无 → 返 null（caller 决定新建 / 不传 session_id） */
export function loadCurrentSessionId(): string | null {
  const v = getImpl(STORAGE_KEY).trim();
  return v ? v : null;
}

/** 存当前 session_id。空串 → 视作清空（删 storage entry） */
export function saveCurrentSessionId(id: string | null): void {
  if (!id) {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.removeStorageSync?.(STORAGE_KEY);
    return;
  }
  setImpl(STORAGE_KEY, id);
}
