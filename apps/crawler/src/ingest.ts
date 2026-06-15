import type { CrawledDocument, IngestPayload } from "./types.js";

export interface BuildPayloadOptions {
  userId: string;
  trustLevel: 0 | 1 | 2 | 3;
}

export function buildIngestPayload(doc: CrawledDocument, opts: BuildPayloadOptions): IngestPayload {
  const safeTitle = doc.title || doc.url;
  const sourceId = "01H" + cryptoRandomHex(24);
  const documentId = "01H" + cryptoRandomHex(24);
  return {
    source: {
      type: "webpage",
      title: safeTitle,
      url: doc.url,
      trust_level: opts.trustLevel,
      meta: { source_id: sourceId, fetched_at: doc.fetchedAt },
    },
    document: {
      title: safeTitle,
      raw_path: `raw/${opts.userId}/crawl/${documentId}.html`,
      parsed_text: doc.paragraphs.join("\n\n"),
    },
    chunks: doc.paragraphs.map((content, idx) => ({
      idx,
      content,
      token_count: content.length,  // 简化：1 char = 1 token（中文 heuristic）
      trust_level: opts.trustLevel,
    })),
  };
}

export interface SubmitOptions {
  ingestUrl: string;
  token: string;
  userId: string;
  trustLevel: 0 | 1 | 2 | 3;
  fetchImpl?: typeof fetch;
}

export type SubmitResult =
  | { ok: true; sourceId?: string; documentId?: string }
  | { ok: false; status: number; error: string };

export async function submitToIngest(
  doc: CrawledDocument,
  opts: SubmitOptions,
): Promise<SubmitResult> {
  const payload = buildIngestPayload(doc, { userId: opts.userId, trustLevel: opts.trustLevel });

  const f = opts.fetchImpl ?? fetch;
  const res = await f(opts.ingestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, status: res.status, error: body.error ?? `HTTP ${res.status}` };
  }

  const body = (await res.json()) as { ok?: boolean; sourceId?: string; documentId?: string };
  return { ok: true, sourceId: body.sourceId, documentId: body.documentId };
}

/** 26 hex chars — 简化版 ulid 替代 */
function cryptoRandomHex(len: number): string {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}
