/**
 * config.ts 单元测试（T72）
 *
 * 测 env-driven 加载 + auto probe
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("loadConfig (CP-7-C T72)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = savedEnv;
  });

  it("default (auto): OMLX 可达 → local", async () => {
    // mock fetch 让 OMLX 探测 OK
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 })) as any;
    delete process.env.EMBED_PROVIDER;
    delete process.env.MINIMAX_API_KEY;
    const { loadConfig } = await import("../../server/config.js");
    const cfg = await loadConfig();
    expect(cfg.embed.provider).toBe("local");
    expect(cfg.chat.provider).toBe("local");
    expect(cfg.embed.omlxBaseUrl).toMatch(/localhost:8000/);
    expect(cfg.embed.omlxModel).toBe("Qwen3-Embedding-4B-4bit-DWQ");
  });

  it("EMBED_PROVIDER=cloud + MINIMAX_API_KEY → cloud", async () => {
    globalThis.fetch = vi.fn() as any;
    process.env.EMBED_PROVIDER = "cloud";
    process.env.MINIMAX_API_KEY = "test-key";
    process.env.LLM_PROVIDER = "cloud";
    const { loadConfig } = await import("../../server/config.js");
    const cfg = await loadConfig();
    expect(cfg.embed.provider).toBe("cloud");
    expect(cfg.chat.provider).toBe("cloud");
    expect(cfg.embed.cloudApiKey).toBe("test-key");
    expect(cfg.embed.cloudModel).toBe("embo-01");
  });

  it("EMBED_PROVIDER=local → local embed（不 probe）; 但 LLM_PROVIDER=auto + OMLX 不可达 + 无 cloud key → 抛错", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as any;
    process.env.EMBED_PROVIDER = "local";
    // 不设 LLM_PROVIDER → auto 探测 → OMLX 不可达 → chat 想走 cloud → 抛错
    delete process.env.MINIMAX_API_KEY;
    const { loadConfig } = await import("../../server/config.js");
    await expect(loadConfig()).rejects.toThrow(/MINIMAX_API_KEY/);
  });

  it("EMBED_PROVIDER=local + LLM_PROVIDER=local → 都 local（不 probe）", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as any;
    process.env.EMBED_PROVIDER = "local";
    process.env.LLM_PROVIDER = "local";
    delete process.env.MINIMAX_API_KEY;
    const { loadConfig } = await import("../../server/config.js");
    const cfg = await loadConfig();
    expect(cfg.embed.provider).toBe("local");
    expect(cfg.chat.provider).toBe("local");
  });

  it("EMBED_PROVIDER=cloud 但无 MINIMAX_API_KEY → 抛错", async () => {
    delete process.env.MINIMAX_API_KEY;
    process.env.EMBED_PROVIDER = "cloud";
    const { loadConfig } = await import("../../server/config.js");
    await expect(loadConfig()).rejects.toThrow(/MINIMAX_API_KEY/);
  });

  it("auto: OMLX 不可达 + 无 cloud key → 抛错", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as any;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.EMBED_PROVIDER;
    const { loadConfig } = await import("../../server/config.js");
    await expect(loadConfig()).rejects.toThrow(/MINIMAX_API_KEY/);
  });

  it("pdf config: MINERU_MODEL_SOURCE + timeout 透传", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 })) as any;
    process.env.MINERU_MODEL_SOURCE = "modelscope";
    process.env.LOCAL_PARSER_MINERU_TIMEOUT_MS = "60000";
    const { loadConfig } = await import("../../server/config.js");
    const cfg = await loadConfig();
    expect(cfg.pdf.mineruModelSource).toBe("modelscope");
    expect(cfg.pdf.mineruTimeoutMs).toBe(60000);
  });
});