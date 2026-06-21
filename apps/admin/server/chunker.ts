/**
 * CP-7-C: chunker — wrap shared chunkText 给 IngestOrchestrator
 *
 * Orchestrator 期望 ChunkText 接口（async chunkText(text) → [{idx, content, tokenCount}]）
 * shared chunkText 是 sync 的 + 返回 {id, idx, content, tokenCount}，包一层适配。
 *
 * 切分参数：maxTokens=500, overlapTokens=80（跟 api-ingest handler 一致）
 */

import { chunkText as sharedChunkText } from "@unequal/shared/chunking";

export async function chunkText(text: string): Promise<Array<{ idx: number; content: string; tokenCount: number }>> {
  const chunks = sharedChunkText(text, { maxTokens: 500, overlapTokens: 80 });
  return chunks.map((c) => ({ idx: c.idx, content: c.content, tokenCount: c.tokenCount }));
}