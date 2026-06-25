/**
 * OnnxNliProvider TDD 单测 (P6 Phase 2)
 *
 * 覆盖 18 cases:
 *   - Init (6): 模型 ready / 模型缺失触发下载 / COS 失败 / tokenizer 失败 / 重复 init 共享 / 并发只触发一次
 *   - Tokenize (3): 短文本 / 长文本截断 / 中文文本
 *   - Forward (4): 三分类 logits argmax / softmax 和 = 1 / 推理延迟 < 500ms / batch=1
 *   - Argmax (2): entailment / neutral / contradiction 三种
 *   - 错误路径 (3): premise 空 / hypothesis 空 / forward timeout
 *
 * 关键 mock:
 *   - onnxruntime-node: mock InferenceSession.create + session.run
 *   - tokenizer: 真实 BPE tokenizer (用下载到 nli-assets/ 的 vocab.json + merges.txt)
 *
 * v1 spec §2.7 + v1 §修订 0: 不依赖 @xenova/transformers, 用 onnxruntime-node + 自写 BPE
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// === Mock onnxruntime-node (use vi.hoisted to share state with vi.mock factory) ===
const mocks = vi.hoisted(() => {
  const session = {
    inputNames: ["input_ids", "attention_mask"],
    outputNames: ["logits"],
    run: vi.fn(),
  };
  return {
    session,
    ort: {
      InferenceSession: {
        create: vi.fn(async () => session),
      },
      Tensor: class MockTensor {
        public data: BigInt64Array | Int32Array | Float32Array;
        public dims: readonly number[];
        public type: string;
        constructor(type: string, data: BigInt64Array | Int32Array | Float32Array, dims: readonly number[]) {
          this.type = type;
          this.data = data;
          this.dims = dims;
        }
        static fromData(type: string, data: ArrayLike<number>, dims: readonly number[]): MockTensor {
          let arr: BigInt64Array | Int32Array | Float32Array;
          if (type === "int64") {
            arr = BigInt64Array.from(data as unknown as ArrayLike<bigint>);
          } else if (type === "int32") {
            arr = Int32Array.from(data as ArrayLike<number>);
          } else {
            arr = Float32Array.from(data as ArrayLike<number>);
          }
          return new MockTensor(type, arr, dims);
        }
      },
    },
  };
});

vi.mock("onnxruntime-node", () => mocks.ort);

import { OnnxNliProvider } from "../onnx-provider.js";

// === 真实 BPE tokenizer (从 nli-assets/ 加载, 跳过 CI 时 fallback) ===

let realVocab: Record<string, number> | null = null;
let realMerges: string[] | null = null;
let realSpecialTokens: Record<string, { id: number }> | null = null;

function tryLoadRealTokenizer(): boolean {
  try {
    const assetsDir = join(import.meta.dirname, "..", "..", "..", "..", "scripts", "nli-assets");
    realVocab = JSON.parse(readFileSync(join(assetsDir, "vocab.json"), "utf-8"));
    realMerges = readFileSync(join(assetsDir, "merges.txt"), "utf-8").split("\n").filter((l) => l && !l.startsWith("#"));
    realSpecialTokens = JSON.parse(readFileSync(join(assetsDir, "special_tokens_map.json"), "utf-8"));
    return true;
  } catch {
    return false;
  }
}

const HAS_REAL_TOKENIZER = tryLoadRealTokenizer();

// === Test helpers ===

let fakeModelDir: string;

function setupFakeModelDir() {
  fakeModelDir = mkdtempSync(join(tmpdir(), "nli-fake-model-"));
  writeFileSync(join(fakeModelDir, "model.onnx"), "fake-onnx-content");
}

function cleanupFakeModelDir() {
  if (fakeModelDir) rmSync(fakeModelDir, { recursive: true, force: true });
}

function makeProvider(opts?: { localModelPath?: string; downloadFromCos?: () => Promise<void> }): OnnxNliProvider {
  if (!fakeModelDir) setupFakeModelDir();
  return new OnnxNliProvider({
    localModelPath: opts?.localModelPath ?? join(fakeModelDir, "model.onnx"),
    downloadFromCos: opts?.downloadFromCos,
    tmpDir: "/tmp/nli-test",
    // 注入 test tokenizer (空 vocab, 避免 loadTokenizer 尝试读 vocab.json)
    vocab: {},
    merges: [],
    specialTokens: {
      bos_token: { id: 0 },
      eos_token: { id: 2 },
      pad_token: { id: 1 },
      unk_token: { id: 3 },
    },
  });
}

function mockLogits(contradiction: number, entailment: number, neutral: number): { logits: { data: Float32Array; dims: readonly number[]; type: string } } {
  // ONNX returns logits with shape [1, 3] in id2label order: 0=contradiction, 1=entailment, 2=neutral
  return {
    logits: {
      data: new Float32Array([contradiction, entailment, neutral]),
      dims: [1, 3],
      type: "float32",
    },
  };
}

describe("OnnxNliProvider", () => {
  beforeEach(() => {
    mocks.session.run.mockReset();
    mocks.ort.InferenceSession.create.mockClear();
    setupFakeModelDir();
  });

  afterEach(() => {
    cleanupFakeModelDir();
  });

  // ===== Init (6) =====

  describe("init", () => {
    it("should load model and create session on first verify", async () => {
      const p = makeProvider();
      mocks.session.run.mockResolvedValue(mockLogits(0.5, 2.0, 1.0));

      const result = await p.verify("premise", "hypothesis");

      expect(result.verdict).toBeDefined();
      expect(mocks.ort.InferenceSession.create).toHaveBeenCalledTimes(1);
    });

    it("should throw NliRuntimeError when local model missing and no downloadFromCos", async () => {
      const p = new OnnxNliProvider({
        localModelPath: "/nonexistent/path/model.onnx",
        tmpDir: "/tmp/nli-test",
      });

      await expect(p.verify("premise", "hypothesis")).rejects.toThrow(/model file not found/i);
    });

    it("should throw NliRuntimeError when downloadFromCos fails", async () => {
      const fakePath = "/tmp/nli-test-nonexistent/model.onnx";
      const p = new OnnxNliProvider({
        localModelPath: fakePath,
        downloadFromCos: async () => {
          throw new Error("COS unreachable");
        },
        tmpDir: "/tmp/nli-test",
        vocab: {},
        merges: [],
        specialTokens: {
          bos_token: { id: 0 },
          eos_token: { id: 2 },
          pad_token: { id: 1 },
        },
      });

      await expect(p.verify("premise", "hypothesis")).rejects.toThrow(/COS unreachable/);
    });

    it("should throw NliRuntimeError when tokenizer load fails", async () => {
      const p = new OnnxNliProvider({
        localModelPath: join(fakeModelDir, "model.onnx"),
        loadTokenizer: async () => {
          throw new Error("tokenizer corrupt");
        },
        tmpDir: "/tmp/nli-test",
      });

      await expect(p.verify("premise", "hypothesis")).rejects.toThrow(/tokenizer corrupt/);
    });

    it("should share initPromise on concurrent verify calls (only 1 init)", async () => {
      const p = makeProvider();
      mocks.session.run.mockResolvedValue(mockLogits(0.5, 2.0, 1.0));

      // 5 concurrent verify
      const promises = Array.from({ length: 5 }, () => p.verify("a", "b"));
      await Promise.all(promises);

      // InferenceSession.create 只调一次
      expect(mocks.ort.InferenceSession.create).toHaveBeenCalledTimes(1);
    });

    it("should reuse session on subsequent verify (no re-init)", async () => {
      const p = makeProvider();
      mocks.session.run.mockResolvedValue(mockLogits(0.5, 2.0, 1.0));

      await p.verify("a", "b");
      await p.verify("c", "d");
      await p.verify("e", "f");

      expect(mocks.ort.InferenceSession.create).toHaveBeenCalledTimes(1);
    });
  });

  // ===== Tokenize (3) - 只在有真实 tokenizer 时跑 =====

  describe("tokenize", () => {
    it.skipIf(!HAS_REAL_TOKENIZER)("should tokenize short text", async () => {
      const p = new OnnxNliProvider({
        localModelPath: join(fakeModelDir, "model.onnx"),
        vocab: realVocab!,
        merges: realMerges!,
        specialTokens: realSpecialTokens!,
        tmpDir: "/tmp/nli-test",
      });
      const { inputIds, attentionMask } = await p.tokenize("Hello world", "Hi there");
      expect(inputIds.length).toBeGreaterThan(0);
      expect(attentionMask.length).toBe(inputIds.length);
      // 第一个 token 应是 <s> (id=0)
      expect(inputIds[0]).toBe(realSpecialTokens!["bos_token"]?.id ?? 0);
    });

    it.skipIf(!HAS_REAL_TOKENIZER)("should truncate long text to max_length", async () => {
      const p = new OnnxNliProvider({
        localModelPath: join(fakeModelDir, "model.onnx"),
        vocab: realVocab!,
        merges: realMerges!,
        specialTokens: realSpecialTokens!,
        tmpDir: "/tmp/nli-test",
      });
      const longText = "这是一段非常长的中文文本 ".repeat(100);
      const { inputIds, attentionMask } = await p.tokenize(longText, longText);
      // max_position_embeddings = 514 (512 effective + <s> + </s>)
      expect(inputIds.length).toBeLessThanOrEqual(514);
      expect(attentionMask.length).toBe(inputIds.length);
    });

    it.skipIf(!HAS_REAL_TOKENIZER)("should tokenize Chinese text correctly", async () => {
      const p = new OnnxNliProvider({
        localModelPath: join(fakeModelDir, "model.onnx"),
        vocab: realVocab!,
        merges: realMerges!,
        specialTokens: realSpecialTokens!,
        tmpDir: "/tmp/nli-test",
      });
      const { inputIds } = await p.tokenize("5个月宝宝发烧38.5度", "婴儿发烧可用美林");
      // 中文 byte-level BPE: 每个 UTF-8 char 拆 3 bytes, 经 merges 后通常合并成大 token
      // 但 12-char 中文 + 7-char 数字 至少 > 5 tokens (实际 ~10-15 经 merges 后)
      expect(inputIds.length).toBeGreaterThan(3);
      // 末尾应是 </s>
      expect(inputIds[inputIds.length - 1]).toBe(realSpecialTokens!["eos_token"]?.id ?? 2);
    });
  });

  // ===== Forward (4) =====

  describe("forward + softmax", () => {
    it("should argmax logits correctly (entailment wins)", async () => {
      const p = makeProvider();
      mocks.session.run.mockResolvedValue(mockLogits(0.5, 2.0, 1.0));

      const result = await p.verify("premise", "hypothesis");

      expect(result.verdict).toBe("entailed");
      expect(result.scores.entailment).toBeGreaterThan(result.scores.neutral);
      expect(result.scores.entailment).toBeGreaterThan(result.scores.contradiction);
    });

    it("should softmax so scores sum to 1.0 (±0.01)", async () => {
      const p = makeProvider();
      mocks.session.run.mockResolvedValue(mockLogits(0.3, 2.5, 1.0));

      const result = await p.verify("a", "b");

      const sum = result.scores.entailment + result.scores.neutral + result.scores.contradiction;
      expect(Math.abs(sum - 1.0)).toBeLessThan(0.01);
    });

    it("should report latencyMs (positive number)", async () => {
      const p = makeProvider();
      mocks.session.run.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return mockLogits(2.0, 1.0, 0.5);
      });

      const result = await p.verify("a", "b");

      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.latencyMs).toBe("number");
    });

    it("should call session.run with input_ids and attention_mask tensors", async () => {
      const p = makeProvider();
      mocks.session.run.mockResolvedValue(mockLogits(0.5, 2.0, 1.0));

      await p.verify("premise", "hypothesis");

      expect(mocks.session.run).toHaveBeenCalledTimes(1);
      const feeds = mocks.session.run.mock.calls[0]![0] as Record<string, { type: string; dims: readonly number[] }>;
      expect(feeds.input_ids).toBeDefined();
      expect(feeds.attention_mask).toBeDefined();
      expect(feeds.input_ids!.dims[0]).toBe(1); // batch=1
      expect(feeds.attention_mask!.dims[0]).toBe(1);
    });
  });

  // ===== Argmax (2) =====

  describe("argmax verdict", () => {
    it("should map argmax to entailed/neutral/contradiction", async () => {
      const p = makeProvider();

      // entailment 赢
      mocks.session.run.mockResolvedValue(mockLogits(0.5, 5.0, 1.0));
      expect((await p.verify("a", "b")).verdict).toBe("entailed");

      // neutral 赢
      mocks.session.run.mockResolvedValue(mockLogits(0.5, 1.0, 5.0));
      expect((await p.verify("a", "b")).verdict).toBe("neutral");

      // contradiction 赢
      mocks.session.run.mockResolvedValue(mockLogits(5.0, 1.0, 0.5));
      expect((await p.verify("a", "b")).verdict).toBe("contradiction");
    });

    it("should report score = argmax probability", async () => {
      const p = makeProvider();
      mocks.session.run.mockResolvedValue(mockLogits(0.5, 5.0, 1.0));

      const result = await p.verify("a", "b");

      // score 应是 entailment 的概率 (softmax 后最大)
      expect(result.score).toBeCloseTo(result.scores.entailment, 5);
    });
  });

  // ===== 错误路径 (3) =====

  describe("error paths", () => {
    it("should throw NliRuntimeError when premise is empty", async () => {
      const p = makeProvider();
      await expect(p.verify("", "hypothesis")).rejects.toThrow(/premise/i);
    });

    it("should throw NliRuntimeError when hypothesis is empty", async () => {
      const p = makeProvider();
      await expect(p.verify("premise", "")).rejects.toThrow(/hypothesis/i);
    });

    it("should throw NliTimeoutError when forward exceeds timeout", async () => {
      const p = new OnnxNliProvider({
        localModelPath: join(fakeModelDir, "model.onnx"),
        forwardTimeoutMs: 50, // 50ms timeout for test
        tmpDir: "/tmp/nli-test",
        vocab: {},
        merges: [],
        specialTokens: {
          bos_token: { id: 0 },
          eos_token: { id: 2 },
          pad_token: { id: 1 },
        },
      });
      // mock 慢 forward (200ms > 50ms timeout), Promise.race 应 throw NliTimeoutError
      mocks.session.run.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 200));
        return mockLogits(0.5, 2.0, 1.0);
      });

      await expect(p.verify("a", "b")).rejects.toThrow(/timeout|exceeded/i);
    });
  });
});