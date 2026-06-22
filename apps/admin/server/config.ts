/**
 * CP-7-C: LLM Provider 配置 — env 驱动 local/cloud 切换
 *
 * 用法：
 *   import { loadConfig } from "./config.js";
 *   const cfg = loadConfig();
 *   if (cfg.embedProvider === "local") { ... }
 *
 * Env:
 *   EMBED_PROVIDER     = local | cloud  (默认 auto: 探 OMLX 在 8000 → local，否则 cloud)
 *   LLM_PROVIDER       = local | cloud  (默认 auto)
 *   OMLX_BASE_URL      = http://localhost:8000/v1
 *   OMLX_API_KEY       = mark
 *   OMLX_EMBED_MODEL   = Qwen3-Embedding-4B-4bit-DWQ
 *   OMLX_CHAT_MODEL    = Qwen3.6-35B-A3B-4bit
 *   MINIMAX_API_KEY    = eyJ...
 *   MINIMAX_BASE_URL   = https://api.minimax.chat/v1
 *   MINIMAX_EMBED_MODEL = embo-01
 *   MINIMAX_CHAT_MODEL  = MiniMax-Text-01
 *   MINERU_MODEL_SOURCE = modelscope  (huggingface | modelscope)
 *   LOCAL_PARSER_MINERU_TIMEOUT_MS = 1800000  (默认 30min)
 */

export type ProviderName = "local" | "cloud";

export interface EmbedderConfig {
  provider: ProviderName;
  /** 1536 维 (matryoshka 截断或 MiniMax 原生) */
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
  provider: ProviderName;
  // local-only
  omlxBaseUrl?: string;
  omlxApiKey?: string;
  omlxModel?: string;
  // cloud-only
  cloudApiKey?: string;
  cloudBaseUrl?: string;
  cloudModel?: string;
}

export interface PdfConfig {
  /** mineru 模型源（huggingface | modelscope）。中国网络必须 modelscope */
  mineruModelSource: "huggingface" | "modelscope" | string;
  /** mineru 单次超时（ms）默认 30min */
  mineruTimeoutMs: number;
}

export interface AppConfig {
  embed: EmbedderConfig;
  chat: ChatConfig;
  pdf: PdfConfig;
}

/** 探 OMLX 是否可达（2s timeout） */
async function probeOmlxAvailable(baseUrl: string, apiKey: string): Promise<boolean> {
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

/**
 * 加载并合并 config。
 * - "auto" 模式：OMLX 可达 → local，否则 cloud
 * - "local" 模式：OMLX 不可达 → 抛错（避免静默走 cloud 让用户困惑）
 * - "cloud" 模式：要求 MINIMAX_API_KEY 已设
 */
export async function loadConfig(): Promise<AppConfig> {
  const omlxBaseUrl = process.env.OMLX_BASE_URL ?? "http://localhost:8000/v1";
  const omlxApiKey = process.env.OMLX_API_KEY ?? "mark";
  const omlxEmbedModel = process.env.OMLX_EMBED_MODEL ?? "Qwen3-Embedding-4B-4bit-DWQ";
  const omlxChatModel = process.env.OMLX_CHAT_MODEL ?? "Qwen3.6-35B-A3B-4bit";

  const cloudApiKey = process.env.MINIMAX_API_KEY ?? "";
  const cloudBaseUrl = process.env.MINIMAX_BASE_URL ?? "https://api.minimax.chat/v1";
  const cloudEmbedModel = process.env.MINIMAX_EMBED_MODEL ?? "embo-01";
  const cloudChatModel = process.env.MINIMAX_CHAT_MODEL ?? "MiniMax-Text-01";

  const embedRequested = process.env.EMBED_PROVIDER ?? "auto";
  const chatRequested = process.env.LLM_PROVIDER ?? "auto";

  // 解析 embed provider
  let embedProvider: ProviderName;
  if (embedRequested === "local") {
    embedProvider = "local";
  } else if (embedRequested === "cloud") {
    if (!cloudApiKey) throw new Error("EMBED_PROVIDER=cloud but MINIMAX_API_KEY not set");
    embedProvider = "cloud";
  } else {
    // auto
    embedProvider = (await probeOmlxAvailable(omlxBaseUrl, omlxApiKey)) ? "local" : "cloud";
    if (embedProvider === "cloud" && !cloudApiKey) {
      throw new Error("Auto-detected cloud embed but MINIMAX_API_KEY not set");
    }
  }

  // 解析 chat provider
  let chatProvider: ProviderName;
  if (chatRequested === "local") {
    chatProvider = "local";
  } else if (chatRequested === "cloud") {
    if (!cloudApiKey) throw new Error("LLM_PROVIDER=cloud but MINIMAX_API_KEY not set");
    chatProvider = "cloud";
  } else {
    chatProvider = (await probeOmlxAvailable(omlxBaseUrl, omlxApiKey)) ? "local" : "cloud";
    if (chatProvider === "cloud" && !cloudApiKey) {
      throw new Error("Auto-detected cloud chat but MINIMAX_API_KEY not set");
    }
  }

  const embedConfig: EmbedderConfig = {
    provider: embedProvider,
    expectedDim: 1536,  // 必须跟 CloudBase MiniMax 对齐
    ...(embedProvider === "local"
      ? { omlxBaseUrl, omlxApiKey, omlxModel: omlxEmbedModel }
      : { cloudApiKey, cloudBaseUrl, cloudModel: cloudEmbedModel }),
  };

  const chatConfig: ChatConfig = {
    provider: chatProvider,
    ...(chatProvider === "local"
      ? { omlxBaseUrl, omlxApiKey, omlxModel: omlxChatModel }
      : { cloudApiKey, cloudBaseUrl, cloudModel: cloudChatModel }),
  };

  const pdfConfig: PdfConfig = {
    mineruModelSource: process.env.MINERU_MODEL_SOURCE ?? "modelscope",
    mineruTimeoutMs: Number(process.env.LOCAL_PARSER_MINERU_TIMEOUT_MS) || 30 * 60 * 1000,
  };

  return { embed: embedConfig, chat: chatConfig, pdf: pdfConfig };
}

/** 同步版本（用 cache 避免每次 await probe）。适合非启动路径 */
let _cachedConfig: AppConfig | null = null;
let _cachedConfigPromise: Promise<AppConfig> | null = null;

export function getCachedConfig(): AppConfig | null {
  return _cachedConfig;
}

export async function initConfig(): Promise<AppConfig> {
  if (!_cachedConfigPromise) {
    _cachedConfigPromise = loadConfig().then((c) => {
      _cachedConfig = c;
      return c;
    });
  }
  return _cachedConfigPromise;
}