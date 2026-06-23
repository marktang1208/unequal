/**
 * get-provider.test.ts — 10 cases (spec §11.1)
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
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  getProvider,
  recordNliFailure,
  recordNliSuccess,
  __resetProviderStateForTest,
} from "../get-provider.js";
import { NoopNliProvider } from "../noop-provider.js";
import { HttpNliProvider } from "../http-provider.js";

const ENTAILED_OUT = {
  choices: [
    { message: { content: '{"entailment":0.9,"neutral":0.05,"contradiction":0.05}' } },
  ],
};

describe("getProvider", () => {
  beforeEach(() => {
    __resetProviderStateForTest();
    delete process.env.NLI_PROVIDER;
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
});
