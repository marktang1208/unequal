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
// CP-7-D #2: 走 factory（不再 import createMiniMaxEmbedder）
import { getEmbedder, getChatProvider } from "../lib/llm-provider.js";
import { searchChunks, type ChunkWithEmbedding } from "@unequal/shared/retrieval";
import { add, getById, whereQuery, COLLECTIONS } from "../lib/db.js";
import { newId } from "../lib/db.js";
import type { ChatSession, ChatMessage, Chunk, Document } from "@unequal/shared/types";

interface ChatRequest {
  q: string;
  session_id?: string;
  /** M7-B: 限定 sourceType 列表 */
  sourceTypes?: string[];
  /** M7-B: 排除 sourceId 列表 */
  excludeSourceIds?: string[];
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
/**
 * 解析 LLM 答案中的 [N] 引用标记。
 * - rawNums: 解析出的所有数字（不去重；调试用）
 * - citedNums: 去重保 first 顺序（包含越界数字；调用方按需过滤）
 * - cleaned: 去掉 [N] 标记后的答案文本（P5 NLI 用作 premise）
 *
 * @param answer - LLM 答案文本
 * @param topLength - 检索 top-N 数量（unused；保留供 caller 决策）
 */
export function parseAnswerSegments(answer: string, topLength: number): { rawNums: number[]; citedNums: number[]; cleaned: string } {
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
  // 去掉 [N] 标记（如 "[1] 发烧..." → "发烧..."）
  const cleaned = answer.replace(/\[\d+\]/g, "").trim();
  return { rawNums, citedNums, cleaned };
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
  // M7-B: source 过滤（可选）
  const sourceTypes = body.sourceTypes && body.sourceTypes.length > 0 ? body.sourceTypes : undefined;
  const excludeSourceIds = body.excludeSourceIds && body.excludeSourceIds.length > 0 ? body.excludeSourceIds : undefined;
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
  // CP-7-D #2: 走 factory
  const embed = getEmbedder();
  const queryVec = (await embed.embed([q]))[0] ?? [];

  // CloudBase 单次回包 1MB 上限；chunk 平均 87KB → limit=8 安全；暴力 cosine 在 production 1963 chunks 下不 work — v2 上向量 DB
  const chunks = await whereQuery<Chunk>(COLLECTIONS.chunk, { userId }, { limit: 8 });
  if (chunks.length === 8) {
    // eslint-disable-next-line no-console
    console.warn(`[api-chat] chunk retrieval hit 8 limit; user ${userId} has more chunks (production 1963) - retrieval 准确度受限; v2 需上向量 DB`);
  }
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
    ...(sourceTypes ? { sourceTypes } : {}),
    ...(excludeSourceIds ? { excludeSourceIds } : {}),
  });

  // 3. 取 doc titles
  // CP-7-B round 9 bugfix：searchChunks 返的 chunkId 是 `_id ?? id`（retrieval.ts:88）
  // 这里 find 时也用 `_id ?? id` 对齐，避免 chunk.id="" 时永远 find 不到
  const findChunk = (chunkId: string) =>
    chunksWithEmb.find((c) => (c._id ?? c.id) === chunkId);
  const docIds = Array.from(new Set(top.map((t) => findChunk(t.chunkId)?.documentId).filter(Boolean) as string[]));
  // chunk.documentId = ingest 时 add() 生成的 CloudBase `_id`（add 返 _id 当 documentId 存）
  // 用 getById 查（按 _id），不是 whereQuery({id})
  const docs = await Promise.all(docIds.map((id) => getById<Document>(COLLECTIONS.document, id)));
  // docMap 用 _id 作 key（与 chunk.documentId 对齐）
  const docMap = new Map(docs.filter(Boolean).map((d) => [d!._id, d!]));

  // 4. 拼 context
  const contextLines = top.slice(0, 5).map((t, i) => {
    const chunk = findChunk(t.chunkId);
    const doc = chunk ? docMap.get(chunk.documentId) : undefined;
    return `[${i + 1}] 《${doc?.title ?? "?"}》 ${chunk?.content.slice(0, 200) ?? ""}`;
  }).join("\n");

  // 5. 拼 history messages（最近 MAX_HISTORY 条）
  const recentMessages = session.messages.slice(-MAX_HISTORY);
  const chatHistoryMsgs = recentMessages.flatMap((m) => [
    { role: m.role, content: m.content },
  ]);

  // 6. LLM chat completion（带 system + history + 当前 q）
  // CP-7-D #2: 走 factory；错误包成 502 保持对外兼容
  // CP-7-B bugfix：原 prompt "引用用 [N] 格式" 被 LLM 误解为字面字符串 [N]。
  // 改为明确说明 N 是 1-5 的具体数字，并给出示例，避免 LLM 抄字面占位符。
  const systemPrompt = `你是"不等号"——一个育儿知识库助手。

# 回答规则
1. **仅基于下方参考资料**回答，不要兜底常识。
2. **引用格式**：在引用某条资料时，紧跟句尾标注 \`[1]\` \`[2]\` \`[3]\` \`[4]\` \`[5]\`（具体数字对应资料编号），**不要写字面的 [N]**。
   - 正确示例："新生儿每日睡眠 14-17 小时[1]，可以尝试规律作息[2]。"
   - 错误示例："新生儿每日睡眠 14-17 小时[N]。"  ← 禁止
3. 如果资料里没有相关信息，直接说"参考资料中未涉及此问题"，不要编造。

# 参考资料
${contextLines || "(无)"}`;

  let answer: string;
  try {
    const result = await getChatProvider().chat({
      messages: [
        { role: "system", content: systemPrompt },
        ...chatHistoryMsgs,
        { role: "user", content: q },
      ],
      temperature: 0.3,
    });
    answer = result.content || "(无回答)";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse("MINIMAX_FAILED", `LLM chat failed: ${message}`, 502);
  }

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
      const chunk = findChunk(t.chunkId);
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