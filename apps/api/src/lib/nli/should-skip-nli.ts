/**
 * should-skip-nli.ts — P5 v1.2: NLI 降级触发条件(短答案跳过)
 *
 * 短答案 NLI 验证价值低(没空间塞幻觉),跳过调用节省延迟。
 *
 * 阈值:`cleaned.length < minLen` 时跳过 NLI,阈值 env 可配,默认 100 字符。
 *
 * 纯函数,无副作用,易单元测试。
 */

/** 默认阈值:100 字符(实测家长场景答案均值) */
export const DEFAULT_NLI_MIN_ANSWER_LEN = 100;

/**
 * 判断给定 cleaned LLM 答案是否应该跳过 NLI 后置验证。
 *
 * @param cleaned LLM 答案去除 [N] 引用后的纯文本
 * @param minLen 阈值(已 parseInt 过的数字)
 * @returns true = 跳过 NLI, false = 调 NLI
 *
 * 边界:`< minLen` 跳过,`>= minLen` 调(包含等号)
 */
export function shouldSkipNli(cleaned: string, minLen: number): boolean {
  return cleaned.length < minLen;
}

/**
 * 从 process.env 读 NLI_MIN_ANSWER_LEN,parseInt,无效时回退默认 100。
 *
 * 复用 get-provider.ts 的 env 读取套路:opts 优先,env 次之,默认兜底。
 */
export function getNliMinAnswerLen(envOverride?: number): number {
  if (envOverride !== undefined && Number.isFinite(envOverride) && envOverride >= 0) {
    return envOverride;
  }
  const raw = process.env.NLI_MIN_ANSWER_LEN;
  if (raw === undefined || raw === "") return DEFAULT_NLI_MIN_ANSWER_LEN;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_NLI_MIN_ANSWER_LEN;
  return parsed;
}