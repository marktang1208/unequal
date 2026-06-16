/**
 * api-ingest handler（CP-6 Phase 4 完整实现）
 * POST /api-ingest { source_id?: string, content: string, title?: string, url?: string, trust_level?: number }
 *
 * admin auth + content ingestion（无文件存储）— crawler CLI 调此
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
import { verifyJwt } from "../lib/jwt.js";
import { createMiniMaxEmbedder } from "@unequal/shared/embedding";
import { chunkText } from "@unequal/shared/chunking";
import { COLLECTIONS, type CollectionName } from "../lib/collections.js";
import { add } from "../lib/db.js";
import type { Source, Document, Chunk } from "@unequal/shared/types";

interface IngestRequest {
  source_id?: string;
  content: string;
  title?: string;
  url?: string;
  trust_level?: 0 | 1 | 2 | 3;
}

async function verifyAdmin(token: string, env: ReturnType<typeof getEnv>): Promise<boolean> {
  if (token === env.ADMIN_TOKEN) return true;
  try {
    const payload = await verifyJwt({ token, secret: env.JWT_SECRET });
    return payload.scope === "admin";
  } catch {
    return false;
  }
}

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!await verifyAdmin(token, env)) {
    return errorResponse("AUTH_FAILED", "Not admin", 401);
  }

  const body = parseJsonBody<IngestRequest>(event);
  if (!body?.content || typeof body.content !== "string") {
    return errorResponse("INVALID_REQUEST", "Missing 'content' field", 400);
  }

  const trustLevel = body.trust_level ?? 0;

  // 1. source
  let sourceId = body.source_id;
  if (!sourceId) {
    const newSource: Source = {
      id: "",
      userId: env.DEFAULT_USER_ID,
      type: "webpage",
      title: body.title,
      url: body.url,
      trustLevel,
      createdAt: Date.now(),
    };
    sourceId = await add<Source>(COLLECTIONS.source, newSource) ?? "";
  }
  if (!sourceId) {
    return errorResponse("INTERNAL_ERROR", "source create failed", 500);
  }

  // 2. document（无 raw_path；parsed_text 留云存储）
  const docId = await add<Document>(COLLECTIONS.document, {
    id: "",
    sourceId,
    userId: env.DEFAULT_USER_ID,
    title: body.title ?? body.url,
    rawPath: "",
    previewSnippet: body.content.slice(0, 200),
    createdAt: Date.now(),
  } as Document);

  // 3. chunk
  const chunks = chunkText(body.content, { maxTokens: 500, overlapTokens: 80 });

  // 4. embed + insert
  const embed = createMiniMaxEmbedder({
    apiKey: env.MINIMAX_API_KEY,
    baseUrl: env.MINIMAX_BASE_URL,
    model: "MiniMax-embeddings",
  });

  const texts = chunks.map((c) => c.content);
  let embeddings: number[][] = [];
  try {
    embeddings = await embed.embed(texts);
  } catch (err) {
    return errorResponse(
      "EMBEDDING_FAILED",
      `MiniMax embedding failed: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }

  let inserted = 0;
  const errors: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const chunk: Chunk = {
        id: "",
        documentId: docId,
        sourceId,
        userId: env.DEFAULT_USER_ID,
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

  return jsonResponse({
    source_id: sourceId,
    document_id: docId,
    chunks_inserted: inserted,
    chunks_failed: chunks.length - inserted,
    errors: errors.length > 0 ? errors : undefined,
  });
}