/**
 * lib/nli/onnx-provider.ts — v1 P6 本地 ONNX NliProvider
 *
 * 用 onnxruntime-node + 自写 BPE tokenizer 跑 cross-encoder/nli-MiniLM2-L6-H768
 * 替代 P5 v1.3 HttpNliProvider (硅基流动 Qwen2.5-7B, 90% 15s timeout)。
 *
 * 关键设计:
 *   - 懒加载: 首次 verify() 才 init (singleton initPromise)
 *   - 自写 BPE tokenizer: 不用 @xenova/transformers (sharp 阻塞)
 *   - 错误降级: init 错 / forward 错 / timeout → NliRuntimeError / NliTimeoutError
 *   - 上层 get-provider 5min cache + 10-timeout 永久降级状态机兼容
 *
 * 模型: cross-encoder/nli-MiniLM2-L6-H768 (RoBERTaForSequenceClassification)
 * 输入: input_ids (int64, [1, seq_len]) + attention_mask (int64, [1, seq_len])
 * 输出: logits (float32, [1, 3])  // id2label: 0=contradiction, 1=entailment, 2=neutral
 *
 * v1 spec §2.3 + v1 §修订 0: 不用 @xenova/transformers, onnxruntime-node + 手写 BPE
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NliRuntimeError, NliTimeoutError } from "./errors.js";
import type { NliProvider, NliVerdict, NliVerdictLabel } from "./types.js";

// === onnxruntime-node: 顶层 ESM import (CloudBase Node 20 已验证 Linux x64 binary bundled) ===
import * as ort from "onnxruntime-node";

/** 推理超时 (ms) — default 5s, 与 P5 HttpNliProvider 一致 */
const DEFAULT_FORWARD_TIMEOUT_MS = 5000;

/** BPE 编码 max sequence length (RoBERTa max_position_embeddings=514, 实际 512 + <s> + </s>) */
const MAX_SEQUENCE_LENGTH = 512;

export interface OnnxNliProviderOptions {
  /** 本地模型绝对路径 (CloudBase 上: /tmp/nli-model.onnx) */
  localModelPath: string;
  /** COS 下载函数 (CloudBase cold start 阶段从 COS 拉模型, dev/CI 不传) */
  downloadFromCos?: () => Promise<void>;
  /** 临时目录 (默认 /tmp) */
  tmpDir?: string;
  /** 推理超时 (ms, default 5000) */
  forwardTimeoutMs?: number;
  /** 测试用: 注入预解析 vocab (跳过文件读取) */
  vocab?: Record<string, number>;
  /** 测试用: 注入预解析 BPE merges */
  merges?: string[];
  /** 测试用: 注入预解析 special tokens */
  specialTokens?: Record<string, { id: number }>;
  /** 测试用: 自定义 tokenizer loader (跳过文件读取) */
  loadTokenizer?: () => Promise<{ vocab: Record<string, number>; merges: string[]; specialTokens: Record<string, { id: number }> }>;
}

interface TokenizerState {
  vocab: Record<string, number>;
  /** id → token (反向 vocab, 推理输出 token id 时用, 暂未用) */
  idToToken: Map<number, string>;
  merges: string[];
  specialTokens: Record<string, { id: number }>;
  /** BPE cache: pre-tokenized word → token ids (提速) */
  bpeCache: Map<string, string[]>;
}

interface SessionState {
  session: ort.InferenceSession;
  tokenizer: TokenizerState;
  maxLength: number;
}

export class OnnxNliProvider implements NliProvider {
  readonly name = "onnx";

  private readonly localModelPath: string;
  private readonly downloadFromCos?: () => Promise<void>;
  private readonly tmpDir: string;
  private readonly forwardTimeoutMs: number;
  private readonly testVocab?: Record<string, number>;
  private readonly testMerges?: string[];
  private readonly testSpecialTokens?: Record<string, { id: number }>;
  private readonly testLoadTokenizer?: () => Promise<{ vocab: Record<string, number>; merges: string[]; specialTokens: Record<string, { id: number }> }>;

