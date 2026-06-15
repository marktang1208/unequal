import { createMiniMaxEmbedder } from "@unequal/shared/embedding";
import { searchChunks, type SearchResult } from "@unequal/shared/retrieval";
import { buildAskPrompt, DISCLAIMER_TEXT, type AskContext } from "@unequal/shared/prompt";
import { verifyCitations } from "@unequal/shared/cite-verify";
import type { Citation } from "@unequal/shared/types";
import { chatCompletion, type LLMMessage } from "./llm.js";
import { readCache, writeCache } from "./cache.js";
import type { Env } from "../types.js";

const DEFAULT_USER_ID = "01H0000000000000000000000";

export type SearchFn = (qEmbedding: number[]) => Promise<SearchResult[]>;

export interface RunAskOptions {
  q: string;
  env: Env;
  fetchImpl?: typeof fetch;
  searchFn?: SearchFn;
  cacheRead?: (qEmbedding: number[]) => Promise<AskResult | null>;
  cacheWrite?: (qEmbedding: number[], result: AskResult) => Promise<void>;
}

export interface AskResult {
  answer: string;
  disclaimer: string;
  citations: Citation[];
  cached: boolean;
}

const SNIPPET_CHARS = 100;

export async function runAsk(opts: RunAskOptions): Promise<AskResult> {
  const { q, env, fetchImpl } = opts;

  const embed = createMiniMaxEmbedder({
    apiKey: env.MINIMAX_API_KEY,
    baseUrl: env.MINIMAX_BASE_URL,
    model: "MiniMax-embeddings",
    fetchImpl,
  });
  const [qEmbedding] = await embed.embed([q]);
  if (!qEmbedding) throw new Error("embedding returned empty");

  const cacheRead = opts.cacheRead ?? (async (qEmbedding) => {
    const cached = await readCache({
      d1: env.DB,
      vectorize: env.VECTORIZE,
      userId: DEFAULT_USER_ID,
      q,
      qEmbedding,
    });
    if (!cached) return null;
    return { answer: cached.answer, disclaimer: DISCLAIMER_TEXT, citations: [], cached: false };
  });
  const cacheWrite = opts.cacheWrite ?? (async (qEmbedding, result) => {
    await writeCache({
      d1: env.DB,
      vectorize: env.VECTORIZE,
      userId: DEFAULT_USER_ID,
      q,
      qEmbedding,
      answer: result.answer,
      verified: result.citations.map((c) => c.n),
    });
  });

  if (cacheRead) {
    const cached = await cacheRead(qEmbedding);
    if (cached) return { ...cached, cached: true };
  }

  const rawHits = opts.searchFn
    ? await opts.searchFn(qEmbedding)
    : await searchChunks({
        vectorize: env.VECTORIZE,
        userId: DEFAULT_USER_ID,
        queryVector: qEmbedding,
        topK: 20,
      });

  const top5: SearchResult[] = rawHits.slice(0, 5);

  const snippets = await fetchSnippets(env, top5);

  const ctx: AskContext = {
    chunks: snippets.map((s, idx) => ({
      n: (idx + 1) as 1 | 2 | 3 | 4 | 5,
      title: s.title ?? "(无标题)",
      snippet: s.content.slice(0, SNIPPET_CHARS),
      trustLevel: (s.trustLevel as 0 | 1 | 2 | 3) ?? 0,
    })),
  };
  const prompt = buildAskPrompt(q, ctx);

  const messages: LLMMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  const rawAnswer = await chatCompletion({
    apiKey: env.MINIMAX_API_KEY,
    baseUrl: env.MINIMAX_BASE_URL,
    model: "MiniMax-chat",
    messages,
    fetchImpl,
  });

  const { verified } = verifyCitations(rawAnswer);

  let answer: string;
  let citations: Citation[];
  if (verified.length === 0) {
    answer = "未在知识库中找到可靠来源";
    citations = [];
  } else {
    const jsonMatch = rawAnswer.match(/\{[^{}]*"citations"[^{}]*\}\s*$/);
    const textOnly = jsonMatch ? rawAnswer.slice(0, jsonMatch.index).trimEnd() : rawAnswer;
    answer = textOnly;
    citations = verified.map((n) => {
      const s = snippets[n - 1]!;
      return {
        n,
        title: s.title ?? "(无标题)",
        snippet: s.content,
        url: s.rawPath ?? "",
        trustLevel: (s.trustLevel as 0 | 1 | 2 | 3) ?? 0,
        sourceId: s.sourceId ?? "",
        chunkId: s.chunkId,
      };
    });
  }

  const disclaimer = DISCLAIMER_TEXT;
  if (!answer.includes(disclaimer)) {
    answer = `${answer}\n\n${disclaimer}`;
  }

  const result: AskResult = { answer, disclaimer, citations, cached: false };
  if (verified.length > 0 && cacheWrite) {
    await cacheWrite(qEmbedding, result);
  }

  return result;
}

interface SnippetRow {
  chunkId: string;
  content: string;
  title?: string;
  rawPath?: string;
  trustLevel?: number;
  sourceId?: string;
}

async function fetchSnippets(env: Env, hits: SearchResult[]): Promise<SnippetRow[]> {
  if (hits.length === 0) return [];
  const placeholders = hits.map(() => "?").join(",");
  const stmt = env.DB.prepare(
    `SELECT c.id AS chunkId, c.content, c.trust_level AS trustLevel, c.source_id AS sourceId,
            d.title AS title, d.raw_path AS rawPath
       FROM chunk c
       JOIN document d ON d.id = c.document_id
      WHERE c.id IN (${placeholders})`,
  );
  const rows = (await stmt.bind(...hits.map((h) => h.chunkId)).all()).results as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    chunkId: r.chunkId as string,
    content: (r.content as string) ?? "",
    title: r.title as string | undefined,
    rawPath: r.rawPath as string | undefined,
    trustLevel: r.trustLevel as number | undefined,
    sourceId: r.sourceId as string | undefined,
  }));
}