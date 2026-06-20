import { describe, it, expect } from "vitest";
import { buildIngestPayload, submitToIngest } from "../src/ingest.js";
import type { CrawledDocument } from "../src/types.js";

const sample: CrawledDocument = {
  url: "https://example.com/article",
  title: "婴儿发烧 38.5℃ 的家庭处理",
  paragraphs: [
    "婴儿发烧时先观察精神状态比体温数字更重要。",
    "对乙酰氨基酚（泰诺林）是 3 个月以上婴儿首选退烧药。",
  ],
  totalChars: 60,
  fetchedAt: 1718400000000,
};

describe("buildIngestPayload", () => {
  it("CrawledDocument → IngestPayload (source.type='webpage' + document + chunks)", () => {
    const p = buildIngestPayload(sample, { userId: "01H0000000000000000000000", trustLevel: 2 });
    expect(p.source.type).toBe("webpage");
    expect(p.source.title).toBe("婴儿发烧 38.5℃ 的家庭处理");
    expect(p.source.url).toBe("https://example.com/article");
    expect(p.source.trust_level).toBe(2);
    expect(p.document.title).toBe("婴儿发烧 38.5℃ 的家庭处理");
    expect(p.document.parsed_text).toContain("婴儿发烧时先观察精神状态");
    expect(p.chunks.length).toBe(2);
    expect(p.chunks[0]?.idx).toBe(0);
    expect(p.chunks[0]?.content).toBe("婴儿发烧时先观察精神状态比体温数字更重要。");
    expect(p.chunks[0]?.token_count).toBeGreaterThan(0);
    expect(p.chunks[0]?.trust_level).toBe(2);
  });
});

describe("submitToIngest", () => {
  it("200 + JSON → 返回 ok=true", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("http://localhost:8787/ingest");
      const body = JSON.parse(init?.body as string);
      expect(body.source.type).toBe("webpage");
      return new Response(JSON.stringify({ ok: true, sourceId: "01H...", documentId: "01H..." }), { status: 200 });
    };
    const r = await submitToIngest(sample, {
      ingestUrl: "http://localhost:8787/ingest",
      token: "test-token-please-change",
      userId: "01H0000000000000000000000",
      trustLevel: 2,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
  });

  it("401 (token invalid) → 返回 ok=false 含 status 401", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
    const r = await submitToIngest(sample, {
      ingestUrl: "http://localhost:8787/ingest",
      token: "bad-token",
      userId: "01H...",
      trustLevel: 2,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.error).toContain("Invalid token");
    }
  });

  // ─── CP-7-C #2: ingestProxySecret 透传 ─────────────────────────

  it("传 ingestProxySecret → headers 含 x-ingest-proxy-secret + 仍含 authorization (CP-7-C #2)", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchMock: typeof fetch = async (_input, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ ok: true, sourceId: "01H", documentId: "01H" }), { status: 200 });
    };
    await submitToIngest(sample, {
      ingestUrl: "http://localhost:8787/ingest",
      token: "test-token",
      userId: "u1",
      trustLevel: 2,
      ingestProxySecret: "proxy-secret-001",
      fetchImpl: fetchMock,
    });
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!["x-ingest-proxy-secret"]).toBe("proxy-secret-001");
    expect(capturedHeaders!["authorization"]).toBe("Bearer test-token"); // 双 header 同时存在
  });

  it("不传 ingestProxySecret → headers 仅 authorization 无 x-ingest-proxy-secret (CP-7-C #2)", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchMock: typeof fetch = async (_input, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await submitToIngest(sample, {
      ingestUrl: "http://localhost:8787/ingest",
      token: "test-token",
      userId: "u1",
      trustLevel: 2,
      fetchImpl: fetchMock,
    });
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!["x-ingest-proxy-secret"]).toBeUndefined();
    expect(capturedHeaders!["authorization"]).toBe("Bearer test-token");
  });
});
