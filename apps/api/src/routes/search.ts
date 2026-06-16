import { verifyAuth, HttpError } from "../lib/auth.js";
import { createMiniMaxEmbedder } from "@unequal/shared/embedding";
import { searchChunks } from "@unequal/shared/retrieval";
import type { Env } from "../types.js";

// MVP 阶段只有 1 个用户；与 upload.ts / seed-user route 的默认 ULID 占位对齐
// (user.id FK 引用此值；先 POST /seed-user 注入该行后再 /upload)
const DEFAULT_USER_ID = "01H0000000000000000000000";

interface SearchSnippet {
  chunkId: string;
  sourceId: string | undefined;
  documentId: string | undefined;
  trustLevel: number;
  finalScore: number;
  vectorizeScore: number;
  content: string;
}

export const searchRoute = {
  async GET(request: Request, env: Env): Promise<Response> {
    try {
      await verifyAuth(request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json({ error: err.code, message: err.message }, { status: err.status });
      }
      throw err;
    }

    const url = new URL(request.url);
    const q = url.searchParams.get("q");
    const topK = Number(url.searchParams.get("topK") ?? 5);
    if (!q) {
      return Response.json({ error: "Missing q parameter" }, { status: 400 });
    }

    // 1. 嵌入
    const embed = createMiniMaxEmbedder({
      apiKey: env.MINIMAX_API_KEY,
      baseUrl: env.MINIMAX_BASE_URL,
      // 模型名与 upload.ts 对齐（Task 9 约定；"MiniMax-embeddings" 复数）
      model: "MiniMax-embeddings",
    });
    const [queryVector] = await embed.embed([q]);

    // 2. 检索（Vectorize 相似度 + trust_level 加权）
    const hits = await searchChunks({
      vectorize: env.VECTORIZE,
      userId: DEFAULT_USER_ID,
      queryVector: queryVector!,
      topK,
    });

    if (hits.length === 0) {
      return Response.json({ q, hits: [] as SearchSnippet[] });
    }

    // 3. 用 chunk_id 反查 D1 拿 content（spec §5.2 步骤 ⑧ 二次校验）
    const placeholders = hits.map(() => "?").join(",");
    const stmt = env.DB.prepare(
      `SELECT id, content, source_id, document_id, trust_level FROM chunk WHERE id IN (${placeholders})`
    );
    const rows = await stmt.bind(...hits.map((h) => h.chunkId)).all();

    const byId = new Map(
      (rows.results as Array<Record<string, unknown>>).map((r) => [r.id as string, r])
    );

    const snippets: SearchSnippet[] = hits.map((h) => {
      const row = byId.get(h.chunkId);
      return {
        chunkId: h.chunkId,
        sourceId: row?.source_id as string | undefined,
        documentId: row?.document_id as string | undefined,
        trustLevel: h.trustLevel,
        finalScore: h.finalScore,
        vectorizeScore: h.vectorizeScore,
        content: (row?.content as string | undefined)?.slice(0, 300) ?? "",
      };
    });

    return Response.json({ q, hits: snippets });
  },
};