  private initPromise: Promise<SessionState> | null = null;

  constructor(opts: OnnxNliProviderOptions) {
    this.localModelPath = opts.localModelPath;
    this.downloadFromCos = opts.downloadFromCos;
    this.tmpDir = opts.tmpDir ?? "/tmp";
    this.forwardTimeoutMs = opts.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;
    this.testVocab = opts.vocab;
    this.testMerges = opts.merges;
    this.testSpecialTokens = opts.specialTokens;
    this.testLoadTokenizer = opts.loadTokenizer;
  }

  /**
   * 验证 hypothesis 是否被 premise 蕴含
   * @throws NliRuntimeError on init failure / invalid input / forward error
   * @throws NliTimeoutError on forward > forwardTimeoutMs
   */
  async verify(premise: string, hypothesis: string): Promise<NliVerdict> {
    if (!premise || premise.length === 0) {
      throw new NliRuntimeError("OnnxNliProvider: premise must be non-empty");
    }
    if (!hypothesis || hypothesis.length === 0) {
      throw new NliRuntimeError("OnnxNliProvider: hypothesis must be non-empty");
    }

    const start = Date.now();
    const { session, tokenizer, maxLength } = await this.ensureInitialized();

    // 1. tokenize
    const { inputIds, attentionMask } = await this.tokenize(premise, hypothesis, tokenizer, maxLength);

    // 2. forward (with timeout)
    const logits = await this.forwardWithTimeout(session, inputIds, attentionMask);

    // 3. softmax + argmax
    return this.toVerdict(logits, start);
  }

  /**
   * Public for test: 仅 tokenize, 不 forward
   * RoBERTa-style NSP: <s> P1 </s> P2 </s>
   */
  async tokenize(premise: string, hypothesis: string, injected?: TokenizerState, maxLengthInjected?: number): Promise<{
    inputIds: number[];
    attentionMask: number[];
  }> {
    let tokenizer: TokenizerState;
    let maxLength: number;
    if (injected) {
      tokenizer = injected;
      maxLength = maxLengthInjected ?? MAX_SEQUENCE_LENGTH;
    } else {
      const state = await this.ensureInitialized();
      tokenizer = state.tokenizer;
      maxLength = state.maxLength;
    }

    // RoBERTa 风格 sentence pair: <s> P1 </s></s> P2 </s> (实际 P1 </s> P2 </s>)
    const bosId = tokenizer.specialTokens["bos_token"]?.id ?? 0;
    const eosId = tokenizer.specialTokens["eos_token"]?.id ?? 2;
    const padId = tokenizer.specialTokens["pad_token"]?.id ?? 1;

    const premiseIds = this.bpeEncode(premise, tokenizer);
    const hypothesisIds = this.bpeEncode(hypothesis, tokenizer);

    // 拼接: [bos, ...P1, eos, ...P2, eos] → 截断到 maxLength
    const rawIds = [bosId, ...premiseIds, eosId, ...hypothesisIds, eosId];

    // 截断 (从尾部优先保留 P2, 因为 eos 必须在末尾)
    let inputIds: number[];
    if (rawIds.length > maxLength) {
      // 保留 [bos, ...P1, eos] (truncate P1) + P2 (truncate) + [eos]
      // 简化: 截断 hypothesis 保留 premise + bos/eos
      const overhead = 3; // bos + 2 eos
      const maxP1 = Math.floor((maxLength - overhead) / 2);
      const maxP2 = maxLength - overhead - maxP1;
      inputIds = [
        bosId,
        ...premiseIds.slice(0, maxP1),
        eosId,
        ...hypothesisIds.slice(0, maxP2),
        eosId,
      ];
    } else {
      inputIds = rawIds;
    }

    // padding (右侧, 实际 batch=1 不需要, 但 schema 兼容)
    const attentionMask = inputIds.map(() => 1);
    // 如果未来 batch > 1, 在这里 pad 到相同长度
    void padId; // reserved

    return { inputIds, attentionMask };
  }

  // ===== Private: init =====

