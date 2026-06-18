/**
 * api-chat handler（CP-6 Phase 5 完整实现）
 * POST /api-chat { q: "...", session_id?: string }
 *
 * JWT auth + multi-turn session + MiniMax chat with history
 */
import {
  errorResponse,
  getQuery,
  jsonResponse,
  optionsResponse,
  parseJsonBody,
  type HttpTriggerEvent,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";
import { verifyJwt } from "../lib/jwt.js";
import { createMiniMaxEmbedder } from "@unequal/shared/embedding";
import { searchChunks, type ChunkWithEmbedding } from "@unequal/shared/retrieval";
import { add, getById, whereQuery, COLLECTIONS } from "../lib/db.js";
import { newId } from "../lib/db.js";
import type { ChatSession, ChatMessage, Chunk, Document } from "@unequal/shared/types";

interface ChatRequest {
  q: string;
  session_id?: string;
}

interface ChatResponse {
  answer: string;
  /** CP-7-B 新增：answer 中实际引用的 N（去重保 first；可被调用方过滤越界） */
  citedNums: number[];
  citations: Array<{ n: number; title: string; snippet: string; trustLevel: number; chunkId: string }>;
  session_id: string;
  session_title: string | null;
  is_new_session: boolean;
}

const MAX_HISTORY = 10;  // 最多带 10 条历史消息（控制 token）

/**
 * CP-7-B 新增：从 LLM 答案中解析 `[N]` 内联引用标记。
 *
 * 行为：
 * - 正则 `/\[\d+\]/g` 提取所有 [数字]
 * - 去重（保 first 出现位置）
 * - 越界数字（n > topLength 或 n < 1 或 topLength=0）由 caller 决定如何映射到 citations subset
 *
 * 返回 { rawNums, citedNums }：
 * - rawNums: 解析出的所有数字（不去重；调试用）
 * - citedNums: 去重保 first 顺序（包含越界数字；调用方按需过滤）
 *
 * @param answer - LLM 答案文本
 * @param topLength - 检索 top-N 数量（unused；保留供 caller 决策）
 */
export function parseAnswerSegments(answer: string, topLength: number): { rawNums: number[]; citedNums: number[] } {
  void topLength; // 保留参数；不强制使用
  const matches = answer.match(/\[\d+\]/g) ?? [];
  const rawNums = matches.map((m) => parseInt(m.slice(1, -1), 10)).filter((n) => Number.isFinite(n));
  const seen = new Set<number>();
  const citedNums: number[] = [];
  for (const n of rawNums) {
    if (seen.has(n)) continue;
    seen.add(n);
    citedNums.push(n);
  }
  return { rawNums, citedNums };
}

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  // JWT auth（miniprogram 用户 scope = "user"）
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  let userId: string;
  try {
    const payload = await verifyJwt({ token, secret: env.JWT_SECRET });
    if (payload.scope !== "user" && payload.scope !== "admin") {
      return errorResponse("AUTH_FAILED", "Invalid scope", 403);
    }
    userId = payload.sub;
  } catch {
    return errorResponse("AUTH_FAILED", "Invalid JWT", 401);
  }

  const body = parseJsonBody<ChatRequest>(event);
  if (!body?.q) {
    return errorResponse("INVALID_REQUEST", "Missing 'q'", 400);
  }
  const q = body.q.trim();
  if (!q) {
    return errorResponse("INVALID_REQUEST", "Empty 'q'", 400);
  }
  const sessionId = body.session_id ?? getQuery(event, "session_id");

  // 1. 查找/创建 session
  let session: ChatSession | null = null;
  let isNewSession = false;
  if (sessionId) {
    const found = await getById<ChatSession>(COLLECTIONS.chatSession, sessionId);
    if (found && found.userId === userId) {
      session = found;
    }
  }
  if (!session) {
    session = {
      id: newId(),
      userId,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    isNewSession = true;
  }

  // 2. 检索 top-5 chunks
  const embed = createMiniMaxEmbedder({
    apiKey: env.MINIMAX_API_KEY,
    baseUrl: env.MINIMAX_BASE_URL,
    model: "embo-01",
  });
  const queryVec = (await embed.embed([q]))[0] ?? [];

  const chunks = await whereQuery<Chunk>(COLLECTIONS.chunk, { userId }, { limit: 500 });
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
    userId,
    queryVector: queryVec,
    topK: 5,
    scoreThreshold: 0.3,
  });

  // 3. 取 doc titles
  // chunk.documentId = upload 时 newId() 生成的 ULID（schema `id` 字段），不是 CloudBase `_id`
  // query 用 schema `id` 字段；docMap 用 `d.id` 作 key
  const docIds = Array.from(new Set(top.map((t) => chunksWithEmb.find((c) => c.id === t.chunkId)?.documentId).filter(Boolean) as string[]));
  const docs = await Promise.all(docIds.map((id) => whereQuery<Document>(COLLECTIONS.document, { id }, { limit: 1 }).then((r) => r[0])));
  const docMap = new Map(docs.filter(Boolean).map((d) => [d!.id, d!]));

  // 4. 拼 context
  const contextLines = top.slice(0, 5).map((t, i) => {
    const chunk = chunksWithEmb.find((c) => c.id === t.chunkId);
    const doc = chunk ? docMap.get(chunk.documentId) : undefined;
    return `[${i + 1}] 《${doc?.title ?? "?"}》 ${chunk?.content.slice(0, 200) ?? ""}`;
  }).join("\n");

  // 5. 拼 history messages（最近 MAX_HISTORY 条）
  const recentMessages = session.messages.slice(-MAX_HISTORY);
  const chatHistoryMsgs = recentMessages.flatMap((m) => [
    { role: m.role, content: m.content },
  ]);

  // 6. MiniMax chat completion（带 system + history + 当前 q）
  const systemPrompt = `你是"不等号"——一个育儿知识库助手。仅基于下方参考资料回答；引用用 [N] 格式；不要兜底常识。\n\n参考资料：\n${contextLines || "(无)"}`;

  const res = await fetch(`${env.MINIMAX_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${env.MINIMAX_API_KEY}`,
    },
    body: JSON.stringify({
      model: "MiniMax-Text-01",
      messages: [
        { role: "system", content: systemPrompt },
        ...chatHistoryMsgs,
        { role: "user", content: q },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    return errorResponse("MINIMAX_FAILED", `MiniMax chat failed: ${res.status} ${body}`, 502);
  }

  const chatRes = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const answer = chatRes.choices?.[0]?.message?.content ?? "(无回答)";

  // 7. 持久化 messages
  const now = Date.now();
  const newMessages: ChatMessage[] = [
    ...session.messages,
    { role: "user", content: q, createdAt: now },
    { role: "assistant", content: answer, createdAt: now },
  ];

  // 自动标题（首次 user 消息前 30 字）
  const title = session.title ?? q.slice(0, 30);

  if (isNewSession) {
    await add<ChatSession>(COLLECTIONS.chatSession, {
      ...session,
      title,
      messages: newMessages,
      updatedAt: now,
    });
  } else {
    const { update } = await import("../lib/db.js");
    await update(COLLECTIONS.chatSession, session.id, {
      title,
      messages: newMessages,
      updatedAt: now,
    });
  }

  // 8. CP-7-B [N] 解析：citedNums + citations subset
  const topChunks = top.slice(0, 5);
  const { citedNums } = parseAnswerSegments(answer, topChunks.length);
  // 过滤越界（保 citedNums 顺序）
  const validCitedNums = citedNums.filter((n) => n >= 1 && n <= topChunks.length);
  // 按 citedNums 顺序映射 topChunks（不按数字重排；caller 阅读顺序）
  const citations = validCitedNums
    .map((n) => {
      const idx = n - 1;
      const t = topChunks[idx];
      if (!t) return null;
      const chunk = chunksWithEmb.find((c) => c.id === t.chunkId);
      const doc = chunk ? docMap.get(chunk.documentId) : undefined;
      return {
        n,
        title: doc?.title ?? "?",
        snippet: chunk?.content.slice(0, 200) ?? "",
        trustLevel: t.trustLevel,
        chunkId: t.chunkId,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const response: ChatResponse = {
    answer,
    citedNums, // 包含越界数字（debug 用）；前端显示按需过滤
    citations, // 仅 valid subset
    session_id: session.id,
    session_title: title,
    is_new_session: isNewSession,
  };
  return jsonResponse(response);
}