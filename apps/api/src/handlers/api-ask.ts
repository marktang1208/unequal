/**
 * api-ask handler（CP-6 Phase 5 完整实现）
 * POST /api-ask { q: "..." }
 *
 * admin auth + MiniMax embed query + retrieval + MiniMax chat + [N] citations
 *
 * CP-7-D #2-a: 引用格式从 {"citations":[N]} JSON 块 改为 [N] 内联标记
 * （对齐 api-chat，复用 parseAnswerSegments）。
 */
import {
  errorResponse,
  jsonResponse,
  optionsResponse,
  parseJsonBody,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";
import { requireAdmin } from "../lib/auth-admin.js";
// CP-7-D #2: 走 factory（不再 import createMiniMaxEmbedder）
import { getEmbedder, getChatProvider } from "../lib/llm-provider.js";
import { searchChunks, type ChunkWithEmbedding } from "@unequal/shared/retrieval";
import { buildAskPrompt, DISCLAIMER_TEXT } from "@unequal/shared/prompt";
import { COLLECTIONS } from "../lib/collections.js";
import { getAllByFilter } from "../lib/db.js";
import { parseAnswerSegments } from "./api-chat.js";
import type { Chunk, Document } from "@unequal/shared/types";

interface AskRequest {
  q: string;
  /** M7-B: 限定 sourceType 列表 */
  sourceTypes?: string[];
  /** M7-B: 排除 sourceId 列表 */
  excludeSourceIds?: string[];
}

interface CitationOut {
  n: number;
  title: string;
  snippet: string;
  url: string;
  trustLevel: number;
  sourceId: string;
  chunkId: string;
}

interface AskResponse {
  answer: string;
  citations: CitationOut[];
  disclaimer: string;
}

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  const auth = await requireAdmin(event, env);
  if (!auth.ok) return auth.response;

  const body = parseJsonBody<AskRequest>(event);
  if (!body?.q || typeof body.q !== "string") {
    return errorResponse("INVALID_REQUEST", "Missing 'q' field", 400);
  }
  const q = body.q.trim();
  if (!q) {
    return errorResponse("INVALID_REQUEST", "Empty 'q'", 400);
  }
  // M7-B: source 过滤（可选）
  const sourceTypes = body.sourceTypes && body.sourceTypes.length > 0 ? body.sourceTypes : undefined;
  const excludeSourceIds = body.excludeSourceIds && body.excludeSourceIds.length > 0 ? body.excludeSourceIds : undefined;

  // 1. embed query
  // CP-7-D #2: 走 factory
  const embed = getEmbedder();
  const queryVec = (await embed.embed([q]))[0] ?? [];

  // 2. fetch chunks + retrieval
  const chunks = await getAllByFilter<Chunk>(COLLECTIONS.chunk, { userId: env.DEFAULT_USER_ID });
  const chunksWithEmb: ChunkWithEmbedding[] = chunks.map((c) => ({
    id: c.id,
    _id: c._id,
    documentId: c.documentId,
    sourceId: c.sourceId,
    userId: c.userId,
    idx: c.idx,
    content: c.content,
    embedding: c.embedding,
    tokenCount: c.tokenCount,
    trustLevel: c.trustLevel,
    createdAt: c.createdAt,
  }));

  const top = await searchChunks({
    fetchChunksByUser: async () => chunksWithEmb,
    userId: env.DEFAULT_USER_ID,
    queryVector: queryVec,
    topK: 5,
    scoreThreshold: 0.3,
    ...(sourceTypes ? { sourceTypes } : {}),
    ...(excludeSourceIds ? { excludeSourceIds } : {}),
  });

  // 3. fetch docs for titles (denormalize: chunk has documentId, doc has title)
  // CP-7-C #6 迁移后 chunk.documentId 已是 schema `id`（= _id）。chat 用 getById(_id)，ask 用 whereQuery({id}) 兼容性等价（id == _id after migration）
  const findChunk = (chunkId: string) =>
    chunksWithEmb.find((c) => (c._id ?? c.id) === chunkId);
  const docIds = Array.from(new Set(top.map((t) => findChunk(t.chunkId)?.documentId).filter(Boolean) as string[]));
  const docs = await Promise.all(docIds.map((id) => getAllByFilter<Document>(COLLECTIONS.document, { id }, 1).then((r) => r[0])));
  const docMap = new Map(docs.filter(Boolean).map((d) => [d!.id, d!]));

  // 4. build prompt
  const ctx = {
    chunks: top.slice(0, 5).map((t, i) => {
      const chunk = findChunk(t.chunkId);
      const doc = chunk ? docMap.get(chunk.documentId) : undefined;
      return {
        n: (i + 1) as 1 | 2 | 3 | 4 | 5,
        title: doc?.title ?? "未知文档",
        snippet: chunk?.content.slice(0, 300) ?? "",
        trustLevel: t.trustLevel,
      };
    }),
  };
  const { system, user } = buildAskPrompt(q, ctx);

  // 5. LLM chat completion
  // CP-7-D #2: 走 factory；错误包成 502 MINIMAX_FAILED 保持对外兼容
  let answer: string;
  try {
    const result = await getChatProvider().chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    });
    answer = result.content;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse("MINIMAX_FAILED", `LLM chat failed: ${message}`, 502);
  }

  // 6. CP-7-D #2-a: 解析 [N] 引用（复用 chat 的 parseAnswerSegments）
  const topChunks = top.slice(0, 5);
  const { citedNums } = parseAnswerSegments(answer, topChunks.length);
  // 过滤越界（保 citedNums 顺序）
  const validCitedNums = citedNums.filter((n) => n >= 1 && n <= topChunks.length);

  const citations: CitationOut[] = validCitedNums
    .map((n) => {
      const i = n - 1;
      const t = topChunks[i];
      if (!t) return null;
      const chunk = findChunk(t.chunkId);
      const doc = chunk ? docMap.get(chunk.documentId) : undefined;
      return {
        n,
        title: doc?.title ?? "未知文档",
        snippet: chunk?.content.slice(0, 200) ?? "",
        url: doc?.rawPath ?? "",
        trustLevel: t.trustLevel as number,
        sourceId: chunk?.sourceId ?? "",
        chunkId: t.chunkId,
      };
    })
    .filter((c): c is CitationOut => c !== null);

  const response: AskResponse = {
    answer,
    citations,
    disclaimer: DISCLAIMER_TEXT,
  };
  return jsonResponse(response);
}