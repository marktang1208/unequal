/**
 * P3-7 / Phase A: Provider factory — env 驱动创建 Local/Cloud Embedder + Chat
 *
 * 迁移自 `apps/admin/server/embedder-factory.ts`（仅 embedder 部分），
 * P3-7 补 chat factory + `createProviderPair()` 一次性返 (embed, chat) 配对。
 */

import type { ChatProvider, Embedder, EmbedderProvider, Chat } from "./types.js";
import { LocalEmbedder } from "./local-embedder.js";
import { CloudEmbedder } from "./cloud-embedder.js";
import { LocalChat } from "./local-chat.js";
import { CloudChat } from "./cloud-chat.js";
import type { ChatConfig, EmbedderConfig } from "./config.js";

/** 单 Embedder factory（admin 现有测试用） */
export function createEmbedder(cfg: EmbedderConfig): Embedder {
  if (cfg.provider === "local") {
    if (!cfg.omlxBaseUrl || !cfg.omlxModel) {
      throw new Error("local embedder requires omlxBaseUrl + omlxModel");
    }
    return new LocalEmbedder({
      baseUrl: cfg.omlxBaseUrl,
      apiKey: cfg.omlxApiKey ?? "mark",
      model: cfg.omlxModel,
      expectedDim: cfg.expectedDim,
    });
  }
  if (cfg.provider === "cloud") {
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
  throw new Error(`createEmbedder: unsupported provider "${cfg.provider}" (must be local|cloud; use loadLocalLLMConfig for auto resolution)`);
}

/** 单 Chat factory */
export function createChat(cfg: ChatConfig): Chat {
  if (cfg.provider === "local") {
    if (!cfg.omlxBaseUrl || !cfg.omlxModel) {
      throw new Error("local chat requires omlxBaseUrl + omlxModel");
    }
    return new LocalChat({
      baseUrl: cfg.omlxBaseUrl,
      apiKey: cfg.omlxApiKey ?? "mark",
      model: cfg.omlxModel,
    });
  }
  if (cfg.provider === "cloud") {
    if (!cfg.cloudApiKey || !cfg.cloudModel) {
      throw new Error("cloud chat requires cloudApiKey + cloudModel");
    }
    return new CloudChat({
      apiKey: cfg.cloudApiKey,
      baseUrl: cfg.cloudBaseUrl ?? "https://api.minimax.chat/v1",
      model: cfg.cloudModel,
    });
  }
  throw new Error(`createChat: unsupported provider "${cfg.provider}"`);
}

/** 一次性返 (embed, chat) 配对（admin-upload / crawler 共用） */
export function createProviderPair(cfg: { embed: EmbedderConfig; chat: ChatConfig }): {
  embed: Embedder;
  chat: Chat;
  embedProvider: EmbedderProvider;
  chatProvider: ChatProvider;
} {
  return {
    embed: createEmbedder(cfg.embed),
    chat: createChat(cfg.chat),
    embedProvider: cfg.embed.provider,
    chatProvider: cfg.chat.provider,
  };
}
