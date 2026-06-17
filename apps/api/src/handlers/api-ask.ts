/**
 * api-ask handler（CP-6 Phase 5 完整实现）
 * POST /api-ask { q: "..." }
 *
 * admin auth + MiniMax embed query + retrieval + MiniMax chat + citations
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
import { createMiniMaxEmbedder } from "@unequal/shared/embedding";
import { searchChunks, type ChunkWithEmbedding } from "@unequal/shared/retrieval";
import { buildAskPrompt, DISCLAIMER_TEXT } from "@unequal/shared/prompt";
import { COLLECTIONS } from "../lib/collections.js";
import { getAllByFilter } from "../lib/db.js";
import type { Chunk, Document } from "@unequal/shared/types";

interface AskRequest {
  q: string;
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

function parseCitationsJson(answer: string): number[] {
  // 抓答案末尾的 {"citations": [...]} JSON 块
  const m = answer.match(/\{"citations":\s*\[([^\]]*)\]\s*\}/);
  if (!m) return [];
  const inner = m[1] ?? "";
  return inner
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

function stripCitationsJson(answer: string): string {
  // 去掉末尾的 JSON 块，保留正文
  return answer.replace(/\s*\{"citations":\s*\[[^\]]*\]\s*\}\s*$/, "").trim();
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

  // 1. embed query
  const embed = createMiniMaxEmbedder({
    apiKey: env.MINIMAX_API_KEY,
    baseUrl: env.MINIMAX_BASE_URL,
    model: "MiniMax-embeddings",
  });
  const queryVec = (await embed.embed([q]))[0] ?? [];

  // 2. fetch chunks + retrieval
  const chunks = await getAllByFilter<Chunk>(COLLECTIONS.chunk, { userId: env.DEFAULT_USER_ID });
  const chunksWithEmb: ChunkWithEmbedding[] = chunks.map((c) => ({
    id: c.id,
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
  });

  // 3. fetch docs for titles (denormalize: chunk has sourceId, doc has title)
  const docIds = Array.from(new Set(top.map((t) => chunksWithEmb.find((c) => c.id === t.chunkId)?.documentId).filter(Boolean) as string[]));
  const docs = await Promise.all(docIds.map((id) => getAllByFilter<Document>(COLLECTIONS.document, { _id: id }, 1).then((r) => r[0])));
  const docMap = new Map(docs.filter(Boolean).map((d) => [d!.id, d!]));

  // 4. build prompt
  const ctx = {
    chunks: top.slice(0, 5).map((t, i) => {
      const chunk = chunksWithEmb.find((c) => c.id === t.chunkId);
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

  // 5. MiniMax chat completion
  const res = await fetch(`${env.MINIMAX_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${env.MINIMAX_API_KEY}`,
    },
    body: JSON.stringify({
      model: "MiniMax-chat",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    return errorResponse("MINIMAX_FAILED", `MiniMax chat failed: ${res.status} ${body}`, 502);
  }

  const chatRes = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const rawAnswer = chatRes.choices?.[0]?.message?.content ?? "";

  // 6. parse citations
  const citedNums = parseCitationsJson(rawAnswer);
  const cleanAnswer = stripCitationsJson(rawAnswer);

  const citations: CitationOut[] = citedNums
    .map((n) => {
      const i = n - 1;
      if (i < 0 || i >= top.length) return null;
      const t = top[i];
      if (!t) return null;
      const chunk = chunksWithEmb.find((c) => c.id === t.chunkId);
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
    answer: cleanAnswer,
    citations,
    disclaimer: DISCLAIMER_TEXT,
  };
  return jsonResponse(response);
}