/**
 * CP-7-D #2: API 端 LLM Provider 抽象
 *
 * 设计目的：handlers 不再直接 import "MiniMax" / createMiniMaxEmbedder，
 * 通过 getEmbedder() / getChatProvider() 拿 provider，调用方对实现无感。
 *
 * 当前实现：仅 cloud（MiniMax），因为 API 端跑在 CloudBase 云函数上，无 OMLX 可用。
 * 未来如果 dev 环境也想切 OMLX（需要 CloudBase 函数连 Mac 网络），加 local 分支。
 *
 * 现在的价值：
 * - handlers 不再 hardcode MiniMax，便于切 OpenAI / DeepSeek / 自部署 LLM
 * - 测试可以 mock factory 不 mock MiniMax HTTP
 * - 启动时硬验证（dim）走工厂
 */

import type { Embedder } from "@unequal/shared/embedding";
import { createMiniMaxEmbedder } from "@unequal/shared/embedding";
import { getEnv } from "./env.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  /** 可选 override；默认走 env.LLM_MODEL */
  model?: string;
  /** P7 #5: LLM max_tokens (默认 env.LLM_MAX_TOKENS=2048) */
  maxTokens?: number;
}

export interface ChatResponse {
  content: string;
}

export interface ChatProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

let _embedder: Embedder | null = null;
let _chat: ChatProvider | null = null;

export function getEmbedder(): Embedder {
  if (_embedder) return _embedder;
  const env = getEnv();
  _embedder = createMiniMaxEmbedder({
    apiKey: env.MINIMAX_API_KEY,
    baseUrl: env.MINIMAX_BASE_URL,
    model: env.EMBED_MODEL,
  });
  return _embedder;
}

export function getChatProvider(): ChatProvider {
  if (_chat) return _chat;
  const env = getEnv();
  const baseUrl = env.MINIMAX_BASE_URL;
  const apiKey = env.MINIMAX_API_KEY;
  _chat = {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      // P7 #5: max_tokens safety net — 每次 chat() 调 getEnv() 取最新 LLM_MAX_TOKENS
      // 避免单例闭包锁住 test 或 hot-reload 改 env 后的旧值
      const envNow = getEnv();
      // fallback 2048: 防止 env.LLM_MAX_TOKENS 未设 (legacy deploy) 或 mock test
      const defaultMaxTokens = envNow.LLM_MAX_TOKENS ?? 2048;
      const model = req.model ?? envNow.LLM_MODEL;
      const res = await fetch(`${envNow.MINIMAX_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${envNow.MINIMAX_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: req.messages,
          temperature: req.temperature ?? 0.3,
          max_tokens: req.maxTokens ?? defaultMaxTokens,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`chat failed: ${res.status} ${body}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return { content: json.choices?.[0]?.message?.content ?? "" };
    },
  };
  return _chat;
}

/** 测试用：注入 mock provider（避免真实 HTTP） */
export function __setEmbedderForTest(embedder: Embedder): void {
  _embedder = embedder;
}

export function __setChatProviderForTest(provider: ChatProvider): void {
  _chat = provider;
}

/** 测试用：重置单例 */
export function resetProviders(): void {
  _embedder = null;
  _chat = null;
}
