/**
 * CP-7-C #2: api-ingest handler 集成测试
 *
 * 覆盖：
 * - 鉴权矩阵：proxy / admin_token / admin_jwt / 无凭证
 * - user_id 行为：proxy 允许指定 / admin 禁止指定 / 缺省用 DEFAULT_USER_ID
 * - audit 调用：每次 ingest 至少 1-2 条 audit（start + end success/failure）
 * - 业务失败：audit 失败 → 500；ingest 失败 → audit failure 记录
 * - IP allowlist + dev mode (INGEST_PROXY_SECRET 未配)
 *
 * mock：db.js + env.js + auth-admin.js + embedding + chunking
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

interface TestEnv {
  ADMIN_TOKEN: string;
  INGEST_PROXY_SECRET: string | undefined;
  DEFAULT_USER_ID: string;
  ALLOWED_ORIGIN: string;
  ADMIN_IP_ALLOWLIST: string;
  JWT_SECRET: string;
  MINIMAX_API_KEY: string;
  KEK_SECRET_V1: string;
  ENVIRONMENT: string;
  MINIMAX_BASE_URL: string;
  KEK_CURRENT_VERSION: string;
}

const testEnv: TestEnv = {
  ADMIN_TOKEN: "admin-token-test",
  INGEST_PROXY_SECRET: "proxy-secret-test",
  DEFAULT_USER_ID: "default-user-001",
  ALLOWED_ORIGIN: "*",
  ADMIN_IP_ALLOWLIST: "127.0.0.1",
  JWT_SECRET: "test-jwt-secret-must-be-32-bytes-long-aaaaaaaaaa",
  MINIMAX_API_KEY: "sk-test",
  KEK_SECRET_V1: "kek-secret-32-bytes-min-aaaaaaaaaaaa",
  ENVIRONMENT: "test",
  MINIMAX_BASE_URL: "https://api.test/v1",
  KEK_CURRENT_VERSION: "1",
};

vi.mock("../../src/lib/db.js", () => ({
  COLLECTIONS: {
    source: "source",
    document: "document",
    chunk: "chunk",
    auditLog: "audit_log",
  },
  add: vi.fn(async () => "01HNEWID"),
  getById: vi.fn(),
  whereQuery: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  count: vi.fn(),
  newId: vi.fn(() => "01HNEWID"),
  getAllByFilter: vi.fn(),
}));

vi.mock("../../src/lib/env.js", () => ({
  getEnv: () => testEnv,
}));

vi.mock("../../src/lib/auth-admin.js", () => ({
  requireAdmin: vi.fn(),
  requireIngestProxy: vi.fn(),
}));

vi.mock("@unequal/shared/embedding", () => ({
  createMiniMaxEmbedder: vi.fn(() => ({
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Array(1536).fill(0.1))),
  })),
}));

// CP-7-D #2: handler 走 llm-provider factory，mock factory 而不是 mock shared/embedding
const mockEmbedFn = vi.fn(async (texts: string[]) => texts.map(() => new Array(1536).fill(0.1)));
vi.mock("../../src/lib/llm-provider.js", () => ({
  getEmbedder: () => ({ embed: mockEmbedFn }),
  getChatProvider: () => ({
    chat: vi.fn(async () => ({ content: "mock answer" })),
  }),
  resetProviders: vi.fn(),
  __setEmbedderForTest: vi.fn(),
  __setChatProviderForTest: vi.fn(),
}));

vi.mock("@unequal/shared/chunking", () => ({
  chunkText: vi.fn((content: string) => [
    { content, tokenCount: 100 },
  ]),
}));

import { add } from "../../src/lib/db.js";
import { requireAdmin, requireIngestProxy } from "../../src/lib/auth-admin.js";
import {
  __setAuditImpl,
  __resetAuditImpl,
  type AuditEntry,
} from "../../src/lib/audit.js";
import { main } from "../../src/handlers/api-ingest.js";
import type { HttpTriggerEvent } from "../../src/lib/handler-utils.js";

const ADMIN_TOKEN = "admin-token-test";
const PROXY_SECRET = "proxy-secret-test";
const DEFAULT_USER = "default-user-001";

function makeEvent(opts: {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  clientIp?: string;
}): HttpTriggerEvent {
  return {
    httpMethod: opts.method ?? "POST",
    path: "/api-ingest",
    headers: {
      "x-real-ip": opts.clientIp ?? "127.0.0.1",
      ...opts.headers,
    },
    queryString: {},
    body: opts.body ?? null,
    isBase64Encoded: false,
  };
}

function makeAdminOk(via: "admin_token" | "admin_jwt") {
  return { ok: true as const, scope: "admin" as const, via };
}

function makeProxyOk() {
  return { ok: true as const, scope: "admin" as const, via: "ingest_proxy" as const };
}

function makeAuthFail(statusCode: number, error: string, message: string) {
  return {
    ok: false as const,
    response: { statusCode, body: JSON.stringify({ error, message }) },
  };
}

describe("api-ingest (CP-7-C #2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAuditImpl();
    testEnv.INGEST_PROXY_SECRET = PROXY_SECRET;
    testEnv.ADMIN_IP_ALLOWLIST = "127.0.0.1";
    // 默认 audit impl = no-op
    __setAuditImpl(vi.fn().mockResolvedValue(undefined));
  });

  // ─── Group 1: 鉴权 (5) ─────────────────────────────────────────────

  it("1. proxy 正确值 + 无 user_id → 200 + audit 调用", async () => {
    vi.mocked(requireIngestProxy).mockResolvedValue(makeProxyOk());
    vi.mocked(requireAdmin).mockResolvedValue(makeAuthFail(500, "SHOULD_NOT_BE_CALLED", ""));

    const res = await main(
      makeEvent({
        headers: { "x-ingest-proxy-secret": PROXY_SECRET },
        body: JSON.stringify({ content: "测试内容" }),
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(requireIngestProxy).toHaveBeenCalledTimes(1);
    expect(requireAdmin).not.toHaveBeenCalled(); // proxy 路径优先
    const body = JSON.parse(res.body);
    expect(body.chunks_inserted).toBe(1);
  });

  it("2. proxy + user_id 指定 → 200 + target.userId = body.user_id", async () => {
    vi.mocked(requireIngestProxy).mockResolvedValue(makeProxyOk());
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(auditSpy);

    const res = await main(
      makeEvent({
        headers: { "x-ingest-proxy-secret": PROXY_SECRET },
        body: JSON.stringify({ content: "测试内容", user_id: "wx-user-001" }),
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(auditSpy).toHaveBeenCalledTimes(2); // start + end success
    const successAudit = auditSpy.mock.calls[1]?.[0] as AuditEntry;
    expect(successAudit.target.userId).toBe("wx-user-001");
  });

  it("3. proxy 错值 → 401 INVALID_PROXY + 不调 audit", async () => {
    vi.mocked(requireIngestProxy).mockResolvedValue(
      makeAuthFail(401, "INVALID_PROXY", "X-Ingest-Proxy-Secret does not match"),
    );
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(auditSpy);

    const res = await main(
      makeEvent({
        headers: { "x-ingest-proxy-secret": "wrong-value" },
        body: JSON.stringify({ content: "测试内容" }),
      }),
    );

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("INVALID_PROXY");
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("4. 无 Authorization + 无 proxy → 401 AUTH_FAILED（走 requireAdmin 路径）", async () => {
    // 无 proxy header → handler 走 requireAdmin 分支；mock requireAdmin 返 401
    vi.mocked(requireIngestProxy).mockResolvedValue(
      makeAuthFail(500, "SHOULD_NOT_BE_CALLED", ""),
    );
    vi.mocked(requireAdmin).mockResolvedValue(
      makeAuthFail(401, "AUTH_FAILED", "Missing Authorization header"),
    );

    const res = await main(
      makeEvent({ body: JSON.stringify({ content: "测试内容" }) }),
    );

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("AUTH_FAILED");
    expect(requireIngestProxy).not.toHaveBeenCalled();
    expect(requireAdmin).toHaveBeenCalledTimes(1);
  });

  it("5. OPTIONS 预检 → 204", async () => {
    const res = await main(makeEvent({ method: "OPTIONS" }));
    expect(res.statusCode).toBe(204);
  });

  // ─── Group 2: user_id 行为 (5) ────────────────────────────────────

  it("6. admin_token + user_id 指定 → 403 INSUFFICIENT_SCOPE + 不调 audit", async () => {
    vi.mocked(requireIngestProxy).mockResolvedValue(
      makeAuthFail(401, "AUTH_FAILED", "Missing header"),
    );
    vi.mocked(requireAdmin).mockResolvedValue(makeAdminOk("admin_token"));
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(auditSpy);

    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ content: "测试内容", user_id: "wx-user-001" }),
      }),
    );

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("INSUFFICIENT_SCOPE");
    expect(body.message).toMatch(/user_id/i);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("7. admin_jwt + user_id 指定 → 403 INSUFFICIENT_SCOPE", async () => {
    vi.mocked(requireIngestProxy).mockResolvedValue(
      makeAuthFail(401, "AUTH_FAILED", "Missing header"),
    );
    vi.mocked(requireAdmin).mockResolvedValue(makeAdminOk("admin_jwt"));

    const res = await main(
      makeEvent({
        headers: { authorization: "Bearer admin-jwt-token" },
        body: JSON.stringify({ content: "测试内容", user_id: "wx-user-001" }),
      }),
    );

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("INSUFFICIENT_SCOPE");
  });

  it("8. admin_token + 无 user_id → 200 + target.userId = DEFAULT_USER_ID (回归)", async () => {
    vi.mocked(requireIngestProxy).mockResolvedValue(
      makeAuthFail(401, "AUTH_FAILED", "Missing header"),
    );
    vi.mocked(requireAdmin).mockResolvedValue(makeAdminOk("admin_token"));
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(auditSpy);

    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ content: "测试内容" }),
      }),
    );

    expect(res.statusCode).toBe(200);
    const successAudit = auditSpy.mock.calls[1]?.[0] as AuditEntry;
    expect(successAudit.actor.via).toBe("admin_token");
    expect(successAudit.target.userId).toBe(DEFAULT_USER);
  });

  it("9. proxy + 无 user_id → 200 + target.userId = DEFAULT_USER_ID", async () => {
    vi.mocked(requireIngestProxy).mockResolvedValue(makeProxyOk());
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(auditSpy);

    const res = await main(
      makeEvent({
        headers: { "x-ingest-proxy-secret": PROXY_SECRET },
        body: JSON.stringify({ content: "测试内容" }),
      }),
    );

    expect(res.statusCode).toBe(200);
    const successAudit = auditSpy.mock.calls[1]?.[0] as AuditEntry;
    expect(successAudit.actor.via).toBe("ingest_proxy");
    expect(successAudit.target.userId).toBe(DEFAULT_USER);
  });

  it("10. proxy + user_id = '' 空字符串 → 200 + target.userId = DEFAULT_USER_ID", async () => {
    vi.mocked(requireIngestProxy).mockResolvedValue(makeProxyOk());
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(auditSpy);

    const res = await main(
      makeEvent({
        headers: { "x-ingest-proxy-secret": PROXY_SECRET },
        body: JSON.stringify({ content: "测试内容", user_id: "" }),
      }),
    );

    expect(res.statusCode).toBe(200);
    const successAudit = auditSpy.mock.calls[1]?.[0] as AuditEntry;
    expect(successAudit.target.userId).toBe(DEFAULT_USER);
  });

  // ─── Group 3: 业务 (4) ────────────────────────────────────────────

  it("11. 缺 content → 400 INVALID_REQUEST + 不调 audit", async () => {
    vi.mocked(requireIngestProxy).mockResolvedValue(makeProxyOk());
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(auditSpy);

    const res = await main(
      makeEvent({
        headers: { "x-ingest-proxy-secret": PROXY_SECRET },
        body: JSON.stringify({ title: "no content" }),
      }),
    );

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("INVALID_REQUEST");
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("12. audit 写失败 → 500 AUDIT_FAILED + 不进 ingest 业务", async () => {
    vi.mocked(requireIngestProxy).mockResolvedValue(makeProxyOk());
    __setAuditImpl(vi.fn().mockRejectedValue(new Error("audit write failed")));
    vi.mocked(add).mockClear();

    const res = await main(
      makeEvent({
        headers: { "x-ingest-proxy-secret": PROXY_SECRET },
        body: JSON.stringify({ content: "测试内容" }),
      }),
    );

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("AUDIT_FAILED");
    // ingest 业务 add() 不该被调（仅 audit.add 被调，且失败）
    expect(add).not.toHaveBeenCalled();
  });

  it("13. ingest 业务失败（embed 错）→ 500 + audit failure 记录", async () => {
    vi.mocked(requireIngestProxy).mockResolvedValue(makeProxyOk());
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(auditSpy);

    // mock embed 失败（CP-7-D #2: 直接 mock factory 的 embed 函数）
    mockEmbedFn.mockImplementationOnce(async () => {
      throw new Error("MiniMax timeout");
    });

    const res = await main(
      makeEvent({
        headers: { "x-ingest-proxy-secret": PROXY_SECRET },
        body: JSON.stringify({ content: "测试内容" }),
      }),
    );

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("EMBEDDING_FAILED");
    // audit 写 2 条：start (in_progress) + end (failure)
    expect(auditSpy).toHaveBeenCalledTimes(2);
    const failAudit = auditSpy.mock.calls[1]?.[0] as AuditEntry;
    expect(failAudit.result).toBe("failure");
    expect(failAudit.error).toMatch(/MiniMax/);
  });

  it("14. happy path 完整 → 200 + chunks_inserted + audit success", async () => {
    vi.mocked(requireIngestProxy).mockResolvedValue(makeProxyOk());
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(auditSpy);

    const res = await main(
      makeEvent({
        headers: { "x-ingest-proxy-secret": PROXY_SECRET },
        body: JSON.stringify({
          content: "宝宝断奶建议",
          title: "断奶指南",
          trust_level: 2,
          user_id: "wx-user-002",
        }),
      }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.chunks_inserted).toBe(1);
    expect(body.document_id).toBe("01HNEWID");
    const successAudit = auditSpy.mock.calls[1]?.[0] as AuditEntry;
    expect(successAudit.result).toBe("success");
    expect(successAudit.target.userId).toBe("wx-user-002");
    expect(successAudit.target.sourceId).toBe("01HNEWID");
    expect(successAudit.target.documentId).toBe("01HNEWID");
    expect(successAudit.target.chunksInserted).toBe(1);
    expect(successAudit.request.title).toBe("断奶指南");
    expect(successAudit.request.contentLen).toBe(6);
    expect(successAudit.request.trustLevel).toBe(2);
  });

  // ─── Group 4: IP / dev mode (3) ────────────────────────────────────

  it("15. proxy + IP 不在白名单 → 403 IP_NOT_ALLOWED + 不调 audit", async () => {
    testEnv.ADMIN_IP_ALLOWLIST = "127.0.0.1";
    vi.mocked(requireIngestProxy).mockResolvedValue(
      makeAuthFail(403, "IP_NOT_ALLOWED", "clientIp=8.8.8.8 not in allowlist"),
    );
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(auditSpy);

    const res = await main(
      makeEvent({
        headers: { "x-ingest-proxy-secret": PROXY_SECRET },
        body: JSON.stringify({ content: "测试内容" }),
        clientIp: "8.8.8.8",
      }),
    );

    expect(res.statusCode).toBe(403);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("16. dev mode: INGEST_PROXY_SECRET 未配 + proxy 路径 → 401 INVALID_PROXY", async () => {
    testEnv.INGEST_PROXY_SECRET = undefined;
    vi.mocked(requireIngestProxy).mockResolvedValue(
      makeAuthFail(401, "INVALID_PROXY", "secret not configured"),
    );

    const res = await main(
      makeEvent({
        headers: { "x-ingest-proxy-secret": "any-value" },
        body: JSON.stringify({ content: "测试内容" }),
      }),
    );

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("INVALID_PROXY");
  });

  it("17. dev mode: INGEST_PROXY_SECRET 未配 + admin 路径仍可用", async () => {
    testEnv.INGEST_PROXY_SECRET = undefined;
    vi.mocked(requireIngestProxy).mockResolvedValue(
      makeAuthFail(401, "INVALID_PROXY", "secret not configured"),
    );
    vi.mocked(requireAdmin).mockResolvedValue(makeAdminOk("admin_token"));

    const res = await main(
      makeEvent({
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ content: "测试内容" }),
      }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.chunks_inserted).toBe(1);
  });
});