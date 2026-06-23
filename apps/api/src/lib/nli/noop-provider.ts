/**
 * lib/nli/noop-provider.ts — 兜底 NliProvider
 *
 * 永远返回 entailed，name="noop"。用于：
 *   1. NLI_ENABLED=false（admin 显式禁用）
 *   2. TransformersNliProvider 失败时降级
 *   3. 模型文件缺失（启动期 fail fast，但运行时 fallback 安全）
 *
 * spec §5.3 + §7 类别 A/B 降级路径。
 */

import type { NliProvider, NliVerdict } from "./types.js";

export class NoopNliProvider implements NliProvider {
  readonly name = "noop";

  async verify(_premise: string, _hypothesis: string): Promise<NliVerdict> {
    return {
      verdict: "entailed",
      score: 1,
      scores: { entailment: 1, neutral: 0, contradiction: 0 },
      latencyMs: 0,
    };
  }
}
