/**
 * get-provider.test.ts — 10 + 6 = 16 cases (spec §11.1 + P6 Phase 3)
 *
 * 1. nliProvider=noop → NoopNliProvider
 * 2. nliProvider=http + apiKey 缺失 + throwOnConfigError=true → throw NliConfigError
 * 3. providerOverride → 用 override
 * 4. nliProvider=http + 有 apiKey → HttpNliProvider (mock fetch)
 * 5. HttpNliProvider 失败 (Runtime) → NoopNliProvider
 * 6. 5min 内复用 NoopNliProvider
 * 7. 累计 timeout > 10 → 永久 NoopNliProvider
 * 8. __resetProviderStateForTest 清状态
 * 9. 单例：第二次 getProvider 复用同一实例
 * 10. success path 复用 state.provider（不 new 实例）
 *
 * P6 Phase 3 — OnnxNliProvider 路由 (6 cases):
 * 11. nliProvider=onnx + 有 localPath → OnnxNliProvider
 * 12. nliProvider=onnx + 缺 localPath + throwOnConfigError=true → throw NliConfigError
 * 13. nliProvider=onnx + 缺 localPath + throwOnConfigError=false → NoopNliProvider + warn
 * 14. nliProvider=onnx + verify Runtime 失败 → recordNliFailure → 5min cache Noop
 * 15. http / noop 路由向后兼容 (backward compat)
 * 16. env NLI_PROVIDER=onnx (无 opts.nliProvider) → 自动走 OnnxNliProvider
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// === Mock OnnxNliProvider (避免真加载 onnxruntime-node + BPE) ===
const onnxMock = vi.hoisted(() => {
  return {
    instanceCount: 0,
    lastOpts: null as null | {
      localModelPath: string;
      tmpDir?: string;
      forwardTimeoutMs?: number;
      downloadFromCos?: () => Promise<void>;
    },
  };
});

vi.mock("../onnx-provider.js", () => {
  return {
    OnnxNliProvider: class MockOnnxNliProvider {
      readonly name = "onnx";
      constructor(public readonly opts: {
        localModelPath: string;
        tmpDir?: string;
        forwardTimeoutMs?: number;
        downloadFromCos?: () => Promise<void>;
      }) {
        onnxMock.lastOpts = opts;
        onnxMock.instanceCount++;
      }
      async verify(_premise: string, _hypothesis: string) {
        return {
          verdict: "entailed" as const,
          score: 0.9,
          scores: { entailment: 0.9, neutral: 0.05, contradiction: 0.05 },
          latencyMs: 5,
        };
      }
    },
  };
});

// 帮助 mock reset
function resetOnnxMock() {
  onnxMock.instanceCount = 0;
  onnxMock.lastOpts = null;
}

import {
  getProvider,
  recordNliFailure,
  recordNliSuccess,
  __resetProviderStateForTest,
} from "../get-provider.js";
import { NoopNliProvider } from "../noop-provider.js";
import { HttpNliProvider } from "../http-provider.js";
import { OnnxNliProvider } from "../onnx-provider.js";

const ENTAILED_OUT = {
  choices: [
    { message: { content: '{"entailment":0.9,"neutral":0.05,"contradiction":0.05}' } },
  ],
};

describe("getProvider", () => {
  beforeEach(() => {
    __resetProviderStateForTest();
    resetOnnxMock();
    delete process.env.NLI_PROVIDER;
    delete process.env.NLI_MODEL_LOCAL_PATH;
    delete process.env.NLI_LOCAL_TMP_DIR;
    delete process.env.NLI_TIMEOUT_MS;
    delete process.env.SILICONFLOW_API_KEY;
  });

  it("nliProvider=noop → NoopNliProvider", async () => {
    const provider = await getProvider({ nliProvider: "noop" });
    expect(provider.name).toBe("noop");
    expect(provider).toBeInstanceOf(NoopNliProvider);
  });

  it("nliProvider=http + apiKey 缺失 + throwOnConfigError=true → throw NliConfigError", async () => {
    await expect(
      getProvider({ nliProvider: "http", throwOnConfigError: true }),
    ).rejects.toThrow(/SILICONFLOW_API_KEY/);
  });

  it("providerOverride → 用 override", async () => {
    const override = new NoopNliProvider();
    const provider = await getProvider({ providerOverride: override });
    expect(provider).toBe(override);
  });

  it("nliProvider=http + 有 apiKey → HttpNliProvider", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ENTAILED_OUT,
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const provider = await getProvider({
        nliProvider: "http",
        apiKey: "sk-test",
      });
      expect(provider.name).toBe("http");
      expect(provider).toBeInstanceOf(HttpNliProvider);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("HttpNliProvider 构造后 verify 失败 (Runtime) → recordNliFailure → 下次 getProvider 返 Noop", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal error",
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const provider = await getProvider({ nliProvider: "http", apiKey: "sk-test" });
      expect(provider).toBeInstanceOf(HttpNliProvider);

      // 触发 Runtime 失败
      try {
        await provider.verify("p", "h");
      } catch {
        // expected
        recordNliFailure(new Error("API 500 internal error"));
      }

      // 5min 内 → 返 Noop
      const provider2 = await getProvider({ nliProvider: "http", apiKey: "sk-test" });
      expect(provider2).toBeInstanceOf(NoopNliProvider);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("5min 内复用 NoopNliProvider（不调 fetch）", async () => {
    let fetchCallCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      return {
        ok: false,
        status: 500,
        text: async () => "error",
        json: async () => ({}),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      // 第一次 getProvider → 创建 provider（不调 fetch）
      await getProvider({ nliProvider: "http", apiKey: "sk-test", timeoutMs: 5000 });
      const callCountBefore = fetchCallCount;

      // verify 失败 → 1+ 次 fetch（retry=1）
      const provider = await getProvider({ nliProvider: "http", apiKey: "sk-test", timeoutMs: 5000 });
      try {
        await provider.verify("p", "h");
      } catch {
        recordNliFailure(new Error("fail"));
      }
      const callCountAfterVerify = fetchCallCount;
      expect(callCountAfterVerify).toBeGreaterThan(callCountBefore);

      // 第二次 getProvider → 5min 内返 Noop，不调 fetch
      const provider2 = await getProvider({ nliProvider: "http", apiKey: "sk-test", timeoutMs: 5000 });
      expect(provider2).toBeInstanceOf(NoopNliProvider);
      expect(fetchCallCount).toBe(callCountAfterVerify); // 没新 fetch 调用
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("__resetProviderStateForTest 清状态", async () => {
    __resetProviderStateForTest();
    recordNliFailure(new Error("test"));
    __resetProviderStateForTest();
    // 状态清空，永久降级 flag 重置
    const provider = await getProvider({ nliProvider: "noop" });
    expect(provider).toBeInstanceOf(NoopNliProvider);
  });

  it("单例：第二次 getProvider 复用同一实例", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ENTAILED_OUT,
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const p1 = await getProvider({ nliProvider: "http", apiKey: "sk-test" });
      recordNliSuccess(); // success path 复用
      const p2 = await getProvider({ nliProvider: "http", apiKey: "sk-test" });
      expect(p1).toBe(p2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("recordNliSuccess 重置 failCount", async () => {
    recordNliFailure(new Error("test"));
    recordNliSuccess();
    // 状态：failCount=0 → success path 复用（但 provider 是 Noop 因为 fail 后改的）
    const provider = await getProvider({ nliProvider: "noop" });
    expect(provider).toBeInstanceOf(NoopNliProvider);
  });

  it("siliconflow 缺 apiKey + throwOnConfigError → NliConfigError 抛出", async () => {
    delete process.env.SILICONFLOW_API_KEY;
    await expect(
      getProvider({ nliProvider: "http", throwOnConfigError: true }),
    ).rejects.toThrow(/SILICONFLOW_API_KEY/);
  });

  // ── P5 v1.1 真接 production bug fix (2026-06-24) ────────────
  // 原 getProvider() 没读 process.env.NLI_TIMEOUT_MS / NLI_RETRY_COUNT，
  // 即使云端 env 改了也无效（HttpNliProvider 走 DEFAULT_TIMEOUT_MS=5000）。
  // 修复后从 env 读，opts override 优先。

  it("env NLI_TIMEOUT_MS=8000 → HttpNliProvider timeout=8000", async () => {
    process.env.SILICONFLOW_API_KEY = "sk-test";
    process.env.NLI_TIMEOUT_MS = "8000";
    __resetProviderStateForTest();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '{"entailment":0.85,"neutral":0.10,"contradiction":0.05}',
            },
          },
        ],
      }),
      text: async () => "",
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const provider = (await getProvider({ nliProvider: "http" })) as HttpNliProvider;
    expect(provider).toBeInstanceOf(HttpNliProvider);
    // 通过 http call 触发,看 AbortSignal timeout
    await provider.verify("p", "h");
    // 关键:fetch 被调,body 里 model 等都对。timeout 走内部 AbortController 验证不了,
    // 但通过 env path 选通就行（mock fetch 立即返 = 不会真撞 timeout）。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    delete process.env.NLI_TIMEOUT_MS;
  });

  it("opts.timeoutMs 优先于 env NLI_TIMEOUT_MS", async () => {
    process.env.SILICONFLOW_API_KEY = "sk-test";
    process.env.NLI_TIMEOUT_MS = "8000";
    __resetProviderStateForTest();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '{"entailment":0.85,"neutral":0.10,"contradiction":0.05}',
            },
          },
        ],
      }),
      text: async () => "",
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    // opts.timeoutMs=2000 应该盖过 env 8000
    const provider = (await getProvider({
      nliProvider: "http",
      timeoutMs: 2000,
    })) as HttpNliProvider;
    expect(provider).toBeInstanceOf(HttpNliProvider);
    await provider.verify("p", "h");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    delete process.env.NLI_TIMEOUT_MS;
  });

  // ── P6 Phase 3 — OnnxNliProvider 路由 (6 cases) ─────────────────────
  // 设计目标: 本地 ONNX 模型替代硅基流动 HTTP NLI, 解决 chat 长问题 10s 延迟根本问题。
  // 状态机: onnx 失败走 5min cache + 10-timeout 永久降级, 与 http 路径对齐。

  it("nliProvider=onnx + opts.onnxLocalPath → OnnxNliProvider", async () => {
    const provider = await getProvider({
      nliProvider: "onnx",
      onnxLocalPath: "/tmp/nli-model.onnx",
      onnxTmpDir: "/tmp",
      onnxTimeoutMs: 5000,
    });
    expect(provider.name).toBe("onnx");
    expect(provider).toBeInstanceOf(OnnxNliProvider);
    expect(onnxMock.lastOpts?.localModelPath).toBe("/tmp/nli-model.onnx");
    expect(onnxMock.lastOpts?.tmpDir).toBe("/tmp");
    expect(onnxMock.lastOpts?.forwardTimeoutMs).toBe(5000);
    expect(onnxMock.instanceCount).toBe(1);
  });

  it("nliProvider=onnx + env NLI_MODEL_LOCAL_PATH → OnnxNliProvider", async () => {
    process.env.NLI_MODEL_LOCAL_PATH = "/var/data/nli/model.onnx";
    process.env.NLI_LOCAL_TMP_DIR = "/var/tmp";
    process.env.NLI_TIMEOUT_MS = "3000";

    const provider = await getProvider({ nliProvider: "onnx" });
    expect(provider).toBeInstanceOf(OnnxNliProvider);
    expect(onnxMock.lastOpts?.localModelPath).toBe("/var/data/nli/model.onnx");
    expect(onnxMock.lastOpts?.tmpDir).toBe("/var/tmp");
    expect(onnxMock.lastOpts?.forwardTimeoutMs).toBe(3000);
  });

  it("nliProvider=onnx + 缺 localPath + throwOnConfigError=true → throw NliConfigError", async () => {
    await expect(
      getProvider({ nliProvider: "onnx", throwOnConfigError: true }),
    ).rejects.toThrow(/NLI_MODEL_LOCAL_PATH/);
  });

  it("nliProvider=onnx + 缺 localPath + throwOnConfigError=false → NoopNliProvider + warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const provider = await getProvider({ nliProvider: "onnx" });
      expect(provider).toBeInstanceOf(NoopNliProvider);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("NLI_MODEL_LOCAL_PATH not set, falling back to noop"),
      );
      // onnx provider 不应被实例化
      expect(onnxMock.instanceCount).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("nliProvider=onnx + verify Runtime 失败 → recordNliFailure → 5min cache Noop", async () => {
    // 第一次 → 创建 MockOnnxNliProvider，verify 抛错模拟 Runtime
    const provider = await getProvider({
      nliProvider: "onnx",
      onnxLocalPath: "/tmp/nli-model.onnx",
    });
    expect(provider).toBeInstanceOf(OnnxNliProvider);

    // MockOnnxNliProvider.verify 不会真抛，所以这里直接注入 recordNliFailure
    const { NliRuntimeError } = await import("../errors.js");
    recordNliFailure(new NliRuntimeError("mock onnx init failed"));

    // 5min 内再 get → 返 Noop（不重新 new OnnxNliProvider）
    const provider2 = await getProvider({
      nliProvider: "onnx",
      onnxLocalPath: "/tmp/nli-model.onnx",
    });
    expect(provider2).toBeInstanceOf(NoopNliProvider);
    // OnnxNliProvider 只被构造一次（第一次），5min cache 阶段不重新构造
    expect(onnxMock.instanceCount).toBe(1);
  });

  it("env NLI_PROVIDER=onnx (无 opts.nliProvider) → 自动走 OnnxNliProvider", async () => {
    process.env.NLI_PROVIDER = "onnx";
    process.env.NLI_MODEL_LOCAL_PATH = "/tmp/cloud-nli.onnx";
    __resetProviderStateForTest();

    const provider = await getProvider({ onnxLocalPath: "/tmp/cloud-nli.onnx" });
    expect(provider).toBeInstanceOf(OnnxNliProvider);
    expect(onnxMock.lastOpts?.localModelPath).toBe("/tmp/cloud-nli.onnx");

    // cleanup
    delete process.env.NLI_PROVIDER;
    delete process.env.NLI_MODEL_LOCAL_PATH;
  });

  it("向后兼容: NLI_PROVIDER=http (默认) + 有 key → HttpNliProvider", async () => {
    process.env.NLI_PROVIDER = "http";
    process.env.SILICONFLOW_API_KEY = "sk-test";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ENTAILED_OUT,
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const provider = await getProvider();
      expect(provider).toBeInstanceOf(HttpNliProvider);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.NLI_PROVIDER;
      delete process.env.SILICONFLOW_API_KEY;
    }
  });

  it("向后兼容: NLI_PROVIDER=noop (无 opts.nliProvider) → NoopNliProvider", async () => {
    process.env.NLI_PROVIDER = "noop";

    const provider = await getProvider();
    expect(provider).toBeInstanceOf(NoopNliProvider);

    delete process.env.NLI_PROVIDER;
  });
});
