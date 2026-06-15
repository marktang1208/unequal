/**
 * 调 MiniMax chat completion（OpenAI 兼容）。
 * Mock-first：测试用 globalThis.fetch 拦截，参见 test/llm-fixtures.ts。
 * 真接 MiniMax 时改 MINIMAX_BASE_URL 即可。
 */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMChatOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export async function chatCompletion(opts: LLMChatOptions): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 3;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await f(`${opts.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          temperature: opts.temperature ?? 0.2,
        }),
      });

      if (!res.ok) {
        throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = data.choices[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("LLM response missing choices[0].message.content");
      }
      return content;
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries - 1) break;
      // 简单退避：100ms * 2^attempt
      await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
    }
  }
  throw new Error(`LLM chat failed after ${maxRetries} attempts: ${String(lastErr)}`);
}