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
  getClientIp,
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
import { whereQuery } from "../lib/db.js";
import { parseAnswerSegments } from "./api-chat.js";
import type { Chunk, Document } from "@unequal/shared/types";
// P5 NLI 后置验证（spec §3.1 step 9-11）
import { getProvider as getNliProvider, recordNliFailure, recordNliSuccess } from "../lib/nli/get-provider.js";
import { applyWarning } from "../lib/nli/apply-warning.js";
import { NliRuntimeError, NliTimeoutError } from "../lib/nli/errors.js";
import type { NliVerdict } from "../lib/nli/types.js";
// P5 NLI: audit 写入
import { recordAudit } from "../lib/audit.js";
import { createHash } from "node:crypto";

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

  const clientIp = getClientIp(event);

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
  // CloudBase 单次回包 1MB 上限；limit=500 与 api-chat 一致（state-ask-search-retrieval.md §3）。
  // chunk 平均 10KB（含 1536 浮点 embedding），500 chunks ≈ 5MB 上界；暴力 cosine 排序后取 topK=5 安全。
  // 若用户实际 > 500 chunks，warn log 提示 v2 需分页（spec §6）。
  const chunks = await whereQuery<Chunk>(COLLECTIONS.chunk, { userId: env.DEFAULT_USER_ID }, { limit: 500 });
  if (chunks.length === 500) {
    // eslint-disable-next-line no-console
    console.warn(`[api-ask] chunk retrieval hit 500 limit; user ${env.DEFAULT_USER_ID} may have more (v2 待分页)`);
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
  const docs = await Promise.all(docIds.map((id) => whereQuery<Document>(COLLECTIONS.document, { id }, { limit: 1 }).then((r) => r[0])));
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
  const { citedNums, cleaned } = parseAnswerSegments(answer, topChunks.length);
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

  // 7. P5 NLI 后置验证：LLM 答案是否被 retrieved chunks 蕴含
  const nliHypothesis = topChunks
    .map((t) => findChunk(t.chunkId)?.content ?? "")
    .filter((s) => s.length > 0)
    .join("\n\n");
  const nliStart = Date.now();
  let verdict: NliVerdict;
  let nliErrorReason: "rejected" | "timeout" | "runtime_error" = "rejected";
  let nliSucceeded = true;
  try {
    const provider = await getNliProvider();
    verdict = await provider.verify(cleaned, nliHypothesis);
    recordNliSuccess();
  } catch (err) {
    // 降级：runtime 错 / timeout → NoopNliProvider 风格 verdict (entailed)，不阻塞 ask
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

  // 仅 reject 时写 audit（pass 不写减少噪声，spec §3.1 step 10）
  if (nliSucceeded && verdict.verdict !== "entailed") {
    const queryHash = createHash("sha256").update(q).digest("hex").slice(0, 16);
    const chunksHash = createHash("sha256")
      .update(topChunks.map((t) => t.chunkId).join(","))
      .digest("hex")
      .slice(0, 16);
    try {
      await recordAudit({
        action: "ask_nli_reject",
        actor: { via: "admin_token", userId: env.DEFAULT_USER_ID, clientIp },
        target: { userId: env.DEFAULT_USER_ID, resourceType: "chunk" },
        request: { contentLen: q.length, trustLevel: 0, title: q.slice(0, 100) },
        result: "success",
        requestId: `ask_nli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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
      // 审计失败不阻塞响应（spec §7 fail-open）
      // eslint-disable-next-line no-console
      console.warn(`[audit] ask_nli_reject write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
    }
  } else if (!nliSucceeded) {
    // runtime 错 / timeout 写 audit（spec §7 类别 B）
    const queryHash = createHash("sha256").update(q).digest("hex").slice(0, 16);
    const chunksHash = createHash("sha256")
      .update(topChunks.map((t) => t.chunkId).join(","))
      .digest("hex")
      .slice(0, 16);
    try {
      await recordAudit({
        action: "ask_nli_reject",
        actor: { via: "admin_token", userId: env.DEFAULT_USER_ID, clientIp },
        target: { userId: env.DEFAULT_USER_ID, resourceType: "chunk" },
        request: { contentLen: q.length, trustLevel: 0, title: q.slice(0, 100) },
        result: "failure",
        error: `nli_${nliErrorReason}`,
        requestId: `ask_nli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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
      console.warn(`[audit] ask_nli_reject (failure) write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
    }
  }

  // 8. P5 NLI: 应用 warning prefix（spec §3.1 step 11）
  // answer 字段保留原文 [N]（用户端体验完整）；warning prefix 拼接到原文前（不破坏 [N] 引用）
  // P5 commit ea0ad8f 误用 cleaned 作 finalAnswer，导致 D-2-a 测试期望含 [1] 失败 — 一起修
  const finalAnswer = nliSucceeded ? applyWarning(answer, verdict) : answer;

  const response: AskResponse = {
    answer: finalAnswer,
    citations,
    disclaimer: DISCLAIMER_TEXT,
  };
  return jsonResponse(response);
}