  private async ensureInitialized(): Promise<SessionState> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async (): Promise<SessionState> => {
      // 1. 先检查 model 是否存在 (无 model 直接 throw, 不浪费 tokenizer 加载)
      if (!existsSync(this.localModelPath)) {
        if (!this.downloadFromCos) {
          throw new NliRuntimeError(
            `OnnxNliProvider: model file not found at ${this.localModelPath} and no downloadFromCos configured`,
          );
        }
        try {
          await this.downloadFromCos();
        } catch (err) {
          throw new NliRuntimeError(
            `OnnxNliProvider: failed to download model: ${err instanceof Error ? err.message : String(err)}`,
            err,
          );
        }
        if (!existsSync(this.localModelPath)) {
          throw new NliRuntimeError(
            `OnnxNliProvider: model file still not at ${this.localModelPath} after downloadFromCos`,
          );
        }
      }

      // 2. 加载 tokenizer
      const tokenizer = await this.loadTokenizer();
      const maxLength = MAX_SEQUENCE_LENGTH;

      // 3. 创建 ONNX inference session
      const session = await ort.InferenceSession.create(this.localModelPath, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      });

      return { session, tokenizer, maxLength };
    })().catch((err) => {
      // reset initPromise on failure 让下次重试
      this.initPromise = null;
      throw err;
    });

    return this.initPromise;
  }

  private async loadTokenizer(): Promise<TokenizerState> {
    if (this.testLoadTokenizer) {
      const result = await this.testLoadTokenizer();
      return this.buildTokenizerState(result.vocab, result.merges, result.specialTokens);
    }
    if (this.testVocab && this.testMerges && this.testSpecialTokens) {
      return this.buildTokenizerState(this.testVocab, this.testMerges, this.testSpecialTokens);
    }
    // CloudBase 真实路径: 从 bundle 目录读 vocab.json / merges.txt / special_tokens_map.json
    const assetsDir = dirname(this.localModelPath);
    const [vocabRaw, mergesRaw, specialTokensRaw] = await Promise.all([
      readFile(join(assetsDir, "vocab.json"), "utf-8"),
      readFile(join(assetsDir, "merges.txt"), "utf-8"),
      readFile(join(assetsDir, "special_tokens_map.json"), "utf-8"),
    ]);
    const vocab = JSON.parse(vocabRaw) as Record<string, number>;
    const merges = (mergesRaw as string)
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    const specialTokens = JSON.parse(specialTokensRaw) as Record<string, { id: number }>;
    return this.buildTokenizerState(vocab, merges, specialTokens);
  }

  private buildTokenizerState(
    vocab: Record<string, number>,
    merges: string[],
    specialTokens: Record<string, { id: number }>,
  ): TokenizerState {
    const idToToken = new Map<number, string>();
    for (const [token, id] of Object.entries(vocab)) {
      idToToken.set(id, token);
    }
    // BPE merges rank lookup
    const bpeRanks: Record<string, number> = {};
    for (let i = 0; i < merges.length; i++) {
      bpeRanks[merges[i]!] = i;
    }
    return {
      vocab,
      idToToken,
      merges,
      specialTokens,
      bpeCache: new Map(),
    };
  }

  // ===== Private: BPE tokenize (GPT-2 / RoBERTa-style byte-level BPE) =====

  /**
   * 简易 GPT-2 byte-level BPE encoder
   * 步骤:
   *   1. 文本 → bytes (UTF-8)
   *   2. bytes → unicode codepoints (byte → "Ġ" + chr 变体)
   *   3. pretokenize: 拆 word (按空白 + 标点)
   *   4. 每个 word → char list → BPE merges (贪心: 找 rank 最小 pair, merge, 循环)
   *   5. char list → token id (查 vocab)
   */
  private bpeEncode(text: string, tokenizer: TokenizerState): number[] {
    const ids: number[] = [];
    const pretokenized = this.pretokenize(text);
    for (const word of pretokenized) {
      const bpeTokens = this.bpe(word, tokenizer);
      for (const token of bpeTokens) {
        const id = tokenizer.vocab[token];
        if (id !== undefined) {
          ids.push(id);
        }
        // UNK 字符: 跳过 (与 transformers.js 默认行为一致, RoBERTa/MiniLM 不抛错)
      }
    }
    return ids;
  }

  /**
   * GPT-2 byte-level pretokenize
   * 简化: 拆 word (中英文混合) + 处理前导空格 (RoBERTa "Ġ" 标记)
   */
  private pretokenize(text: string): string[] {
    // 1. 转 byte-level unicode (GPT-2 style)
    // 空格 → "Ġ", 其他 ASCII 不变, 非 ASCII 拆 char
    const bytes: string[] = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === " ") {
        bytes.push("Ġ");
      } else if (this.isAsciiPrintable(ch)) {
        bytes.push(ch);
      } else {
        // 非 ASCII: UTF-8 byte 序列展开, 每个 byte 用 byteToUnicodeChar 映射
        const code = ch.codePointAt(0)!;
        if (code < 256) {
          bytes.push(this.byteToUnicodeChar(code));
        } else {
          // CJK 等: 拆 UTF-8 bytes
          const buf = Buffer.from(ch, "utf-8");
          for (const b of buf) {
            bytes.push(this.byteToUnicodeChar(b));
          }
        }
      }
    }

    // 2. 拆分 word (按 Ġ 边界 + 标点)
    const words: string[] = [];
    let current = "";
    for (const b of bytes) {
      if (b === "Ġ" && current.length > 0) {
        words.push(current);
        current = b;
      } else {
        current += b;
      }
    }
    if (current.length > 0) words.push(current);
    return words;
  }

  private isAsciiPrintable(ch: string): boolean {
    const code = ch.charCodeAt(0);
    return code >= 33 && code <= 126; // 排除 space (32) 和 control chars
  }

  /**
   * GPT-2 byte-level BPE 的 bytes_to_unicode 映射
   * 把 256 byte 映射到 256+ unicode codepoint, 让 vocab 都是 printable unicode
   * 完整实现: 参考 HuggingFace GPT-2 tokenizer.json 的 pretokenizer 配置
   */
  private static byteToUnicodeMap: Map<number, string> | null = null;

  private getByteToUnicodeMap(): Map<number, string> {
    if (OnnxNliProvider.byteToUnicodeMap) return OnnxNliProvider.byteToUnicodeMap;

    // 1. 初始 printable ranges
    const bs: number[] = [];
    // ! (33) - ~ (126)
    for (let i = 33; i <= 126; i++) bs.push(i);
    // ¡ (161) - ¬ (172)
    for (let i = 161; i <= 172; i++) bs.push(i);
    // ® (174) - ÿ (255)
    for (let i = 174; i <= 255; i++) bs.push(i);

    const cs: number[] = [...bs];
    let n = 0;
    for (let b = 0; b < 256; b++) {
      if (!bs.includes(b)) {
        bs.push(b);
        cs.push(256 + n);
        n++;
      }
    }

    const map = new Map<number, string>();
    for (let i = 0; i < bs.length; i++) {
      map.set(bs[i]!, String.fromCharCode(cs[i]!));
    }
    OnnxNliProvider.byteToUnicodeMap = map;
    return map;
  }

  /** Byte → GPT-2 unicode char (用 cached byteToUnicodeMap) */
  private byteToUnicodeChar(byte: number): string {
    const map = this.getByteToUnicodeMap();
    return map.get(byte) ?? String.fromCharCode(byte);
  }

  /**
   * BPE merge 算法: 反复合并 rank 最小的 pair, 直到无 pair 可合并
   * 简化实现: O(n²) 但对短文本 (< 50 char) 足够快
   */
  private bpe(word: string, tokenizer: TokenizerState): string[] {
    const cached = tokenizer.bpeCache.get(word);
    if (cached) return cached;

    // 1. 拆成 char list
    let symbols: string[] = word.split("");

    // 2. 反复合并
    while (symbols.length > 1) {
      // 找 rank 最小的相邻 pair
      let minRank = Infinity;
      let minIdx = -1;
      for (let i = 0; i < symbols.length - 1; i++) {
        const pair = symbols[i]! + " " + symbols[i + 1]!;
        const rank = this.getMergeRank(pair, tokenizer);
        if (rank !== null && rank < minRank) {
          minRank = rank;
          minIdx = i;
        }
      }
      if (minIdx === -1) break;
      symbols[minIdx] = symbols[minIdx]! + symbols[minIdx + 1]!;
      symbols.splice(minIdx + 1, 1);
    }

    tokenizer.bpeCache.set(word, symbols);
    return symbols;
  }

  private mergeRanksCache: Map<string, number> = new Map();

  private getMergeRank(pair: string, tokenizer: TokenizerState): number | null {
    if (this.mergeRanksCache.has(pair)) {
      return this.mergeRanksCache.get(pair)!;
    }
    // 从 merges 数组找
    for (let i = 0; i < tokenizer.merges.length; i++) {
      if (tokenizer.merges[i] === pair) {
        this.mergeRanksCache.set(pair, i);
        return i;
      }
    }
    this.mergeRanksCache.set(pair, -1);
    return null;
  }

  // ===== Private: forward + softmax =====

  private async forwardWithTimeout(
    session: ort.InferenceSession,
    inputIds: number[],
    attentionMask: number[],
  ): Promise<Float32Array> {
    const seqLen = inputIds.length;

    // 构造 int64 tensor (RoBERTa 期望 int64)
    const inputIdsBig = BigInt64Array.from(inputIds.map((n) => BigInt(n)));
    const attentionMaskBig = BigInt64Array.from(attentionMask.map((n) => BigInt(n)));

    const inputIdsTensor = new ort.Tensor("int64", inputIdsBig, [1, seqLen]);
    const attentionMaskTensor = new ort.Tensor("int64", attentionMaskBig, [1, seqLen]);

    const feeds: Record<string, ort.Tensor> = {
      input_ids: inputIdsTensor,
      attention_mask: attentionMaskTensor,
    };

    // timeout via Promise.race (onnx session.run 不接受 AbortSignal)
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new NliTimeoutError(`OnnxNliProvider: forward exceeded ${this.forwardTimeoutMs}ms`));
      }, this.forwardTimeoutMs);
    });

    try {
      const outputs = await Promise.race([session.run(feeds), timeoutPromise]);
      const logitsTensor = outputs.logits;
      // logits.data 是 Float32Array of shape [1, 3]
      return logitsTensor.data as Float32Array;
    } catch (err) {
      // 透传 NliTimeoutError
      if (err instanceof NliTimeoutError) throw err;
      throw new NliRuntimeError(
        `OnnxNliProvider: forward failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private toVerdict(logits: Float32Array, startTime: number): NliVerdict {
    if (logits.length !== 3) {
      throw new NliRuntimeError(
        `OnnxNliProvider: expected 3 logits (c,e,n), got ${logits.length}`,
      );
    }
    // ONNX logits 按 id2label 顺序: [contradiction=0, entailment=1, neutral=2]
    const c = logits[0]!;
    const e = logits[1]!;
    const n = logits[2]!;

    // softmax
    const maxLogit = Math.max(e, n, c);
    const expE = Math.exp(e - maxLogit);
    const expN = Math.exp(n - maxLogit);
    const expC = Math.exp(c - maxLogit);
    const sumExp = expE + expN + expC;
    const scores = {
      entailment: expE / sumExp,
      neutral: expN / sumExp,
      contradiction: expC / sumExp,
    };

    // argmax
    let verdict: NliVerdictLabel;
    let bestScore: number;
    if (scores.entailment >= scores.neutral && scores.entailment >= scores.contradiction) {
      verdict = "entailed";
      bestScore = scores.entailment;
    } else if (scores.neutral >= scores.contradiction) {
      verdict = "neutral";
      bestScore = scores.neutral;
    } else {
      verdict = "contradiction";
      bestScore = scores.contradiction;
    }

    return {
      verdict,
      score: bestScore,
      scores,
      latencyMs: Date.now() - startTime,
    };
  }
}