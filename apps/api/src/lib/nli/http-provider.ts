/**
 * lib/nli/http-provider.ts — v1.1 NliProvider 实现 (硅基流动 Qwen2.5-7B-Instruct)
 *
 * 通过 OpenAI 兼容 chat completions endpoint 调硅基流动 Qwen 模型做 NLI 验证。
 *
 * 关键行为：
 *   - Strict system prompt + JSON 解析（避免 LLM 输出自由文本）
 *   - 5s 超时（AbortController.timeout）
 *   - JSON 解析失败重试 1 次（不同 temperature 0.2）
 *   - 分数归一化（e + n + c = 1.0，允许 ±0.01 误差）
 *   - 单例 lazy init（首次 verify 时初始化，但实际是 lazy first HTTP call）
 *
 * spec §5.2 HttpNliProvider + §7 错误处理 + §8 环境变量。
 */

import type { NliProvider, NliVerdict, NliVerdictLabel } from "./types.js";
import { NliConfigError, NliRuntimeError, NliTimeoutError } from "./errors.js";

const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "Qwen/Qwen2.5-7B-Instruct";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_COUNT = 1;

const SYSTEM_PROMPT = `你是自然语言推理 (NLI) 专家。任务：判断 hypothesis 的事实内容是否被 premise 蕴含。

返回严格的 JSON object，不要任何其他文字：
{"label": "entailment" | "neutral" | "contradiction", "score": <0-1>}

判定规则：
- "entailment": premise 的所有事实细节都被 hypothesis 支持（score 越高越强）
- "neutral": premise 含 hypothesis 未提及的细节（可能是常识幻觉，score 表示 neutral 置信度）
- "contradiction": premise 与 hypothesis 冲突（score 越高越强）

示例 1：
premise: "发烧 38.5 吃 0.4ml/kg 美林"
hypothesis: "美林剂量标准 0.4ml/kg"
→ {"label": "entailment", "score": 0.95}

示例 2：
premise: "发烧 38.5 吃 0.4ml/kg 美林"
hypothesis: "美林剂量 1.0ml/kg 也安全"
→ {"label": "contradiction", "score": 0.85}

示例 3：
premise: "5个月宝宝发烧38.5要观察精神状态"
hypothesis: "5个月宝宝发烧38.5要观察精神状态。另外可以用温水擦拭物理降温。"
→ {"label": "neutral", "score": 0.70}`;

interface RawScore {
  entailment: number;
  neutral: number;
  contradiction: number;
}

