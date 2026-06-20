import type { CrawledDocument, IngestBody } from "./types.js";

export interface BuildBodyOptions {
  trustLevel: 0 | 1 | 2 | 3;
  /**
   * 缺省 undefined：CLI 不传 --user-id → 字段从 body 完全省略。
   * 传具体 user_id：CLI 传 --user-id <X> → body 含 user_id: X。
   * 注意：admin 路径禁止 user_id（CLI 层 fail-fast 拦截）。
   */
  userId?: string;
}

export function buildIngestBody(doc: CrawledDocument, opts: BuildBodyOptions): IngestBody {
  return {
    content: doc.paragraphs.join("\n\n"),
    title: doc.title || doc.url,
    url: doc.url,
    trust_level: opts.trustLevel,
    ...(opts.userId ? { user_id: opts.userId } : {}),
  };
}

export interface SubmitOptions {
  ingestUrl: string;
  /**
   * auth：proxy secret 与 token 互斥（CLI 层 enforce；submitToIngest 也防御性 throw）。
   * - ingestProxySecret 有值 → headers 含 x-ingest-proxy-secret（只发这一个）
   * - token 有值 → headers 含 authorization: Bearer（只发这一个）
   * - 两者都有/都无 → throw Error
   */
  ingestProxySecret?: string;
  token?: string;
  /** undefined → body 不含 user_id 字段 */
  userId?: string;
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
  const hasProxy = !!opts.ingestProxySecret;
  const hasToken = !!opts.token;
  if (hasProxy === hasToken) {
    throw new Error("submitToIngest: exactly one of ingestProxySecret/token must be provided");
  }

  const body = buildIngestBody(doc, { trustLevel: opts.trustLevel, userId: opts.userId });

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (hasProxy) {
    headers["x-ingest-proxy-secret"] = opts.ingestProxySecret!;
  } else {
    headers["authorization"] = `Bearer ${opts.token!}`;
  }

  const f = opts.fetchImpl ?? fetch;
  const res = await f(opts.ingestUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, status: res.status, error: errBody.error ?? `HTTP ${res.status}` };
  }

  const okBody = (await res.json()) as { ok?: boolean; sourceId?: string; documentId?: string };
  return { ok: true, sourceId: okBody.sourceId, documentId: okBody.documentId };
}
