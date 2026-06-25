/**
 * api-chat handler（CP-6 Phase 5 完整实现）
 * POST /api-chat { q: "...", session_id?: string }
 *
 * JWT auth + multi-turn session + MiniMax chat with history
 */
import {
  errorResponse,
  getClientIp,
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
// P8: pgvector retrieval (HNSW 索引 topK*10=50 candidates, failOpen → nosql 暴力 cosine)
import { getPgVectorStore } from "../lib/retrieval/pg-vector-store.js";
// P5 v1.3 NLI 后置验证(同 ask v1.1.1 + v1.2 套路)
// P5 v1.4 跨轮 NLI helper (union 当前 + 历史 retrievedChunkIds, cap 5)
import { getProvider as getNliProvider, recordNliFailure, recordNliSuccess } from "../lib/nli/get-provider.js";
import { applyWarning } from "../lib/nli/apply-warning.js";
import { shouldSkipNli, getNliMinAnswerLen } from "../lib/nli/should-skip-nli.js";
import { getCrossTurnHypothesis } from "../lib/nli/cross-turn-hypothesis.js";
import { NliRuntimeError, NliTimeoutError } from "../lib/nli/errors.js";
import type { NliVerdict } from "../lib/nli/types.js";
// P5 v1.3 NLI: audit 写入
import { recordAudit } from "../lib/audit.js";
import { createHash } from "node:crypto";

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
  /** P9: NLI async turnId, 客户端拿此轮询 GET /api-nli-result; sync 路径 (env.NLI_ASYNC != "1") 返 undefined */
  nliTurnId?: string;
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
  // P8: VECTOR_STORE=pg → PG vector store (topK*10=50 candidates + scoreThreshold 推到 SQL); nosql → 暴力 cosine (P7 行为)
  let chunksWithEmb: ChunkWithEmbedding[];
  if (env.VECTOR_STORE === "pg") {
    try {
      const pgStore = await getPgVectorStore();
      const cands = await pgStore.queryTopK({
        userId,
        queryVector: queryVec,
        topK: 5,
        scoreThreshold: 0.3,
        ...(sourceTypes ? { sourceTypes } : {}),
        ...(excludeSourceIds ? { excludeSourceIds } : {}),
      });
      chunksWithEmb = cands.map((c) => ({
        id: (c as any).id ?? "",
        _id: (c as any).id,
        documentId: c.documentId,
        sourceId: c.sourceId,
        userId: c.userId,
        idx: c.idx,
        content: c.content,
        embedding: c.embedding,
        tokenCount: 0,
        trustLevel: c.trustLevel,
        createdAt: c.createdAt,
      }));
    } catch (err) {
      // failOpen: PG 失败 → 落回暴力 cosine (跟 P7 行为一致)
      // eslint-disable-next-line no-console
      console.warn(`[api-chat] PG retrieval failOpen: ${err instanceof Error ? err.message : String(err)}`);
      const chunks = await whereQuery<Chunk>(COLLECTIONS.chunk, { userId }, { limit: 8 });
      if (chunks.length === 8) {
        // eslint-disable-next-line no-console
        console.warn(`[api-chat] chunk retrieval hit 8 limit; user ${userId} has more chunks (production 1963) - retrieval 准确度受限; v2 需上向量 DB`);
      }
      chunksWithEmb = chunks.map((c) => ({
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
    }
  } else {
    // VECTOR_STORE=nosql (P7 现状)
    const chunks = await whereQuery<Chunk>(COLLECTIONS.chunk, { userId }, { limit: 8 });
    if (chunks.length === 8) {
      // eslint-disable-next-line no-console
      console.warn(`[api-chat] chunk retrieval hit 8 limit; user ${userId} has more chunks (production 1963) - retrieval 准确度受限; v2 需上向量 DB`);
    }
    chunksWithEmb = chunks.map((c) => ({
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
  }

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

  // 7. CP-7-B [N] 解析：citedNums + cleaned + citations subset
  const topChunks = top.slice(0, 5);
  const { citedNums, cleaned } = parseAnswerSegments(answer, topChunks.length);
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

  // 8. P5 v1.3 NLI 后置验证（spec §2.2 / 复用 v1.1.1 + v1.2）
  // 短答案(< NLI_MIN_ANSWER_LEN=100)跳过 NLI,无空间塞幻觉
  // P5 v1.4: NLI hypothesis 跨轮 union (当前 top-5 + session 历史 retrievedChunkIds, cap 5)
  // P9: NLI_ASYNC="1" 灰度 — 跳过 sync NLI 块, setImmediate 后台 fire-and-forget 写 audit_log chat_nli_async
  //     客户端拿 nliTurnId 轮询 GET /api-nli-result; sync 路径 (NLI_ASYNC != "1") 行为不变 (P5 v1.3 backward compat)
  const clientIp = getClientIp(event);
  const nliMinLen = getNliMinAnswerLen();
  let finalAnswer = answer;  // 默认原 answer(NLI pass / fail-open / skip)
  let nliTurnId: string | undefined;  // P9: async 路径下生成, sync 路径 undefined

  if (env.NLI_ASYNC === "1") {
    // P9: 灰度分支 — 跳过同步 NLI 块 (warning prefix 移到轮询 verdict), setImmediate 后台 fire-and-forget
    // turnSeq 计数: 当前 session 中已有的 assistant message 数 (新建 session 为 0)
    const turnSeq = session.messages.filter((m) => m.role === "assistant").length;
    const turnId = `${session.id}:${turnSeq}`;
    nliTurnId = turnId;
    // 跨轮 hypothesis 跟 sync 路径共用 (P5 v1.4 跨轮 union)
    const crossTurn = getCrossTurnHypothesis({
      currentChunkIds: topChunks.map((t) => t.chunkId),
      sessionMessages: session.messages,
      findChunkById: (chunkId) => findChunk(chunkId)?.content ?? null,
    });
    const nliHypothesis = crossTurn.hypothesis;
    const nliStart = Date.now();
    const skipNli = shouldSkipNli(cleaned, nliMinLen);
    // setImmediate: 立即 defer 到 event loop 下一 tick, 不 await, 立即返回 chat response
    setImmediate(() => {
      // 内部 async 异常必须 catch, 避免 unhandled rejection (CloudBase 会 log noise)
      (async () => {
        try {
          if (skipNli) {
            // 短答案跳过 verify, 不写 audit (跟 sync 路径行为一致)
            // eslint-disable-next-line no-console
            console.log(`[nli-async] skipped: answer too short (${cleaned.length} < ${nliMinLen})`);
            return;
          }
          const provider = await getNliProvider();
          const verdict = await provider.verify(cleaned, nliHypothesis);
          recordNliSuccess();
          try {
            await recordAudit({
              action: "chat_nli_async",
              actor: { via: "jwt", userId, clientIp, sessionId: session.id },
              target: { userId, resourceType: "chunk" },
              request: { contentLen: q.length, trustLevel: 0, title: q.slice(0, 100) },
              result: "success",
              requestId: `chat_nli_async_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              nliSnapshot: {
                turnId,
                verdict: verdict.verdict,
                score: verdict.score,
                latencyMs: Date.now() - nliStart,
                reason: "async",
              },
            });
          } catch (auditErr) {
            // 审计失败不抛 (P5 v1.3 fail-open 风格)
            // eslint-disable-next-line no-console
            console.warn(`[audit] chat_nli_async write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
          }
        } catch (err) {
          // verify 抛错 (runtime_error / timeout) → 写 audit failure, 不抛 (async 路径不阻塞 chat)
          recordNliFailure(err instanceof Error ? err : new Error(String(err)));
          const reason = err instanceof NliTimeoutError ? "timeout" : "runtime_error";
          // eslint-disable-next-line no-console
          console.warn(`[nli-async] verify failed (${reason}): ${err instanceof Error ? err.message : String(err)}`);
          try {
            await recordAudit({
              action: "chat_nli_async",
              actor: { via: "jwt", userId, clientIp, sessionId: session.id },
              target: { userId, resourceType: "chunk" },
              request: { contentLen: q.length, trustLevel: 0, title: q.slice(0, 100) },
              result: "failure",
              error: err instanceof Error ? err.message : String(err),
              requestId: `chat_nli_async_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              nliSnapshot: {
                turnId,
                verdict: "neutral",
                score: 0,
                latencyMs: 0,
                reason,
              },
            });
          } catch (auditErr) {
            // eslint-disable-next-line no-console
            console.warn(`[audit] chat_nli_async (failure) write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
          }
        }
      })().catch((unexpected) => {
        // 兜底: setImmediate 内 async 任何未 catch 都吞 (P5 v1.3 fail-open)
        // eslint-disable-next-line no-console
        console.warn(`[nli-async] unexpected error: ${unexpected instanceof Error ? unexpected.message : String(unexpected)}`);
      });
    });
    // async 路径: finalAnswer 保持 answer (无 ⚠️, warning 移到轮询 verdict)
    // nliTurnId 已设, 持久化和响应会带上
  } else if (shouldSkipNli(cleaned, nliMinLen)) {
    // P5 v1.3 sync: 短答案 skip NLI 块
    // eslint-disable-next-line no-console
    console.log(`[nli] skipped: answer too short (${cleaned.length} < ${nliMinLen})`);
    // 跳过 NLI,继续走 session 持久化(用 raw answer)— 短问题用户刷新不丢历史
  } else {
    // P5 v1.4 跨轮 union: 当前 top-5 + 历史 retrievedChunkIds (cap 5, 去重当前)
    const crossTurn = getCrossTurnHypothesis({
      currentChunkIds: topChunks.map((t) => t.chunkId),
      sessionMessages: session.messages,
      findChunkById: (chunkId) => findChunk(chunkId)?.content ?? null,
    });
    const nliHypothesis = crossTurn.hypothesis;
    const nliStart = Date.now();
    let verdict: NliVerdict;
    let nliErrorReason: "rejected" | "timeout" | "runtime_error" = "rejected";
    let nliSucceeded = true;
    try {
      const provider = await getNliProvider();
      verdict = await provider.verify(cleaned, nliHypothesis);
      recordNliSuccess();
    } catch (err) {
      // 降级:runtime 错 / timeout → NoopNliProvider 风格 verdict (entailed),不阻塞 chat
      nliSucceeded = false;
      recordNliFailure(err instanceof Error ? err : new Error(String(err)));
      if (err instanceof NliTimeoutError) {
        nliErrorReason = "timeout";
      } else {
        nliErrorReason = "runtime_error";
      }
      // eslint-disable-next-line no-console
      console.warn(`[nli] verify failed (${nliErrorReason}): ${err instanceof Error ? err.message : String(err)}`);
      verdict = {
        verdict: "entailed",
        score: 1,
        scores: { entailment: 1, neutral: 0, contradiction: 0 },
        latencyMs: Date.now() - nliStart,
      };
    }

    // 仅 reject 时写 audit(pass 不写减少噪声,spec §3.1 step 10)
    if (nliSucceeded && verdict.verdict !== "entailed") {
      const queryHash = createHash("sha256").update(q).digest("hex").slice(0, 16);
      const chunksHash = createHash("sha256")
        .update(topChunks.map((t) => t.chunkId).join(","))
        .digest("hex")
        .slice(0, 16);
      try {
        await recordAudit({
          action: "chat_nli_reject",
          actor: { via: "jwt", userId, clientIp, sessionId: session.id },
          target: { userId, resourceType: "chunk" },
          request: { contentLen: q.length, trustLevel: 0, title: q.slice(0, 100) },
          result: "success",
          requestId: `chat_nli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          nliSnapshot: {
            queryHash,
            chunksHash,
            verdict: verdict.verdict,
            score: verdict.score,
            scores: verdict.scores,
            latencyMs: verdict.latencyMs,
            reason: "rejected",
          },
        });
      } catch (auditErr) {
        // 审计失败不阻塞响应(spec §7 fail-open)
        // eslint-disable-next-line no-console
        console.warn(`[audit] chat_nli_reject write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
      }
    } else if (!nliSucceeded) {
      // runtime 错 / timeout 写 audit(spec §7 类别 B)
      const queryHash = createHash("sha256").update(q).digest("hex").slice(0, 16);
      const chunksHash = createHash("sha256")
        .update(topChunks.map((t) => t.chunkId).join(","))
        .digest("hex")
        .slice(0, 16);
      try {
        await recordAudit({
          action: "chat_nli_reject",
          actor: { via: "jwt", userId, clientIp, sessionId: session.id },
          target: { userId, resourceType: "chunk" },
          request: { contentLen: q.length, trustLevel: 0, title: q.slice(0, 100) },
          result: "failure",
          error: `nli_${nliErrorReason}`,
          requestId: `chat_nli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          nliSnapshot: {
            queryHash,
            chunksHash,
            verdict: "neutral", // 失败时无法判断
            score: 0,
            scores: { entailment: 0, neutral: 0, contradiction: 0 },
            latencyMs: verdict.latencyMs,
            reason: nliErrorReason,
          },
        });
      } catch (auditErr) {
        // eslint-disable-next-line no-console
        console.warn(`[audit] chat_nli_reject (failure) write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
      }
    }

    // 应用 warning prefix(spec §3.1 step 11)— 答 案字段保留原文 [N];warning 拼接到原文前
    finalAnswer = nliSucceeded ? applyWarning(answer, verdict) : answer;
  }

  // 9. 持久化 messages(用 finalAnswer,可能含 ⚠️ prefix)— NLI 后一次性持久化,避免二次 update
  const now = Date.now();
  // P5 v1.4: 把当前轮 retrieve 的 top chunkIds 写进 assistant message
  // 下一轮 chat 时, getCrossTurnHypothesis 会 union 历史这些 chunkIds
  // P9: 异步 NLI 路径下, 加 nliTurnId 字段 (轮询 key, sync 路径 undefined 不写)
  const newMessages: ChatMessage[] = [
    ...session.messages,
    { role: "user", content: q, createdAt: now },
    {
      role: "assistant",
      content: finalAnswer,
      retrievedChunkIds: topChunks.map((t) => t.chunkId),
      ...(nliTurnId !== undefined ? { nliTurnId } : {}),
      createdAt: now,
    },
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

  const response: ChatResponse = {
    answer: finalAnswer,
    citedNums, // 包含越界数字（debug 用）；前端显示按需过滤
    citations, // 仅 valid subset
    session_id: session.id,
    session_title: title,
    is_new_session: isNewSession,
    ...(nliTurnId !== undefined ? { nliTurnId } : {}),  // P9: async 路径返, sync 路径 undefined
  };
  return jsonResponse(response);
}