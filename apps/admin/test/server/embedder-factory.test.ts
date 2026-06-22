/**
 * embedder-factory 单元测试
 */

import { describe, it, expect } from "vitest";
import { createEmbedder } from "../../server/embedder-factory.js";
import { LocalEmbedder } from "../../server/local-embedder.js";
import { CloudEmbedder } from "../../server/cloud-embedder.js";

describe("createEmbedder (CP-7-C T72)", () => {
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