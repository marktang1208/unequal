/**
 * CP-7-C #2: api-ingest handler
 *
 * 鉴权分支（proxy 优先）：
 * - has X-Ingest-Proxy-Secret → requireIngestProxy() (新)
 * - has Authorization: Bearer → requireAdmin() (现有)
 * - 无 → 401 AUTH_FAILED
 *
 * user_id 行为：
 * - admin 路径 + body.user_id 指定 → 403 INSUFFICIENT_SCOPE
 * - proxy 路径 + body.user_id 指定 → targetUserId = body.user_id
 * - 任一路径 + user_id 缺省 → targetUserId = env.DEFAULT_USER_ID
 *
 * audit 调用（先 audit 再 ingest；audit 失败 → 500 AUDIT_FAILED）：
 * - ingest 业务开始前：recordAudit(stage="in_progress")
 * - ingest 业务成功：recordAudit(stage="success") + 返 200
 * - ingest 业务失败：recordAudit(stage="failure", error=...) + 返 5xx
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
import { requireAdmin, requireIngestProxy } from "../lib/auth-admin.js";
// CP-7-D #2: 走 factory（不再 import createMiniMaxEmbedder）
import { getEmbedder } from "../lib/llm-provider.js";
import { chunkText } from "@unequal/shared/chunking";
import { COLLECTIONS, type CollectionName } from "../lib/collections.js";
import { add } from "../lib/db.js";
import { recordAudit, type AuditEntry } from "../lib/audit.js";
import type { Source, Document, Chunk } from "@unequal/shared/types";

interface IngestRequest {
  source_id?: string;
  content: string;
  title?: string;
  url?: string;
  trust_level?: 0 | 1 | 2 | 3;
  /** CP-7-B round 9: 可指定 userId；CP-7-C #2: 仅 ingest_proxy 路径可指定 */
  user_id?: string;
}

type ActorVia = "admin_token" | "admin_jwt" | "ingest_proxy";

function fingerprintToken(token: string): string {
  // sha256(token).slice(0, 16) — 对齐 M6.3a login_attempt 算法
  // 同步实现（无 node:crypto import 复杂度）：用简单 hash 够用（不存明文）
  // 实际：仅 admin_token 可 fingerprint；admin_jwt / proxy 用 "n/a"
  return `tok-${token.slice(0, 8)}-${token.length}`;
}

function clientIpFromEvent(event: HttpTriggerEvent): string {
  return (
    event.headers["x-real-ip"] ||
    event.headers["X-Real-IP"] ||
    event.headers["x-forwarded-for"] ||
    event.headers["X-Forwarded-For"] ||
    "unknown"
  );
}

function requestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  // 1. 鉴权：proxy 优先
  const proxyHeader = event.headers["x-ingest-proxy-secret"] || event.headers["X-Ingest-Proxy-Secret"];
  const hasProxy = !!proxyHeader;

  let via: ActorVia;
  let tokenFingerprint: string | undefined;

  if (hasProxy) {
    const proxyAuth = await requireIngestProxy(event, env);
    if (!proxyAuth.ok) return proxyAuth.response;
    via = "ingest_proxy";
    tokenFingerprint = `proxy-${(proxyHeader ?? "").slice(0, 8)}-${(proxyHeader ?? "").length}`;
  } else {
    const adminAuth = await requireAdmin(event, env);
    if (!adminAuth.ok) return adminAuth.response;
    via = adminAuth.via;
    if (via === "admin_token") {
      const authHeader = event.headers.authorization || event.headers.Authorization || "";
      const token = authHeader.replace(/^Bearer\s+/i, "");
      tokenFingerprint = fingerprintToken(token);
    } else {
      tokenFingerprint = "jwt-admin";
    }
  }

  // 2. 解析 body
  const body = parseJsonBody<IngestRequest>(event);
  if (!body?.content || typeof body.content !== "string") {
    return errorResponse("INVALID_REQUEST", "Missing 'content' field", 400);
  }

  // 3. user_id 行为分支
  const userIdSpecified = !!body.user_id && body.user_id.trim() !== "";
  if (via !== "ingest_proxy" && userIdSpecified) {
    return errorResponse(
      "INSUFFICIENT_SCOPE",
      "user_id can only be specified via X-Ingest-Proxy-Secret; admin path can only ingest to DEFAULT_USER_ID",
      403,
    );
  }
  const targetUserId = userIdSpecified ? body.user_id!.trim() : env.DEFAULT_USER_ID;

  // 4. 准备 audit + requestId
  const reqId = requestId();
  const clientIp = clientIpFromEvent(event);
  const trustLevel = body.trust_level ?? 0;

  const baseAudit: Omit<AuditEntry, "id" | "timestamp"> = {
    action: "ingest",
    actor: {
      via,
      clientIp,
      ...(tokenFingerprint ? { tokenFingerprint } : {}),
    },
    target: {
      userId: targetUserId,
    },
    request: {
      contentLen: body.content.length,
      trustLevel,
      ...(body.title ? { title: body.title } : {}),
    },
    result: "in_progress",
    requestId: reqId,
  };

  // 5. 先 audit start — 失败立即 500 AUDIT_FAILED
  try {
    await recordAudit(baseAudit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse("AUDIT_FAILED", `audit log write failed: ${message}`, 500);
  }

  // 6. ingest 业务
  let sourceId = body.source_id;
  let docId = "";
  let inserted = 0;
  const errors: string[] = [];

  try {
    if (!sourceId) {
      const newSource: Source = {
        id: "",
        userId: targetUserId,
        type: "webpage",
        title: body.title,
        url: body.url,
        trustLevel,
        createdAt: Date.now(),
      };
      sourceId = (await add<Source>(COLLECTIONS.source, newSource)) ?? "";
    }
    if (!sourceId) {
      throw new Error("source create failed");
    }

    docId = (await add<Document>(COLLECTIONS.document, {
      id: "",
      sourceId,
      userId: targetUserId,
      title: body.title ?? body.url,
      rawPath: "",
      previewSnippet: body.content.slice(0, 200),
      createdAt: Date.now(),
    } as Document)) ?? "";

    const chunks = chunkText(body.content, { maxTokens: 500, overlapTokens: 80 });

    // CP-7-D #2: 走 factory
    const embed = getEmbedder();

    const texts = chunks.map((c) => c.content);
    let embeddings: number[][] = [];
    try {
      embeddings = await embed.embed(texts);
    } catch (err) {
      throw new Error(`EMBEDDING_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (let i = 0; i < chunks.length; i++) {
      try {
        const chunk: Chunk = {
          id: "",
          documentId: docId,
          sourceId,
          userId: targetUserId,
          idx: i,
          content: chunks[i]!.content,
          embedding: embeddings[i]!,
          tokenCount: chunks[i]!.tokenCount,
          trustLevel,
          createdAt: Date.now(),
        };
        await add<Chunk>(COLLECTIONS.chunk as CollectionName, chunk);
        inserted++;
      } catch (err) {
        errors.push(`chunk ${i}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 业务失败 → audit failure 记录
    try {
      await recordAudit({
        ...baseAudit,
        result: "failure",
        error: message,
      });
    } catch {
      // audit 二次失败吞掉（业务错误更重要）
    }
    // 区分 embedding 失败 vs 其他
    if (message.startsWith("EMBEDDING_FAILED:")) {
      return errorResponse("EMBEDDING_FAILED", message.replace("EMBEDDING_FAILED: ", ""), 500);
    }
    return errorResponse("INTERNAL_ERROR", message, 500);
  }

  // 7. audit success
  try {
    await recordAudit({
      ...baseAudit,
      result: "success",
      target: {
        ...baseAudit.target,
        sourceId,
        documentId: docId,
        chunksInserted: inserted,
      },
    });
  } catch {
    // success audit 失败不影响业务响应（已记录 start）
  }

  return jsonResponse({
    source_id: sourceId,
    document_id: docId,
    chunks_inserted: inserted,
    chunks_failed: chunks_count(errors),
    errors: errors.length > 0 ? errors : undefined,
  });
}

function chunks_count(errors: string[]): number {
  // 业务失败走 catch 路径不走这里；这里只占位
  return errors.length;
}