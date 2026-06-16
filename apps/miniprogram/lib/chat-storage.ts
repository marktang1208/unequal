/**
 * M6.1 当前 session_id 持久化（spec §3.4 chat-storage）。
 *
 * 小程序关掉重开仍能继续上一轮对话。wx.setStorageSync / getStorageSync 同步 API。
 *
 * Mock-first：跟 storage.ts 一样用 __setStorageImpl 让测试桩替换 wx storage。
 * 单测里不依赖 wx 全局。
 */

const STORAGE_KEY = "unequal:currentSessionId";
const JWT_STORAGE_KEY = "unequal:jwt";

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

/* ---------- M6.2 jwt storage（M6.1 同样注入模式） ---------- */

let jwtGetImpl: (key: string) => string = (k) => {
  // @ts-expect-error wx 全局类型 mock-first 缺失
  const raw = wx.getStorageSync(k);
  return typeof raw === "string" ? raw : "";
};
let jwtSetImpl: (key: string, value: string) => void = (k, v) => {
  // @ts-expect-error wx 全局类型 mock-first 缺失
  wx.setStorageSync(k, v);
};

export function __setJwtStorageImpl(
  g: (key: string) => string,
  s: (key: string, value: string) => void,
): void {
  jwtGetImpl = g;
  jwtSetImpl = s;
}

/** 读当前 jwt 字符串。无 → 返 null */
export function loadJwt(): string | null {
  const v = jwtGetImpl(JWT_STORAGE_KEY).trim();
  return v ? v : null;
}

/** 存 jwt 字符串。null/空 → 清空 storage entry（与 saveCurrentSessionId 同样模式） */
export function saveJwt(token: string | null): void {
  if (!token) {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.removeStorageSync?.(JWT_STORAGE_KEY);
    return;
  }
  jwtSetImpl(JWT_STORAGE_KEY, token);
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

/* ---------- M6.3c 首次昵称 modal shown flag ---------- */

const NICKNAME_MODAL_SHOWN_KEY = "unequal:nickname_modal_shown_v1";

let nicknameModalGetImpl: (key: string) => string = (k) => {
  // @ts-expect-error wx 全局类型 mock-first 缺失
  const raw = wx.getStorageSync(k);
  return typeof raw === "string" ? raw : "";
};
let nicknameModalSetImpl: (key: string, value: string) => void = (k, v) => {
  // @ts-expect-error wx 全局类型 mock-first 缺失
  wx.setStorageSync(k, v);
};

/** 让测试桩替换 wx storage（同 __setSessionStorageImpl / __setJwtStorageImpl 模式） */
export function __setNicknameModalStorageImpl(
  g: (key: string) => string,
  s: (key: string, value: string) => void,
): void {
  nicknameModalGetImpl = g;
  nicknameModalSetImpl = s;
}

/** 首次昵称 modal 是否已弹过（不论填/跳过） */
export function hasShownNicknameModal(): boolean {
  return nicknameModalGetImpl(NICKNAME_MODAL_SHOWN_KEY) === "true";
}

/** 标记首次昵称 modal 已弹过 */
export function setShownNicknameModal(): void {
  nicknameModalSetImpl(NICKNAME_MODAL_SHOWN_KEY, "true");
}
