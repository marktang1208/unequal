import { ulid } from "ulid";
import type { Env } from "../types.js";
import { verifyAdminToken } from "../lib/auth.js";
import { detectFileType, parseFile, type FileType } from "../lib/parsers/index.js";
import { chunkText } from "@unequal/shared/chunking";
import { createMiniMaxEmbedder } from "@unequal/shared/embedding";
import type { TrustLevel } from "@unequal/shared/types";

// MVP 阶段只有 1 个用户；与 seed-user 的默认 nickname 对齐
const DEFAULT_USER_ID = "default";

// 上传阶段把源/文档/chunk 一次性持久化的事务构造常量
const CHUNK_MAX_TOKENS = 400;
const CHUNK_OVERLAP_TOKENS = 50;

interface UploadResponse {
  sourceId: string;
  documentId: string;
  chunkCount: number;
  r2Key: string;
}

function isTrustLevel(value: unknown): value is TrustLevel {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function parseTrustLevel(raw: string | null): TrustLevel {
  if (raw === null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || !isTrustLevel(n)) {
    throw new Error(`Invalid trust_level: ${raw} (must be 0, 1, 2, or 3)`);
  }
  return n;
}

export const uploadRoute = {
  async POST(request: Request, env: Env): Promise<Response> {
    const auth = verifyAdminToken(request.headers.get("Authorization"), env.ADMIN_TOKEN);
    if (!auth.ok) {
      return Response.json({ error: auth.message }, { status: auth.status });
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return Response.json({ error: "Expected multipart/form-data" }, { status: 400 });
    }

    const raw = form.get("file");
    // 显式收窄到 Blob：Cloudflare Workers 的 FormData.get() 在 @types/node 加入后
    // 类型推断会出现交叉，所以用 type guard 手动 narrow
    if (raw === null || typeof raw === "string") {
      return Response.json({ error: "Missing file field" }, { status: 400 });
    }
    const file = raw as File;

    const filename = file.name ?? "upload";
    const fileType: FileType | null = detectFileType(filename);
    if (!fileType) {
      return Response.json(
        { error: `Unsupported file type for: ${filename}` },
        { status: 400 }
      );
    }

    let trustLevel: TrustLevel;
    try {
      trustLevel = parseTrustLevel(
        typeof form.get("trust_level") === "string"
          ? (form.get("trust_level") as string)
          : null
      );
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "Invalid trust_level" },
        { status: 400 }
      );
    }

    // 1. 读 + 解析
    const bytes = await file.arrayBuffer();
    const text = await parseFile(fileType, bytes);
    if (!text.trim()) {
      return Response.json({ error: "Parsed text is empty" }, { status: 400 });
    }

    // 2. 分块
    const chunkResults = chunkText(text, {
      maxTokens: CHUNK_MAX_TOKENS,
      overlapTokens: CHUNK_OVERLAP_TOKENS,
    });
    if (chunkResults.length === 0) {
      return Response.json({ error: "No chunks produced from text" }, { status: 400 });
    }

    // 3. 写 R2
    const fileId = ulid();
    const sourceId = ulid();
    const documentId = ulid();
    const r2Key = `raw/${DEFAULT_USER_ID}/${fileId}/${filename}`;
    await env.R2.put(r2Key, bytes, {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
    });

    // 4. 嵌入
    const embedder = createMiniMaxEmbedder({
      apiKey: env.MINIMAX_API_KEY,
      baseUrl: env.MINIMAX_BASE_URL,
      // 模型名后续在 wrangler vars 注入；MVP 阶段用一个稳定名字
      model: "MiniMax-embeddings",
    });
    const vectors = await embedder.embed(chunkResults.map((c) => c.content));

    const now = Date.now();
    const userId = DEFAULT_USER_ID;

    // 5. 写 D1: source + document + chunks（一个 batch，失败时整批回滚）
    const statements: D1PreparedStatement[] = [];

    statements.push(
      env.DB.prepare(
        "INSERT INTO source (id, user_id, type, title, trust_level, created_at, meta) VALUES (?, ?, 'file', ?, ?, ?, ?)"
      ).bind(
        sourceId,
        userId,
        filename,
        trustLevel,
        now,
        JSON.stringify({ filename, fileType, size: bytes.byteLength })
      )
    );

    statements.push(
      env.DB.prepare(
        "INSERT INTO document (id, source_id, user_id, title, raw_path, parsed_text_path, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)"
      ).bind(documentId, sourceId, userId, filename, r2Key, now)
    );

    for (let i = 0; i < chunkResults.length; i++) {
      const c = chunkResults[i]!;
      statements.push(
        env.DB.prepare(
          "INSERT INTO chunk (id, document_id, source_id, user_id, idx, content, token_count, trust_level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          c.id,
          documentId,
          sourceId,
          userId,
          c.idx,
          c.content,
          c.tokenCount,
          trustLevel,
          now
        )
      );
    }

    await env.DB.batch(statements);

    // 6. 写 Vectorize（按 schema，metadata 里需要 user_id 和 trust_level 做过滤/加权）
    await env.VECTORIZE.upsert(
      chunkResults.map((c, i) => ({
        id: c.id,
        values: vectors[i]!,
        metadata: {
          user_id: userId,
          source_id: sourceId,
          document_id: documentId,
          trust_level: trustLevel,
        },
      }))
    );

    const body: UploadResponse = {
      sourceId,
      documentId,
      chunkCount: chunkResults.length,
      r2Key,
    };
    return Response.json(body, { status: 201 });
  },
};
