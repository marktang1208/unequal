/**
 * packages/local-llm 单元测试
 *
 * P3-7 / Phase A: 共享包内部 test（admin 端 + crawler 端共用 provider 工厂）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createEmbedder,
  createChat,
  createProviderPair,
  LocalEmbedder,
  CloudEmbedder,
  LocalChat,
  CloudChat,
  loadLocalLLMConfig,
  probeOmlxAvailable,
  EmbedError,
  EXPECTED_EMBED_DIM,
} from "../src/index.js";

describe("createEmbedder (P3-7)", () => {
  it("provider=local + 全字段 → 返 LocalEmbedder 实例", () => {
    const e = createEmbedder({
      provider: "local",
      expectedDim: EXPECTED_EMBED_DIM,
      omlxBaseUrl: "http://x/v1",
      omlxApiKey: "k",
      omlxModel: "Qwen3-Embedding-4B",
    });
    expect(e).toBeInstanceOf(LocalEmbedder);
  });

  it("provider=cloud + 全字段 → 返 CloudEmbedder 实例", () => {
    const e = createEmbedder({
      provider: "cloud",
      expectedDim: EXPECTED_EMBED_DIM,
      cloudApiKey: "k",
      cloudBaseUrl: "https://x/v1",
      cloudModel: "embo-01",
    });
    expect(e).toBeInstanceOf(CloudEmbedder);
  });

  it("provider=local 缺 omlxBaseUrl → 抛错", () => {
    expect(() => createEmbedder({ provider: "local", expectedDim: EXPECTED_EMBED_DIM })).toThrow(/omlxBaseUrl/);
  });

  it("provider=cloud 缺 cloudApiKey → 抛错", () => {
    expect(() => createEmbedder({ provider: "cloud", expectedDim: EXPECTED_EMBED_DIM })).toThrow(/cloudApiKey/);
  });

  it("provider 非法 → 抛错", () => {
    expect(() => createEmbedder({ provider: "auto" as any, expectedDim: EXPECTED_EMBED_DIM })).toThrow();
  });
});

describe("createChat (P3-7)", () => {
  it("provider=local + 全字段 → 返 LocalChat 实例", () => {
    const c = createChat({
      provider: "local",
      omlxBaseUrl: "http://x/v1",
      omlxApiKey: "k",
      omlxModel: "Qwen3.6-35B-A3B-4bit",
    });
    expect(c).toBeInstanceOf(LocalChat);
  });

  it("provider=cloud + 全字段 → 返 CloudChat 实例", () => {
    const c = createChat({
      provider: "cloud",
      cloudApiKey: "k",
      cloudBaseUrl: "https://x/v1",
      cloudModel: "MiniMax-Text-01",
    });
    expect(c).toBeInstanceOf(CloudChat);
  });

  it("provider=local 缺 omlxModel → 抛错", () => {
    expect(() => createChat({ provider: "local", omlxBaseUrl: "http://x/v1" })).toThrow(/omlxModel/);
  });

  it("provider=cloud 缺 cloudApiKey → 抛错", () => {
    expect(() => createChat({ provider: "cloud" })).toThrow(/cloudApiKey/);
  });
});

describe("createProviderPair (P3-7)", () => {
  it("local embed + local chat → 返 LocalEmbedder + LocalChat + provider 标记", () => {
    const r = createProviderPair({
      embed: { provider: "local", expectedDim: EXPECTED_EMBED_DIM, omlxBaseUrl: "http://x/v1", omlxApiKey: "k", omlxModel: "Qwen3-Embedding-4B" },
      chat: { provider: "local", omlxBaseUrl: "http://x/v1", omlxApiKey: "k", omlxModel: "Qwen3.6-35B-A3B-4bit" },
    });
    expect(r.embed).toBeInstanceOf(LocalEmbedder);
    expect(r.chat).toBeInstanceOf(LocalChat);
    expect(r.embedProvider).toBe("local");
    expect(r.chatProvider).toBe("local");
  });
});

describe("EmbedError (P3-7)", () => {
  it("构造 → name + code + message 正确", () => {
    const e = new EmbedError("test", "DimensionMismatch");
    expect(e.name).toBe("EmbedError");
    expect(e.code).toBe("DimensionMismatch");
    expect(e.message).toBe("test");
  });
});

describe("loadLocalLLMConfig (P3-7)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = savedEnv;
  });

  it("EMBED_PROVIDER=local + LLM_PROVIDER=local → 都 local（不 probe）", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as any;
    process.env.EMBED_PROVIDER = "local";
    process.env.LLM_PROVIDER = "local";
    const cfg = await loadLocalLLMConfig();
    expect(cfg.embed.provider).toBe("local");
    expect(cfg.chat.provider).toBe("local");
  });

  it("EMBED_PROVIDER=cloud + MINIMAX_API_KEY → cloud", async () => {
    globalThis.fetch = vi.fn() as any;
    process.env.EMBED_PROVIDER = "cloud";
    process.env.LLM_PROVIDER = "cloud";
    process.env.MINIMAX_API_KEY = "test-key";
    const cfg = await loadLocalLLMConfig();
    expect(cfg.embed.provider).toBe("cloud");
    expect(cfg.embed.cloudApiKey).toBe("test-key");
    expect(cfg.embed.cloudModel).toBe("embo-01");
  });

  it("auto: OMLX 可达 → local（mock fetch /models 返 200）", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 })) as any;
    delete process.env.EMBED_PROVIDER;
    delete process.env.LLM_PROVIDER;
    const cfg = await loadLocalLLMConfig();
    expect(cfg.embed.provider).toBe("local");
    expect(cfg.chat.provider).toBe("local");
  });
});

describe("probeOmlxAvailable (P3-7)", () => {
  it("fetch 200 → true", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 })) as any;
    const r = await probeOmlxAvailable("http://x", "k");
    expect(r).toBe(true);
  });

  it("fetch 500 → false", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 500 })) as any;
    const r = await probeOmlxAvailable("http://x", "k");
    expect(r).toBe(false);
  });

  it("fetch reject → false", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as any;
    const r = await probeOmlxAvailable("http://x", "k");
    expect(r).toBe(false);
  });
});
