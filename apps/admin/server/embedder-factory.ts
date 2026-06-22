/**
 * CP-7-C: Embedder factory — 根据 config 创建 LocalEmbedder 或 CloudEmbedder
 */

import type { EmbedderConfig } from "./config.js";
import { LocalEmbedder } from "./local-embedder.js";
import { CloudEmbedder } from "./cloud-embedder.js";

export function createEmbedder(cfg: EmbedderConfig): LocalEmbedder | CloudEmbedder {
  if (cfg.provider === "local") {
    if (!cfg.omlxBaseUrl || !cfg.omlxModel) {
      throw new Error("local embedder requires omlxBaseUrl + omlxModel");
    }
    return new LocalEmbedder({
      baseUrl: cfg.omlxBaseUrl,
      apiKey: cfg.omlxApiKey ?? "mark",
      model: cfg.omlxModel,
    });
  }
  // cloud
  if (!cfg.cloudApiKey || !cfg.cloudModel) {
    throw new Error("cloud embedder requires cloudApiKey + cloudModel");
  }
  return new CloudEmbedder({
    apiKey: cfg.cloudApiKey,
    baseUrl: cfg.cloudBaseUrl ?? "https://api.minimax.chat/v1",
    model: cfg.cloudModel,
    expectedDim: cfg.expectedDim,
  });
}