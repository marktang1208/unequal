/**
 * api-upload handler（CP-6 Phase 4 完整实现）
 * POST /api-upload { filename, content_base64, trust_level? }
 *
 * admin auth + 文件解析（PDF/Word/TXT/MD）+ chunk + embed + DB writes + 云存储原文件
 *
 * 限制（spec §6.7）：
 * - HTTP trigger body 4MB → 单文件 < 3MB 安全（base64 编码后 ~4MB）
 * - 超大文件留 v2 用 presigned URL 直传云存储
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
import { chunkText } from "@unequal/shared/chunking";
import { COLLECTIONS, type CollectionName } from "../lib/collections.js";
import { add, newId } from "../lib/db.js";
import { parsedTextPath, rawFilePath, uploadFile, uploadText } from "../lib/storage.js";
import { detectExt, parseAuto } from "../lib/parsers.js";
import type { Source, Document, Chunk } from "@unequal/shared/types";

interface UploadRequest {
  filename: string;
  content_base64: string;
  title?: string;
  trust_level?: 0 | 1 | 2 | 3;
}

export async function main(event: HttpTriggerEvent): Promise<HttpTriggerResponse> {
  const env = getEnv();
  if (event.httpMethod === "OPTIONS") return optionsResponse(env.ALLOWED_ORIGIN);

  const auth = await requireAdmin(event, env);
  if (!auth.ok) return auth.response;

  const body = parseJsonBody<UploadRequest>(event);
  if (!body?.filename || !body.content_base64) {
    return errorResponse("INVALID_REQUEST", "Missing 'filename' or 'content_base64'", 400);
  }

  const ext = detectExt(body.filename);
  if (!ext) {
    return errorResponse("UNSUPPORTED_FILE", `Unsupported: ${body.filename}`, 400);
  }

  let fileBuf: Buffer;
  try {
    fileBuf = Buffer.from(body.content_base64, "base64");
  } catch {
    return errorResponse("INVALID_BASE64", "Invalid base64 content", 400);
  }

  if (fileBuf.length > 4 * 1024 * 1024) {
    return errorResponse("FILE_TOO_LARGE", "File > 4MB (Phase 4 limit)", 413);
  }

  // 1. 解析文件
  let parsedText: string;
  try {
    parsedText = await parseAuto(body.filename, fileBuf);
  } catch (err) {
    return errorResponse(
      "PARSE_FAILED",
      `Parse ${body.filename} failed: ${err instanceof Error ? err.message : String(err)}`,
      400,
    );
  }

  if (!parsedText.trim()) {
    return errorResponse("EMPTY_CONTENT", "Parsed text is empty", 400);
  }

  const trustLevel = body.trust_level ?? 0;
  const docId = newId();

  // 2. 上传原文件 + parsed text 到云存储
  try {
    await uploadFile(rawFilePath(env.DEFAULT_USER_ID, docId, ext), fileBuf);
    await uploadText(parsedTextPath(env.DEFAULT_USER_ID, docId), parsedText);
  } catch (err) {
    return errorResponse(
      "STORAGE_FAILED",
      `Storage upload failed: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }

  // 3. source
  const sourceId = await add<Source>(COLLECTIONS.source, {
    id: "",
    userId: env.DEFAULT_USER_ID,
    type: "file",
    title: body.title ?? body.filename,
    trustLevel,
    createdAt: Date.now(),
    meta: { filename: body.filename, ext },
  } as Source);

  // 4. document
  await add<Document>(COLLECTIONS.document, {
    id: docId,
    sourceId,
    userId: env.DEFAULT_USER_ID,
    title: body.title ?? body.filename,
    rawPath: rawFilePath(env.DEFAULT_USER_ID, docId, ext),
    parsedTextPath: parsedTextPath(env.DEFAULT_USER_ID, docId),
    previewSnippet: parsedText.slice(0, 200),
    createdAt: Date.now(),
  } as Document);

  // 5. chunk + embed
  const chunks = chunkText(parsedText, { maxTokens: 500, overlapTokens: 80 });
  const texts = chunks.map((c) => c.content);

  const embed = createMiniMaxEmbedder({
    apiKey: env.MINIMAX_API_KEY,
    baseUrl: env.MINIMAX_BASE_URL,
    model: "embo-01",
  });

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

  // 6. insert chunks（独立 try/catch，spec §6.6）
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
      const newId = await add<Chunk>(COLLECTIONS.chunk as CollectionName, chunk);
      chunk.id = newId;
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