/**
 * P3-7 / Phase A: LLM Provider 配置 — env 驱动 local/cloud 切换
 *
 * 迁移自 `apps/admin/server/config.ts`（commit ff77dd3），行为保持一致：
 * - "auto" 模式：OMLX 可达 → local，否则 cloud
 * - "local" 模式：OMLX 不可达 → 抛错
 * - "cloud" 模式：要求 MINIMAX_API_KEY 已设
 *
 * 用法：
 *   import { loadLocalLLMConfig } from "@unequal/local-llm/config";
 *   const cfg = await loadLocalLLMConfig();
 *   if (cfg.embed.provider === "local") { ... }
 */

import type { ChatProvider, EmbedderProvider } from "./types.js";

export interface EmbedderConfig {
  provider: EmbedderProvider;
  expectedDim: number;
  // local-only
  omlxBaseUrl?: string;
  omlxApiKey?: string;
  omlxModel?: string;
  // cloud-only
  cloudApiKey?: string;
  cloudBaseUrl?: string;
  cloudModel?: string;
}

export interface ChatConfig {
  provider: ChatProvider;
  omlxBaseUrl?: string;
  omlxApiKey?: string;
  omlxModel?: string;
  cloudApiKey?: string;
  cloudBaseUrl?: string;
  cloudModel?: string;
}

export interface LocalLLMConfig {
  embed: EmbedderConfig;
  chat: ChatConfig;
}

/** 探 OMLX 是否可达（2s timeout） */
export async function probeOmlxAvailable(
  baseUrl: string,
  apiKey: string,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

function resolveProvider(env: string | undefined): EmbedderProvider | ChatProvider {
  if (env === "local" || env === "cloud" || env === "auto") return env;
  return "auto";
}

/**
 * 加载并合并 config。
 * - "auto" 模式：OMLX 可达 → local，否则 cloud
 * - "local" 模式：OMLX 不可达 → 抛错
 * - "cloud" 模式：要求 MINIMAX_API_KEY 已设
 */
export async function loadLocalLLMConfig(): Promise<LocalLLMConfig> {
  const omlxBaseUrl = process.env.OMLX_BASE_URL ?? "http://localhost:8000/v1";
  const omlxApiKey = process.env.OMLX_API_KEY ?? "mark";
  const omlxEmbedModel = process.env.OMLX_EMBED_MODEL ?? "Qwen3-Embedding-4B-4bit-DWQ";
  const omlxChatModel = process.env.OMLX_CHAT_MODEL ?? "Qwen3.6-35B-A3B-4bit";

  const cloudApiKey = process.env.MINIMAX_API_KEY ?? "";
  const cloudBaseUrl = process.env.MINIMAX_BASE_URL ?? "https://api.minimax.chat/v1";
  const cloudEmbedModel = process.env.MINIMAX_EMBED_MODEL ?? "embo-01";
  const cloudChatModel = process.env.MINIMAX_CHAT_MODEL ?? "MiniMax-Text-01";

  // 解析 embed provider
  const embedProviderRaw = resolveProvider(process.env.EMBED_PROVIDER);
  let embedProvider: EmbedderProvider;
  if (embedProviderRaw === "local") {
    embedProvider = "local";
  } else if (embedProviderRaw === "cloud") {
    embedProvider = "cloud";
  } else {
    // auto
    const available = await probeOmlxAvailable(omlxBaseUrl, omlxApiKey);
    embedProvider = available ? "local" : "cloud";
  }

  // 解析 chat provider（auto 探同一个 baseUrl）
  const chatProviderRaw = resolveProvider(process.env.LLM_PROVIDER);
  let chatProvider: ChatProvider;
  if (chatProviderRaw === "local") {
    chatProvider = "local";
  } else if (chatProviderRaw === "cloud") {
    chatProvider = "cloud";
  } else {
    const available = await probeOmlxAvailable(omlxBaseUrl, omlxApiKey);
    chatProvider = available ? "local" : "cloud";
  }

  return {
    embed: {
      provider: embedProvider,
      expectedDim: 1536,
      ...(embedProvider === "local"
        ? { omlxBaseUrl, omlxApiKey, omlxModel: omlxEmbedModel }
        : { cloudApiKey, cloudBaseUrl, cloudModel: cloudEmbedModel }),
    },
    chat: {
      provider: chatProvider,
      ...(chatProvider === "local"
        ? { omlxBaseUrl, omlxApiKey, omlxModel: omlxChatModel }
        : { cloudApiKey, cloudBaseUrl, cloudModel: cloudChatModel }),
    },
  };
}
