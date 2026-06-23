/**
 * lib/nli/apply-warning.ts — verdict → finalAnswer (带 warning prefix 注入)
 *
 * 纯函数：输入 (cleaned, verdict) → finalAnswer。
 * spec §5.5 + §6 触发逻辑：
 *   - entailed → 返回原 cleaned（无 prefix）
 *   - neutral → 加 "⚠️ 以下回答部分参考资料未提及..."
 *   - contradiction → 加 "⚠️ 以下回答与参考资料存在冲突..."
 *   - cleaned 已有 "⚠️" → 去重不重复加
 *   - cleaned 空 → 返回空（不强行加 prefix）
 */

import type { NliVerdict } from "./types.js";

const NEUTRAL_PREFIX = "⚠️ 以下回答部分参考资料未提及，请谨慎参考：\n\n";
const CONTRADICTION_PREFIX = "⚠️ 以下回答与参考资料存在冲突，请谨慎参考：\n\n";
const MAX_PREFIX_LEN = 60;

export function applyWarning(cleaned: string, verdict: NliVerdict): string {
  if (verdict.verdict === "entailed") return cleaned;

  const prefix = verdict.verdict === "contradiction" ? CONTRADICTION_PREFIX : NEUTRAL_PREFIX;

  // prefix 长度保护
  if (prefix.length > MAX_PREFIX_LEN) {
    return cleaned;
  }

  // cleaned 空 → 返回空
  if (cleaned.length === 0) {
    return cleaned;
  }

  // 去重：cleaned 已有 "⚠️" 不重复加
  if (cleaned.trimStart().startsWith("⚠️")) {
    return cleaned;
  }

  return prefix + cleaned;
}
