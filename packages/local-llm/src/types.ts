/**
 * P3-7 / Phase A: LLM Provider 共享类型
 *
 * admin + crawler 依赖同一份接口（`Embedder` / `Chat`），
 * provider factory 根据 env 决定返 LocalEmbedder / CloudEmbedder 等实现。
 *
 * 历史：admin 端原定义在 `apps/admin/server/llm-provider.ts`（commit ff77dd3 引入），
 * P3-7 抽到 packages/local-llm/ 共享包。
 */

export type EmbedderProvider = "local" | "cloud" | "auto";
export type ChatProvider = "local" | "cloud" | "auto";

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Chat {
  chat(messages: ChatMessage[]): Promise<string>;
}

/** P3-7 保留的 error code（admin 端 ingest-orchestrator 已经在用，迁移不改名） */
export type EmbedErrorCode = "OMLX_Unavailable" | "OOM" | "DimensionMismatch" | "Unknown";

export class EmbedError extends Error {
  constructor(
    message: string,
    public readonly code: EmbedErrorCode,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmbedError";
  }
}

/** 期望 embedding 维度（与 CloudBase MiniMax 默认对齐，cosineSimilarity 要求等长） */
export const EXPECTED_EMBED_DIM = 1536;
