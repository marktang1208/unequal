/**
 * P3-7 / Phase A: LocalChat — OMLX Qwen3.6 35B-A3B 4bit chat
 *
 * OMLX 提供 OpenAI 兼容 chat completions API。
 * 默认 model: Qwen3.6-35B-A3B-4bit (MoE, 激活 3B → 速度快)
 */

import OpenAI from "openai";
import type { Chat, ChatMessage } from "./types.js";

export const DEFAULT_LOCAL_CHAT_MODEL = "Qwen3.6-35B-A3B-4bit";

export interface LocalChatOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  temperature?: number;
  maxTokens?: number;
}

export class LocalChat implements Chat {
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(opts: LocalChatOptions = {}) {
    const baseUrl = opts.baseUrl ?? "http://localhost:8000/v1";
    this.model = opts.model ?? DEFAULT_LOCAL_CHAT_MODEL;
    this.temperature = opts.temperature ?? 0.7;
    this.maxTokens = opts.maxTokens ?? 2048;
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? "mark",
      baseURL: baseUrl,
      dangerouslyAllowBrowser: true,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl as any } : {}),
    });
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    });
    return resp.choices[0]?.message?.content ?? "";
  }
}
