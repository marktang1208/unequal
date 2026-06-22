/**
 * embedder-factory 单元测试
 *
 * P3-7: admin/server/embedder-factory.ts 已迁到 @unequal/local-llm；
 * admin 走 server/llm-provider.ts 桥 re-export。
 */

import { describe, it, expect } from "vitest";
import { createEmbedder, LocalEmbedder, CloudEmbedder } from "../../server/llm-provider.js";

describe("createEmbedder (P3-7 走 llm-provider 桥)", () => {
  it("provider=local → LocalEmbedder 实例", () => {
    const e = createEmbedder({
      provider: "local",
      expectedDim: 1536,
      omlxBaseUrl: "http://x/v1",
      omlxApiKey: "k",
      omlxModel: "Qwen3-Embedding-4B",
    });
    expect(e).toBeInstanceOf(LocalEmbedder);
  });

  it("provider=cloud → CloudEmbedder 实例", () => {
    const e = createEmbedder({
      provider: "cloud",
      expectedDim: 1536,
      cloudApiKey: "k",
      cloudBaseUrl: "https://x/v1",
      cloudModel: "embo-01",
    });
    expect(e).toBeInstanceOf(CloudEmbedder);
  });

  it("local 缺 omlxBaseUrl → 抛错", () => {
    expect(() => createEmbedder({ provider: "local", expectedDim: 1536 })).toThrow(/omlxBaseUrl/);
  });

  it("cloud 缺 cloudApiKey → 抛错", () => {
    expect(() => createEmbedder({ provider: "cloud", expectedDim: 1536 })).toThrow(/cloudApiKey/);
  });
});