export class HttpNliProvider implements NliProvider {
  readonly name = "http";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly model: string = DEFAULT_MODEL,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly retryCount: number = DEFAULT_RETRY_COUNT,
  ) {
    if (!apiKey || apiKey.trim().length === 0) {
      throw new NliConfigError("HttpNliProvider: apiKey is required");
    }
  }

  async verify(premise: string, hypothesis: string): Promise<NliVerdict> {
    if (!premise || premise.length === 0) {
      throw new NliRuntimeError("HttpNliProvider: premise must be non-empty");
    }
    if (!hypothesis || hypothesis.length === 0) {
      throw new NliRuntimeError("HttpNliProvider: hypothesis must be non-empty");
    }

    const start = Date.now();
    const messages = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      {
        role: "user" as const,
        content: `Premise（待验证陈述）:\n${premise}\n\nHypothesis（证据）:\n${hypothesis}`,
      },
    ];

    let lastError: Error | null = null;
    // 重试：第 1 次 temperature=0，第 2 次 temperature=0.2 增加随机性
    for (let attempt = 0; attempt <= this.retryCount; attempt++) {
      const temperature = attempt === 0 ? 0 : 0.2;
      try {
        const raw = await this.callApi(messages, temperature);
        const scores = this.parseAndNormalize(raw);
        const verdict = this.argmaxVerdict(scores);
        const score = Math.max(scores.entailment, scores.neutral, scores.contradiction);
        return {
          verdict,
          score,
          scores,
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // NliConfigError 不重试（配置问题）
        if (err instanceof NliConfigError) throw err;
        // NliTimeoutError 不重试（已经超时，再试还是超时）
        if (err instanceof NliTimeoutError) throw err;
        // RuntimeError 重试
        if (attempt < this.retryCount) continue;
        // 重试完了还失败
        throw err;
      }
    }

    throw new NliRuntimeError(
      `HttpNliProvider: all ${this.retryCount + 1} attempts failed: ${lastError?.message ?? "unknown"}`,
    );
  }

  private async callApi(
    messages: Array<{ role: "system" | "user"; content: string }>,
    temperature: number,
  ): Promise<RawScore> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new NliTimeoutError(`HttpNliProvider: request exceeded ${this.timeoutMs}ms`);
      }
      throw new NliRuntimeError(
        `HttpNliProvider: fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "unknown");
      throw new NliRuntimeError(
        `HttpNliProvider: API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
      );
    }

    let json: { choices?: Array<{ message?: { content?: string } }> };
    try {
      json = (await res.json()) as typeof json;
    } catch (err) {
      throw new NliRuntimeError(
        `HttpNliProvider: invalid JSON response: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new NliRuntimeError("HttpNliProvider: empty content in API response");
    }

    return this.parseContent(content);
  }

  private parseContent(content: string): RawScore {
    // 尝试提取 JSON（防止 LLM 包 ```json ... ``` 围栏）
    let jsonStr = content.trim();
    const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced && fenced[1]) jsonStr = fenced[1];

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (err) {
      throw new NliRuntimeError(
        `HttpNliProvider: failed to parse JSON: ${jsonStr.slice(0, 100)}`,
        err,
      );
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new NliRuntimeError("HttpNliProvider: response is not an object");
    }

    const obj = parsed as Record<string, unknown>;

    // 模式 1：{label, score} 格式（Qwen2.5-7B-Instruct 真接表现最稳定）
    if (typeof obj.label === "string" && typeof obj.score === "number") {
      return this.labelToScores(obj.label, obj.score);
    }

    // 模式 2：{entailment, neutral, contradiction} 三 score 格式（spec 设计目标，向后兼容）
    const e = Number(obj.entailment);
    const n = Number(obj.neutral);
    const c = Number(obj.contradiction);
    if (Number.isFinite(e) || Number.isFinite(n) || Number.isFinite(c)) {
      if (!Number.isFinite(e) || !Number.isFinite(n) || !Number.isFinite(c)) {
        throw new NliRuntimeError(
          `HttpNliProvider: invalid three-score (e=${e}, n=${n}, c=${c})`,
        );
      }
      return { entailment: e, neutral: n, contradiction: c };
    }

    // 模式 3：label 字符串但 score 缺失（Qwen 偶发格式 bug，如 `{"label":"contradiction","," ,"score":...}`）
    //          尝试用 label 字符串做 unit-score 归一化
    if (typeof obj.label === "string") {
      return this.labelToScores(obj.label, 0.8);
    }

    throw new NliRuntimeError(
      `HttpNliProvider: unrecognized schema (keys=${Object.keys(obj).join(",")})`,
    );
  }

  /**
   * 把 {label, score} 单值映射到三 score 形式。
   * - label = entailment → e=score, n=(1-score)*0.5, c=(1-score)*0.5
   * - label = neutral    → n=score, e=(1-score)*0.5, c=(1-score)*0.5
   * - label = contradiction → c=score, e=(1-score)*0.5, n=(1-score)*0.5
   * 剩余的两个 label 各分 (1-score)/2，避免 strict sum=1.0 检查失败。
   */
  private labelToScores(
    label: string,
    score: number,
  ): { entailment: number; neutral: number; contradiction: number } {
    const s = Math.max(0, Math.min(1, score));
    const rest = (1 - s) / 2;
    const norm = (s: string) => s.toLowerCase().trim();
    // P5 v1.1 真接发现：Qwen 有时会返缩写 ("ent" / "neu" / "con")，
    // 以及拼写变体 ("entailments" 等)。最宽容地映射。
    const l = norm(label);
    if (
      l === "entailment" ||
      l === "entail" ||
      l === "ent" ||
      l.startsWith("entail")
    ) {
      return { entailment: s, neutral: rest, contradiction: rest };
    }
    if (l === "neutral" || l === "neu" || l.startsWith("neutr")) {
      return { entailment: rest, neutral: s, contradiction: rest };
    }
    if (
      l === "contradiction" ||
      l === "contra" ||
      l === "con" ||
      l === "contradict" ||
      l.startsWith("contrad")
    ) {
      return { entailment: rest, neutral: rest, contradiction: s };
    }
    throw new NliRuntimeError(
      `HttpNliProvider: unknown label "${label}" (expected entailment/neutral/contradiction or short forms ent/neu/con)`,
    );
  }

  private parseAndNormalize(raw: RawScore): NliVerdict["scores"] {
    const sum = raw.entailment + raw.neutral + raw.contradiction;
    if (sum <= 0) {
      throw new NliRuntimeError(
        `HttpNliProvider: scores sum is zero or negative (sum=${sum})`,
      );
    }
    // 归一化（容许 ±1% 误差）
    const normalized = {
      entailment: raw.entailment / sum,
      neutral: raw.neutral / sum,
      contradiction: raw.contradiction / sum,
    };
    return normalized;
  }

  private argmaxVerdict(scores: NliVerdict["scores"]): NliVerdictLabel {
    let best: NliVerdictLabel = "entailed";
    let bestScore = scores.entailment;
    if (scores.neutral > bestScore) {
      best = "neutral";
      bestScore = scores.neutral;
    }
    if (scores.contradiction > bestScore) {
      best = "contradiction";
    }
    return best;
  }
}