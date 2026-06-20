import { describe, it, expect } from "vitest";
import { buildIngestBody, submitToIngest } from "../src/ingest.js";
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

describe("buildIngestBody", () => {
  it("基础: 无 userId → body 不含 user_id 字段 (CP-7-C #3)", () => {
    const b = buildIngestBody(sample, { trustLevel: 2 });
    expect(b.content).toContain("婴儿发烧时先观察精神状态");
    expect(b.title).toBe("婴儿发烧 38.5℃ 的家庭处理");
    expect(b.url).toBe("https://example.com/article");
    expect(b.trust_level).toBe(2);
    expect("user_id" in b).toBe(false);
  });

  it("userId undefined → 字段省略 (CP-7-C #3)", () => {
    const b = buildIngestBody(sample, { trustLevel: 2 });
    expect(b.user_id).toBeUndefined();
  });

  it("userId 空字符串 → 字段省略 (CP-7-C #3)", () => {
    const b = buildIngestBody(sample, { trustLevel: 2, userId: "" });
    expect("user_id" in b).toBe(false);
  });

  it("userId 传具体值 → body 含 user_id: X (CP-7-C #3)", () => {
    const b = buildIngestBody(sample, { trustLevel: 2, userId: "01KVCZ..." });
    expect(b.user_id).toBe("01KVCZ...");
  });

  it("段落拼接 → content = paragraphs.join('\\n\\n') (CP-7-C #3)", () => {
    const b = buildIngestBody(sample, { trustLevel: 2 });
    expect(b.content).toBe(sample.paragraphs.join("\n\n"));
  });

  it("title 缺省 → fallback 到 url (CP-7-C #3)", () => {
    const noTitle: CrawledDocument = { ...sample, title: "" };
    const b = buildIngestBody(noTitle, { trustLevel: 2 });
    expect(b.title).toBe(sample.url);
  });

  it("trustLevel 透传 (CP-7-C #3)", () => {
    const b0 = buildIngestBody(sample, { trustLevel: 0 });
    const b3 = buildIngestBody(sample, { trustLevel: 3 });
    expect(b0.trust_level).toBe(0);
    expect(b3.trust_level).toBe(3);
  });
});

describe("submitToIngest", () => {
  // ─── 200 成功路径 ──────────────────────────────────────────

  it("proxy + userId → headers 仅 x-ingest-proxy-secret, body 含 user_id, 200 → ok (CP-7-C #3)", async () => {
    let captured: { headers: Record<string, string>; body: string } | undefined;
    const fetchMock: typeof fetch = async (_input, init) => {
      captured = {
        headers: init?.headers as Record<string, string>,
        body: init?.body as string,
      };
      return new Response(JSON.stringify({ ok: true, sourceId: "01H", documentId: "01H" }), { status: 200 });
    };
    const r = await submitToIngest(sample, {
      ingestUrl: "http://localhost:8787/ingest",
      ingestProxySecret: "proxy-secret-001",
      userId: "01KVCZ...",
      trustLevel: 2,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
    expect(captured).toBeDefined();
    expect(captured!.headers["x-ingest-proxy-secret"]).toBe("proxy-secret-001");
    expect(captured!.headers["authorization"]).toBeUndefined();  // CP-7-C #3: 互斥
    const parsedBody = JSON.parse(captured!.body);
    expect(parsedBody.user_id).toBe("01KVCZ...");
    expect(parsedBody.content).toContain("婴儿发烧时先观察精神状态");
    expect(parsedBody.url).toBe("https://example.com/article");
    expect(parsedBody.trust_level).toBe(2);
  });

  it("token + 无 userId → headers 仅 authorization, body 不含 user_id, 200 → ok (CP-7-C #3)", async () => {
    let captured: { headers: Record<string, string>; body: string } | undefined;
    const fetchMock: typeof fetch = async (_input, init) => {
      captured = {
        headers: init?.headers as Record<string, string>,
        body: init?.body as string,
      };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const r = await submitToIngest(sample, {
      ingestUrl: "http://localhost:8787/ingest",
      token: "admin-token-please-change",
      trustLevel: 2,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
    expect(captured).toBeDefined();
    expect(captured!.headers["authorization"]).toBe("Bearer admin-token-please-change");
    expect(captured!.headers["x-ingest-proxy-secret"]).toBeUndefined();  // CP-7-C #3: 互斥
    const parsedBody = JSON.parse(captured!.body);
    expect("user_id" in parsedBody).toBe(false);
  });

  // ─── 401 / 403 HTTP 错误 ──────────────────────────────────

  it("401 (token invalid) → ok=false 含 status 401 + error", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
    const r = await submitToIngest(sample, {
      ingestUrl: "http://x",
      token: "bad-token",
      trustLevel: 2,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.error).toContain("Invalid token");
    }
  });

  it("403 (IP not allowed) → ok=false 含 status 403 + error (CP-7-C #3)", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "IP_NOT_ALLOWED" }), { status: 403 });
    const r = await submitToIngest(sample, {
      ingestUrl: "http://x",
      token: "ok-token",
      trustLevel: 2,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toContain("IP_NOT_ALLOWED");
    }
  });

  // ─── auth 互斥 throw ──────────────────────────────────────

  it("proxy + token 都有 → throw Error (CP-7-C #3)", async () => {
    await expect(
      submitToIngest(sample, {
        ingestUrl: "http://x",
        ingestProxySecret: "secret-1",
        token: "tok-1",
        trustLevel: 2,
      }),
    ).rejects.toThrow("exactly one of ingestProxySecret/token");
  });

  it("proxy + token 都无 → throw Error (CP-7-C #3)", async () => {
    await expect(
      submitToIngest(sample, {
        ingestUrl: "http://x",
        trustLevel: 2,
      }),
    ).rejects.toThrow("exactly one of ingestProxySecret/token");
  });
});
