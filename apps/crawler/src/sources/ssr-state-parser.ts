/**
 * SSR (Server-Side Rendering) 初始 state 解析 utility
 *
 * 用途：xhs.com、小红书等 SPA 站点在 SSR HTML 中嵌入 `window.__INITIAL_STATE__ = {...}`
 * 含完整笔记列表、用户信息。cheerio 抓不到 SPA 内容，但能拿到这段 JSON。
 *
 * xhs 实际行为：
 * - HTML 内 `<script>` 块含 `window.__INITIAL_STATE__ = {...};`
 * - JSON 含 `undefined` 字面量（不是有效 JSON，需替换为 null）
 * - JSON 后通常跟其他代码（`(function() {...})()`），需用括号配对截到顶层 `}` 结束
 *
 * 用法：
 *   const state = extractSsrState(html) as { profile?: { userInfo?: { nickname?: string } } };
 *   console.log(state.profile?.userInfo?.nickname);
 *
 * 设计：
 * - 单文件 utility，独立可测
 * - 抛 SsrParseError on 失败（不是返回 null，方便调用方决策）
 * - 不可信输入（HTML 是外部源）：JSON.parse 已天然限制，但解析后字段访问调用方责任
 */

/** ssr-state-parser 抛出的错误类型 */
export class SsrParseError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "SsrParseError";
  }
}

export interface ExtractSsrStateOptions {
  /** window 变量名（默认 "__INITIAL_STATE__"） */
  globalKey?: string;
}

/**
 * 从 HTML 提取 SSR initial state 并解析为 JSON 对象。
 *
 * 算法：
 * 1. 正则找 `window.<globalKey> = ` 起始位置
 * 2. 从 `{` 开始，用括号配对 + 字符串内豁免 找到匹配结尾 `}`
 * 3. 替换 `:undefined,` / `,undefined` → `:null` / `,null`（JSON 兼容）
 * 4. JSON.parse
 *
 * @throws SsrParseError 找不到 / 括号不匹配 / JSON.parse 失败
 */
export function extractSsrState(html: string, opts: ExtractSsrStateOptions = {}): unknown {
  const globalKey = opts.globalKey ?? "__INITIAL_STATE__";

  // 1. 找起始
  const startMarker = `window.${globalKey}`;
  const startIdx = html.indexOf(startMarker);
  if (startIdx < 0) {
    throw new SsrParseError(`extractSsrState: marker '${startMarker}' not found in html`);
  }

  // 找 `=` 后的第一个 `{`
  const eqIdx = html.indexOf("=", startIdx);
  if (eqIdx < 0) {
    throw new SsrParseError(`extractSsrState: no '=' after marker '${startMarker}'`);
  }
  const braceStart = html.indexOf("{", eqIdx);
  if (braceStart < 0) {
    throw new SsrParseError(`extractSsrState: no '{' after marker '${startMarker}'`);
  }

  // 2. 括号配对 + 字符串内豁免
  let depth = 0;
  let inStr = false;
  let esc = false;
  let endIdx = -1;
  for (let i = braceStart; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }

  if (endIdx < 0) {
    throw new SsrParseError(`extractSsrState: balanced end '}' not found (depth=${depth})`);
  }

  let raw = html.slice(braceStart, endIdx);

  // 3. 替换 undefined → null（JSON 兼容）
  raw = raw
    .replace(/:\s*undefined\b/g, ":null")
    .replace(/,\s*undefined\b/g, ",null")
    .replace(/\[\s*undefined\b/g, "[null");

  // 4. JSON.parse
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new SsrParseError(
      `extractSsrState: JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}

/**
 * 从已解析的 SSR state 提取 xhs 用户主页的笔记列表。
 *
 * xhs SSR 结构（实测）：
 * - top keys: ["global", "fakeModal", "noteData", "profile", ...]
 * - profile.userInfo: { nickname, fans, notesCount, redId, ... }
 * - profile.noteData: { "0": {id, title, user, likes, cover.url, ...}, "1": ..., "5": ... }
 *
 * @returns { userInfo, notes: [...] } 找不到返 null
 */
export interface XhsProfileNote {
  id: string;
  title: string;
  type: string;           // "video" | "normal" 等
  userNickname: string;
  likes: string;
  coverUrl: string | null;
  noteUrl: string;        // 派生的 explore URL
  publishedAt?: string | null;
}

export interface XhsProfileInfo {
  nickname: string | null;
  redId: string | null;
  fans: string | null;
  notesCount: number | null;
}

export interface XhsProfileData {
  userInfo: XhsProfileInfo;
  notes: XhsProfileNote[];
}

const XHS_NOTE_URL_BASE = "https://www.xiaohongshu.com/explore/";

export function extractXhsProfile(state: unknown): XhsProfileData | null {
  if (!state || typeof state !== "object") return null;
  const root = state as Record<string, unknown>;
  const profile = root.profile;
  if (!profile || typeof profile !== "object") return null;

  // userInfo
  const userInfoRaw = (profile as Record<string, unknown>).userInfo;
  const userInfo: XhsProfileInfo = {
    nickname: pickString(userInfoRaw, "nickname"),
    redId: pickString(userInfoRaw, "redId"),
    fans: pickString(userInfoRaw, "fans"),
    notesCount: pickNumber(userInfoRaw, "notesCount"),
  };

  // noteData: object map idx → note
  const noteDataRaw = (profile as Record<string, unknown>).noteData;
  const notes: XhsProfileNote[] = [];
  if (noteDataRaw && typeof noteDataRaw === "object") {
    for (const k of Object.keys(noteDataRaw as Record<string, unknown>)) {
      const n = (noteDataRaw as Record<string, unknown>)[k];
      if (!n || typeof n !== "object") continue;
      const noteObj = n as Record<string, unknown>;
      const userObj = (noteObj.user && typeof noteObj.user === "object"
        ? noteObj.user as Record<string, unknown>
        : null);
      const coverObj = (noteObj.cover && typeof noteObj.cover === "object"
        ? noteObj.cover as Record<string, unknown>
        : null);
      notes.push({
        id: pickString(noteObj, "id") ?? k,
        title: pickString(noteObj, "title") ?? "",
        type: pickString(noteObj, "type") ?? "normal",
        userNickname: pickString(userObj, "nickname") ?? userInfo.nickname ?? "",
        likes: pickString(noteObj, "likes") ?? "0",
        coverUrl: pickString(coverObj, "url"),
        noteUrl: XHS_NOTE_URL_BASE + (pickString(noteObj, "id") ?? k),
        publishedAt: pickString(noteObj, "time") ?? pickString(noteObj, "lastUpdateTime"),
      });
    }
    // 按 key 数字排序
    notes.sort((a, b) => {
      const ai = parseInt(a.id, 16) || 0;
      const bi = parseInt(b.id, 16) || 0;
      // 实际 key 是 "0", "1"... 用 hash 比较不可靠，fallback 字符串比较
      return a.noteUrl.localeCompare(b.noteUrl);
    });
  }

  return { userInfo, notes };
}

function pickString(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

function pickNumber(obj: unknown, key: string): number | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "number" ? v : null;
}