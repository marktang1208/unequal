/**
 * lib/nli/types.ts — NliProvider interface + NliVerdict 类型
 *
 * 抽象层：v1 用 TransformersNliProvider（local ONNX），v2 可换 HttpNliProvider（云端）。
 * 关键方法 verify(premise, hypothesis) → NliVerdict。
 *
 * premise = LLM cleaned answer（去掉 [N] 引用 marker）
 * hypothesis = retrieved chunks 拼接文本
 */

export type NliVerdictLabel = "entailed" | "neutral" | "contradiction";

export interface NliVerdict {
  /** argmax 后的最终标签 */
  verdict: NliVerdictLabel;
  /** 0-1，最大置信度（argmax 的那个）*/
  score: number;
  /** 完整三分类分数（softmax 输出）*/
  scores: {
    entailment: number;
    neutral: number;
    contradiction: number;
  };
  /** provider 内部耗时（ms），用于 audit / 监控 */
  latencyMs: number;
}

export interface NliProvider {
  /**
   * 验证 hypothesis 是否被 premise 蕴含
   * @param premise  主文本（被验证的"陈述"）
   * @param hypothesis  上下文（用以验证的"证据"）
   * @throws NliError on runtime failure / timeout
   */
  verify(premise: string, hypothesis: string): Promise<NliVerdict>;

  /** provider name（用于 audit / 调试）*/
  readonly name: string;
}
