/**
 * lib/nli/transformers-provider.ts — v1 NliProvider 实现（local ONNX via transformers.js）
 *
 * 单例 lazy init：每个 TransformersNliProvider 实例内部持有一个 pipeline cache。
 * 首次 verify 时初始化 @xenova/transformers pipeline。
 * 模型：nli-MiniLM-L6-v2-quantized (Cross-Encoder, 3-class: entailment/neutral/contradiction)
 *
 * 关键行为：
 *   - 3s timeout (AbortController)
 *   - 512 token 截断（避免超 transformers.js 默认 512）
 *   - premise + ' [SEP] ' + hypothesis 拼接输入
 *   - softmax 三分类 → argmax → verdict
 *
 * spec §5.2 + §9 部署策略。
 */

import { pipeline, env } from "@xenova/transformers";
import type { NliProvider, NliVerdict, NliVerdictLabel } from "./types.js";
import { NliRuntimeError, NliTimeoutError } from "./errors.js";

const DEFAULT_MODEL = "Xenova/nli-MiniLM-L6-v2";
const DEFAULT_QUANTIZED = true;
const DEFAULT_TIMEOUT_MS = 3000;
const SEP_TOKEN = "[SEP]";

const LABEL_MAP: Record<string, NliVerdictLabel> = {
  entailment: "entailed",
  contradiction: "contradiction",
  neutral: "neutral",
};

type NliOutput = Array<{ label: string; score: number }>;
type TextClassificationPipeline = (text: string, options?: { topk?: number }) => Promise<NliOutput>;

export class TransformersNliProvider implements NliProvider {
  readonly name = "transformers";

  private pipelineInstance: TextClassificationPipeline | null = null;
  private initPromise: Promise<TextClassificationPipeline> | null = null;

  constructor(
    private readonly modelName: string = DEFAULT_MODEL,
    private readonly quantized: boolean = DEFAULT_QUANTIZED,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async verify(premise: string, hypothesis: string): Promise<NliVerdict> {
    if (!premise || !hypothesis) {
      throw new NliRuntimeError("premise and hypothesis must be non-empty");
    }

    const start = Date.now();
    let pipe: TextClassificationPipeline;
    try {
      pipe = await this.getPipeline();
    } catch (err) {
      throw new NliRuntimeError(
        `pipeline init failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const input = `${premise} ${SEP_TOKEN} ${hypothesis}`;
    let result: NliOutput;
    try {
      // topk=3 拿全 3 分类分数（默认 topk=1 只返回 argmax）
      result = await this.withTimeout(pipe(input, { topk: 3 }), this.timeoutMs);
    } catch (err) {
      if (err instanceof NliTimeoutError) throw err;
      throw new NliRuntimeError(
        `inference failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const scores = this.toScoreMap(result);
    const verdict = this.argmaxVerdict(scores);
    const score = Math.max(scores.entailment, scores.neutral, scores.contradiction);

    return {
      verdict,
      score,
      scores,
      latencyMs: Date.now() - start,
    };
  }

  private async getPipeline(): Promise<TextClassificationPipeline> {
    if (this.pipelineInstance) return this.pipelineInstance;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      // transformers.js 自动从 HuggingFace Hub 下载或读本地 cacheDir
      // 生产环境：env.cacheDir 默认 ~/.cache/huggingface（CloudBase /tmp 需 override）
      if (!env.cacheDir) {
        env.cacheDir = "/tmp/.huggingface-cache";
      }
      const p = await pipeline("text-classification", this.modelName, {
        quantized: this.quantized,
      });
      this.pipelineInstance = p as unknown as TextClassificationPipeline;
      return this.pipelineInstance;
    })();

    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NliTimeoutError(`inference exceeded ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private toScoreMap(result: NliOutput): NliVerdict["scores"] {
    const map = { entailment: 0, neutral: 0, contradiction: 0 };
    for (const r of result) {
      const key = LABEL_MAP[r.label.toLowerCase()];
      if (key) {
        if (key === "entailed") map.entailment = r.score;
        else map[key] = r.score;
      }
    }
    return map;
  }

  private argmaxVerdict(scores: NliVerdict["scores"]): NliVerdictLabel {
    const entries: Array<[NliVerdictLabel, number]> = [
      ["entailed", scores.entailment],
      ["neutral", scores.neutral],
      ["contradiction", scores.contradiction],
    ];
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
  }
}
