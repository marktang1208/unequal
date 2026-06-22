/**
 * P3-7 / Phase A: CloudChat — MiniMax abab chat
 */

import type { Chat, ChatMessage } from "./types.js";

export const DEFAULT_CLOUD_CHAT_MODEL = "MiniMax-Text-01";

export interface CloudChatOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  temperature?: number;
  maxTokens?: number;
}

export class CloudChat implements Chat {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private fetch: typeof fetch;

  constructor(opts: CloudChatOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.minimax.chat/v1";
    this.model = opts.model ?? DEFAULT_CLOUD_CHAT_MODEL;
    this.temperature = opts.temperature ?? 0.7;
    this.maxTokens = opts.maxTokens ?? 2048;
    this.fetch = opts.fetchImpl ?? fetch;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const res = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cloud chat failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content ?? "";
  }
}
