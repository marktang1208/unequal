/**
 * api-nli-result handler 单测 (P9 Phase 1)
 *
 * GET /api-nli-result?turnId=<id> polling 端点
 *
 * 覆盖：
 *  1. JWT 缺 → 401 AUTH_FAILED
 *  2. JWT scope = admin (≠ user) → 401 AUTH_FAILED
 *  3. turnId 格式非法 (不含 `:`) → 400 INVALID_REQUEST
 *  4. turnId 合法 + audit_log 命中 → 200 + {found: true, verdict, score, latencyMs, isWarning}
 *  5. turnId 合法 + audit_log 未命中 → 200 + {found: false} (让 client 继续轮询)
 *  6. verdict=entailed + score=0.9 → isWarning=false
 *  7. verdict=contradiction + score=0.3 → isWarning=true (P5 v1.3 阈值 0.5)
 *  8. verdict=neutral + score=0.4 → isWarning=true
 *  9. (额外) verdict=contradiction + score=0.6 → isWarning=false (score ≥ 0.5)
 * 10. (额外) verdict=entailed + score=0.2 → isWarning=false (entailed 不警告)
 * 11. (额外) audit_log 多 record (找第 1 个匹配 turnId)
 * 12. (额外) turnId 含特殊字符 → 400 INVALID_REQUEST
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/db.js", () => ({
  COLLECTIONS: { auditLog: "audit_log" },
  whereQuery: vi.fn(),
  getById: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  count: vi.fn(),
  newId: vi.fn(() => "01HNEWID"),
  getAllByFilter: vi.fn(),
}));

vi.mock("../../lib/env.js", () => ({
  getEnv: () => ({
    JWT_SECRET: "test-jwt-secret-must-be-32-bytes-long-aaaaaaaaaa",
    ALLOWED_ORIGIN: "*",
  }),
}));

import { whereQuery } from "../../lib/db.js";
import { main } from "../api-nli-result.js";
import { signJwt } from "../../lib/jwt.js";
import type { HttpTriggerEvent } from "../../lib/handler-utils.js";

const SECRET = "test-jwt-secret-must-be-32-bytes-long-aaaaaaaaaa";
const VALID_TURN_ID = "NGEVQYJH:0";

function makeEvent(opts: {
  method?: string;
  authHeader?: string;
  turnId?: string;
}): HttpTriggerEvent {
  const headers: Record<string, string> = {};
  if (opts.authHeader !== undefined) {
    headers.authorization = opts.authHeader;
  }
  return {
    httpMethod: opts.method ?? "GET",
    path: "/api-nli-result",
    headers,
    queryString: opts.turnId !== undefined ? { turnId: opts.turnId } : {},
    body: null,
    isBase64Encoded: false,
  };
}

async function makeJwt(scope: "user" | "admin" = "user"): Promise<string> {
  return signJwt({ userId: "01HUSER001", scope, secret: SECRET });
}

describe("api-nli-result polling (P9 Phase 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. JWT 缺 → 401 AUTH_FAILED", async () => {
    const res = await main(makeEvent({ authHeader: "" }));
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("AUTH_FAILED");
  });

  it("2. JWT scope = admin (≠ user) → 401 AUTH_FAILED", async () => {
    const adminJwt = await makeJwt("admin");
    const res = await main(makeEvent({ authHeader: `Bearer ${adminJwt}` }));
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("AUTH_FAILED");
  });

  it("3. turnId 格式非法 (不含 `:`) → 400 INVALID_REQUEST", async () => {
    const jwt = await makeJwt("user");
    const res = await main(
      makeEvent({ authHeader: `Bearer ${jwt}`, turnId: "INVALID" }),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("INVALID_REQUEST");
  });

  it("4. turnId 合法 + audit_log 命中 → 200 + {found: true, verdict, score, latencyMs, isWarning}", async () => {
    const jwt = await makeJwt("user");
    vi.mocked(whereQuery).mockResolvedValue([
      {
        _id: "audit1",
        action: "chat_nli_async",
        nliSnapshot: {
          turnId: VALID_TURN_ID,
          verdict: "entailed",
          score: 0.9,
          latencyMs: 1234,
        },
      },
    ] as unknown as Awaited<ReturnType<typeof whereQuery>>);

    const res = await main(
      makeEvent({ authHeader: `Bearer ${jwt}`, turnId: VALID_TURN_ID }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.found).toBe(true);
    expect(body.verdict).toBe("entailed");
    expect(body.score).toBe(0.9);
    expect(body.latencyMs).toBe(1234);
    expect(body.isWarning).toBe(false);
  });

  it("5. turnId 合法 + audit_log 未命中 → 200 + {found: false}", async () => {
    const jwt = await makeJwt("user");
    vi.mocked(whereQuery).mockResolvedValue([]);

    const res = await main(
      makeEvent({ authHeader: `Bearer ${jwt}`, turnId: VALID_TURN_ID }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.found).toBe(false);
  });

  it("6. verdict=entailed + score=0.9 → isWarning=false", async () => {
    const jwt = await makeJwt("user");
    vi.mocked(whereQuery).mockResolvedValue([
      {
        _id: "audit1",
        action: "chat_nli_async",
        nliSnapshot: { turnId: VALID_TURN_ID, verdict: "entailed", score: 0.9, latencyMs: 500 },
      },
    ] as unknown as Awaited<ReturnType<typeof whereQuery>>);

    const res = await main(
      makeEvent({ authHeader: `Bearer ${jwt}`, turnId: VALID_TURN_ID }),
    );
    const body = JSON.parse(res.body);
    expect(body.found).toBe(true);
    expect(body.verdict).toBe("entailed");
    expect(body.isWarning).toBe(false);
  });

  it("7. verdict=contradiction + score=0.3 → isWarning=true (P5 v1.3 阈值 0.5)", async () => {
    const jwt = await makeJwt("user");
    vi.mocked(whereQuery).mockResolvedValue([
      {
        _id: "audit1",
        action: "chat_nli_async",
        nliSnapshot: { turnId: VALID_TURN_ID, verdict: "contradiction", score: 0.3, latencyMs: 800 },
      },
    ] as unknown as Awaited<ReturnType<typeof whereQuery>>);

    const res = await main(
      makeEvent({ authHeader: `Bearer ${jwt}`, turnId: VALID_TURN_ID }),
    );
    const body = JSON.parse(res.body);
    expect(body.found).toBe(true);
    expect(body.verdict).toBe("contradiction");
    expect(body.score).toBe(0.3);
    expect(body.isWarning).toBe(true);
  });

  it("8. verdict=neutral + score=0.4 → isWarning=true", async () => {
    const jwt = await makeJwt("user");
    vi.mocked(whereQuery).mockResolvedValue([
      {
        _id: "audit1",
        action: "chat_nli_async",
        nliSnapshot: { turnId: VALID_TURN_ID, verdict: "neutral", score: 0.4, latencyMs: 600 },
      },
    ] as unknown as Awaited<ReturnType<typeof whereQuery>>);

    const res = await main(
      makeEvent({ authHeader: `Bearer ${jwt}`, turnId: VALID_TURN_ID }),
    );
    const body = JSON.parse(res.body);
    expect(body.found).toBe(true);
    expect(body.verdict).toBe("neutral");
    expect(body.score).toBe(0.4);
    expect(body.isWarning).toBe(true);
  });

  it("9. (额外) verdict=contradiction + score=0.6 → isWarning=false (score ≥ 0.5)", async () => {
    const jwt = await makeJwt("user");
    vi.mocked(whereQuery).mockResolvedValue([
      {
        _id: "audit1",
        action: "chat_nli_async",
        nliSnapshot: { turnId: VALID_TURN_ID, verdict: "contradiction", score: 0.6, latencyMs: 500 },
      },
    ] as unknown as Awaited<ReturnType<typeof whereQuery>>);

    const res = await main(
      makeEvent({ authHeader: `Bearer ${jwt}`, turnId: VALID_TURN_ID }),
    );
    const body = JSON.parse(res.body);
    expect(body.isWarning).toBe(false);
  });

  it("10. (额外) verdict=entailed + score=0.2 → isWarning=false (entailed 不警告)", async () => {
    const jwt = await makeJwt("user");
    vi.mocked(whereQuery).mockResolvedValue([
      {
        _id: "audit1",
        action: "chat_nli_async",
        nliSnapshot: { turnId: VALID_TURN_ID, verdict: "entailed", score: 0.2, latencyMs: 500 },
      },
    ] as unknown as Awaited<ReturnType<typeof whereQuery>>);

    const res = await main(
      makeEvent({ authHeader: `Bearer ${jwt}`, turnId: VALID_TURN_ID }),
    );
    const body = JSON.parse(res.body);
    expect(body.isWarning).toBe(false);
  });

  it("11. (额外) audit_log 多 record (找第 1 个匹配 turnId)", async () => {
    const jwt = await makeJwt("user");
    // 多 record: 第 1 个不同 turnId, 第 2 个匹配
    vi.mocked(whereQuery).mockResolvedValue([
      {
        _id: "audit1",
        action: "chat_nli_async",
        nliSnapshot: { turnId: "OTHERID:0", verdict: "entailed", score: 0.9, latencyMs: 100 },
      },
      {
        _id: "audit2",
        action: "chat_nli_async",
        nliSnapshot: { turnId: VALID_TURN_ID, verdict: "neutral", score: 0.4, latencyMs: 200 },
      },
    ] as unknown as Awaited<ReturnType<typeof whereQuery>>);

    const res = await main(
      makeEvent({ authHeader: `Bearer ${jwt}`, turnId: VALID_TURN_ID }),
    );
    const body = JSON.parse(res.body);
    expect(body.found).toBe(true);
    expect(body.verdict).toBe("neutral");
    expect(body.score).toBe(0.4);
    expect(body.isWarning).toBe(true);
  });

  it("12. (额外) turnId 含特殊字符 → 400 INVALID_REQUEST", async () => {
    const jwt = await makeJwt("user");
    // XSS 注入: 含 ; 与 <script>
    const res = await main(
      makeEvent({ authHeader: `Bearer ${jwt}`, turnId: "ABC<script>:0" }),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("INVALID_REQUEST");
  });

  it("13. OPTIONS 预检 → 204", async () => {
    const res = await main(makeEvent({ method: "OPTIONS" }));
    expect(res.statusCode).toBe(204);
  });
});