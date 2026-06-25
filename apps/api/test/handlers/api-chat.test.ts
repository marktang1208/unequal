/**
 * api-chat handler 单元测试 — CP-7-B + P5 v1.3 NLI
 *
 * - CP-7-B: parseAnswerSegments 纯函数测
 * - P5 v1.3: handler 后置插入 NLI 验证（短 skip / 长 pass / 长 reject / timeout / runtime_error / 持久化 / sessionId / jwt）
 *
 * api-chat handler 强依赖 CloudBase DB + MiniMax embedding/chat + NLI HTTP。
 * 端到端测试由 admin ChatSim + minipgm 真接覆盖。
 * 本测试通过 mock fetch + db + verifyJwt + audit + NLI provider 测核心逻辑。
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { parseAnswerSegments } from "../../src/handlers/api-chat.js";

// ==================== CP-7-B: parseAnswerSegments 纯函数测 ====================

describe("api-chat [N] 解析 (CP-7-B)", () => {
  it("happy: [1][3] → citedNums=[1,3]", () => {
    const r = parseAnswerSegments("宝宝发烧可能由病毒感染引起 [1] [2]。建议多喝水。", 5);
    expect(r.citedNums).toEqual([1, 2]);
  });

  it("happy: 全引 [1][2][3][4][5] → citedNums=[1,2,3,4,5]", () => {
    const r = parseAnswerSegments("答案 [1][2][3][4][5]", 5);
    expect(r.citedNums).toEqual([1, 2, 3, 4, 5]);
  });

  it("越界 [9] (top=5) → citedNums=[9] 但 rawNums=[9]（caller 过滤越界）", () => {
    const r = parseAnswerSegments("答案 [9]", 5);
    expect(r.citedNums).toEqual([9]);
    expect(r.rawNums).toEqual([9]);
  });

  it("重复 [1][1][1] → citedNums=[1]（去重）", () => {
    const r = parseAnswerSegments("引用 [1][1][1] 又 [1]", 5);
    expect(r.citedNums).toEqual([1]);
  });

  it("0 个 → citedNums=[]", () => {
    const r = parseAnswerSegments("答案没有任何引用。", 5);
    expect(r.citedNums).toEqual([]);
  });

  it("乱序 [3][1] → citedNums=[3,1]（保持出现顺序）", () => {
    const r = parseAnswerSegments("先 [3] 再 [1]", 5);
    expect(r.citedNums).toEqual([3, 1]);
  });

  it("混合: 文字 + [2] + 文字 + [4]", () => {
    const r = parseAnswerSegments("前面 [2] 中间 [4]", 5);
    expect(r.citedNums).toEqual([2, 4]);
  });

  it("top=0: 任何 [N] 都越界", () => {
    const r = parseAnswerSegments("答案 [1]", 0);
    expect(r.rawNums).toEqual([1]);
    expect(r.citedNums).toEqual([1]);
  });

  it("非数字内容 [abc] 不解析", () => {
    const r = parseAnswerSegments("答案 [abc] [1]", 5);
    expect(r.citedNums).toEqual([1]);
  });
});

// ==================== P5 v1.3: NLI 后置插入 handler 测 ====================

// mock CloudBase DB（add/update/whereQuery/getById/newId）
vi.mock("../../src/lib/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/db.js")>();
  return {
    ...actual,
    add: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    whereQuery: vi.fn(),
    getById: vi.fn(),
    newId: vi.fn(() => "01K_SESSION_TEST"),
  };
});

// mock NLI provider + recordNliFailure/Success
// 注:vi.mock factory 会被 hoist,factory 内 vi.fn() 在每个 case beforeEach 里通过
//   vi.mocked() 拿到并赋给外部引用,避免 hoist 顺序问题
vi.mock("../../src/lib/nli/get-provider.js", () => {
  const verifyFn = vi.fn();
  const successFn = vi.fn();
  const failureFn = vi.fn();
  // 把引用挂到 globalThis,test beforeEach 里取出来
  (globalThis as any).__mockNliVerify = verifyFn;
  (globalThis as any).__mockNliSuccess = successFn;
  (globalThis as any).__mockNliFailure = failureFn;
  return {
    getProvider: () => Promise.resolve({ verify: verifyFn, name: "mock-nli" }),
    recordNliSuccess: successFn,
    recordNliFailure: failureFn,
  };
});

let mockProviderVerify: ReturnType<typeof vi.fn>;
let mockRecordNliSuccess: ReturnType<typeof vi.fn>;
let mockRecordNliFailure: ReturnType<typeof vi.fn>;

import { main as chatMain } from "../../src/handlers/api-chat.js";
import * as db from "../../src/lib/db.js";
import { loadEnvForTest, resetEnv } from "../../src/lib/env.js";
import { resetProviders } from "../../src/lib/llm-provider.js";
import { __setAuditImpl, __resetAuditImpl } from "../../src/lib/audit.js";
import { signJwt } from "../../src/lib/jwt.js";
import { NliTimeoutError, NliRuntimeError } from "../../src/lib/nli/errors.js";

const JWT_SECRET = "jwt-secret-32-bytes-min-aaaaaaaaa";
const MOCK_USER = "u1";
const MOCK_SESSION_ID = "01K_SESSION_TEST";

const MOCK_CHUNK_1 = {
  _id: "01K_CHUNK_1",
  id: "01K_CHUNK_1",
  documentId: "01K_DOC_1",
  sourceId: "01K_SRC_1",
  userId: MOCK_USER,
  idx: 0,
  content: "宝宝 6 个月开始可以尝试断奶过渡，循序渐进最关键。",
  embedding: new Array(1536).fill(0.99),
  tokenCount: 20,
  trustLevel: 2,
  createdAt: 1000,
};
const MOCK_CHUNK_2 = {
  ...MOCK_CHUNK_1,
  _id: "01K_CHUNK_2",
  id: "01K_CHUNK_2",
  content: "断奶期间需要保证每天 500ml 奶量。",
};
const MOCK_DOC_1 = {
  _id: "01K_DOC_1",
  id: "01K_DOC_1",
  sourceId: "01K_SRC_1",
  userId: MOCK_USER,
  title: "宝宝断奶指南",
  rawPath: "https://example.com/weaning",
  createdAt: 1000,
};

async function makeUserToken(): Promise<string> {
  return signJwt({ userId: MOCK_USER, scope: "user", secret: JWT_SECRET });
}

function makeEvent(body: unknown, token: string): Parameters<typeof chatMain>[0] {
  return {
    httpMethod: "POST",
    path: "/api-chat",
    headers: {
      authorization: `Bearer ${token}`,
      "x-real-ip": "127.0.0.1",
    },
    body: JSON.stringify(body),
    queryString: {},
    isBase64Encoded: false,
  } as unknown as Parameters<typeof chatMain>[0];
}

describe("api-chat handler NLI (P5 v1.3)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let auditSpy: ReturnType<typeof vi.fn>;
  let userToken: string;

  beforeEach(async () => {
    resetEnv();
    resetProviders();
    userToken = await makeUserToken();

    // 取 factory 内创建的 vi.fn() 引用
    mockProviderVerify = (globalThis as any).__mockNliVerify;
    mockRecordNliSuccess = (globalThis as any).__mockNliSuccess;
    mockRecordNliFailure = (globalThis as any).__mockNliFailure;

    loadEnvForTest({
      ADMIN_TOKEN: "x",
      JWT_SECRET,
      MINIMAX_API_KEY: "sk-test",
      KEK_SECRET_V1: "kek-secret-32-bytes-min-aaaaaaaaa",
      ENVIRONMENT: "production",
      ALLOWED_ORIGIN: "*",
      ADMIN_IP_ALLOWLIST: "127.0.0.1,::1",
      MINIMAX_BASE_URL: "https://api.test/v1",
      DEFAULT_USER_ID: MOCK_USER,
      KEK_CURRENT_VERSION: "1",
      SILICONFLOW_API_KEY: "sk-siliconflow-test",
      SILICONFLOW_BASE_URL: "https://api.siliconflow.test/v1",
      NLI_MODEL: "Qwen/Qwen2.5-7B-Instruct",
      NLI_PROVIDER: "noop",  // 默认 noop,各 case 覆盖
    });

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // 默认 chunk + document mock（top-5 → 实际 2 个 chunk）
    vi.mocked(db.whereQuery).mockImplementation(async (coll: string) => {
      if (coll === "chunk") return [MOCK_CHUNK_1, MOCK_CHUNK_2] as any;
      return [];
    });
    vi.mocked(db.getById).mockImplementation(async (coll: string, id: string) => {
      if (coll === "document" && id === "01K_DOC_1") return MOCK_DOC_1 as any;
      if (coll === "chatSession") return null;  // 模拟新 session
      return null;
    });

    auditSpy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(auditSpy);

    // 重置 NLI mock
    mockProviderVerify.mockReset();
    mockRecordNliSuccess.mockReset();
    mockRecordNliFailure.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    __resetAuditImpl();
  });

  // --- helper: 默认 fetch mock（embed + chat 都返） ---
  function mockEmbedAndChat(chatContent: string) {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ vectors: [new Array(1536).fill(0.99)] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: chatContent } }] }),
      } as Response);
  }

  // -------- 1. 短答案 skip NLI --------
  it("v1.3-1: 短答案（< 100 字符）skip NLI + 不写 audit + 持久化原 answer", async () => {
    // 短答案 ~30 字符（去 [N] 后 < 100）
    mockEmbedAndChat("宝宝发烧 38.5 度,需要观察 [1]。");

    const ev = makeEvent({ q: "5月宝宝发烧" }, userToken);
    const res = await chatMain(ev);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.answer).toBe("宝宝发烧 38.5 度,需要观察 [1]。");

    // NLI 不调
    expect(mockProviderVerify).not.toHaveBeenCalled();
    expect(mockRecordNliSuccess).not.toHaveBeenCalled();
    expect(mockRecordNliFailure).not.toHaveBeenCalled();
    // audit 不写
    expect(auditSpy).not.toHaveBeenCalled();
    // 持久化原 answer（add 或 update 调 1 次）
    const totalPersistCalls = vi.mocked(db.add).mock.calls.length + vi.mocked(db.update).mock.calls.length;
    expect(totalPersistCalls).toBeGreaterThanOrEqual(1);
    // 持久化内容含原 answer（无 ⚠️）
    const persistArgs = (vi.mocked(db.add).mock.calls[0]?.[1] ?? vi.mocked(db.update).mock.calls[0]?.[2]) as any;
    expect(persistArgs.messages.at(-1).content).toBe("宝宝发烧 38.5 度,需要观察 [1]。");
    expect(persistArgs.messages.at(-1).content).not.toContain("⚠️");
  });

  // -------- 2. 长答案 NLI pass (entailed) --------
  it("v1.3-2: 长答案 + NLI pass (entailed) → 不写 audit + 原 answer 持久化", async () => {
    // 长答案:cleaned > 100 字符(86 中 + 100 x + [1][2] → cleaned 180 > 100)
    const longAnswer = "宝宝发烧物理降温与药物降温区别:物理降温通过温水擦拭身体,降低体表温度;药物降温使用对乙酰氨基酚等退热药。物理降温副作用小但效果慢;药物降温起效快但有过量风险。" + "x".repeat(100) + "[1][2]";
    mockEmbedAndChat(longAnswer);
    mockProviderVerify.mockResolvedValue({
      verdict: "entailed",
      score: 0.95,
      scores: { entailment: 0.95, neutral: 0.04, contradiction: 0.01 },
      latencyMs: 800,
    });

    const ev = makeEvent({ q: "详细解释发烧物理降温" }, userToken);
    const res = await chatMain(ev);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // NLI 调 1 次,success 调 1 次
    expect(mockProviderVerify).toHaveBeenCalledTimes(1);
    expect(mockRecordNliSuccess).toHaveBeenCalledTimes(1);
    expect(mockRecordNliFailure).not.toHaveBeenCalled();
    // audit 不写（pass）
    expect(auditSpy).not.toHaveBeenCalled();
    // 原 answer,无 ⚠️
    expect(body.answer).not.toContain("⚠️");
    expect(body.answer).toBe(longAnswer);
  });

  // -------- 3. 长答案 NLI reject (neutral) --------
  it("v1.3-3: 长答案 + NLI reject (neutral) → 写 audit chat_nli_reject + answer 含 ⚠️ + 持久化 finalAnswer", async () => {
    const longAnswer = "宝宝发烧 39 度需要立即用抗生素治疗,这是唯一有效的方法 [1][2]。" + "x".repeat(150);
    mockEmbedAndChat(longAnswer);
    mockProviderVerify.mockResolvedValue({
      verdict: "neutral",
      score: 0.7,
      scores: { entailment: 0.2, neutral: 0.7, contradiction: 0.1 },
      latencyMs: 1000,
    });

    const ev = makeEvent({ q: "长问" }, userToken);
    const res = await chatMain(ev);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // NLI 调 1 次,success 调 1 次
    expect(mockProviderVerify).toHaveBeenCalledTimes(1);
    expect(mockRecordNliSuccess).toHaveBeenCalledTimes(1);
    // audit 写 1 次,action = "chat_nli_reject",result = "success"
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const auditEntry = auditSpy.mock.calls[0]?.[0] as any;
    expect(auditEntry.action).toBe("chat_nli_reject");
    expect(auditEntry.result).toBe("success");
    // answer 含 ⚠️ prefix
    expect(body.answer).toContain("⚠️");
    // 持久化 finalAnswer（含 ⚠️）
    const persistArgs = (vi.mocked(db.add).mock.calls[0]?.[1] ?? vi.mocked(db.update).mock.calls[0]?.[2]) as any;
    expect(persistArgs.messages.at(-1).content).toContain("⚠️");
  });

  // -------- 4. NLI timeout --------
  it("v1.3-4: NLI timeout → 写 audit nli_timeout + 无 ⚠️ + 持久化原 answer", async () => {
    const longAnswer = "长答案 " + "x".repeat(200) + " [1]";
    mockEmbedAndChat(longAnswer);
    mockProviderVerify.mockRejectedValue(new NliTimeoutError("timed out"));

    const ev = makeEvent({ q: "长问" }, userToken);
    const res = await chatMain(ev);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // NLI 调 1 次,failure 调 1 次
    expect(mockProviderVerify).toHaveBeenCalledTimes(1);
    expect(mockRecordNliFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordNliSuccess).not.toHaveBeenCalled();
    // audit 写 1 次,error: nli_timeout
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const auditEntry = auditSpy.mock.calls[0]?.[0] as any;
    expect(auditEntry.action).toBe("chat_nli_reject");
    expect(auditEntry.result).toBe("failure");
    expect(auditEntry.error).toBe("nli_timeout");
    // 无 ⚠️
    expect(body.answer).not.toContain("⚠️");
    expect(body.answer).toBe(longAnswer);
  });

  // -------- 5. NLI runtime error --------
  it("v1.3-5: NLI runtime error → 写 audit nli_runtime_error + 无 ⚠️", async () => {
    const longAnswer = "长答案 " + "x".repeat(200) + " [1]";
    mockEmbedAndChat(longAnswer);
    mockProviderVerify.mockRejectedValue(new NliRuntimeError("network fail"));

    const ev = makeEvent({ q: "长问" }, userToken);
    const res = await chatMain(ev);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(mockProviderVerify).toHaveBeenCalledTimes(1);
    expect(mockRecordNliFailure).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const auditEntry = auditSpy.mock.calls[0]?.[0] as any;
    expect(auditEntry.action).toBe("chat_nli_reject");
    expect(auditEntry.result).toBe("failure");
    expect(auditEntry.error).toBe("nli_runtime_error");
    expect(body.answer).not.toContain("⚠️");
  });

  // -------- 6. 持久化 finalAnswer (同 3 的强化) --------
  it("v1.3-6: 持久化 session.messages 中 assistant.content 含 ⚠️ prefix", async () => {
    const longAnswer = "长答案 " + "x".repeat(200) + " [1]";
    mockEmbedAndChat(longAnswer);
    mockProviderVerify.mockResolvedValue({
      verdict: "contradiction",
      score: 0.8,
      scores: { entailment: 0.1, neutral: 0.1, contradiction: 0.8 },
      latencyMs: 1200,
    });

    const ev = makeEvent({ q: "长问" }, userToken);
    await chatMain(ev);

    const persistArgs = (vi.mocked(db.add).mock.calls[0]?.[1] ?? vi.mocked(db.update).mock.calls[0]?.[2]) as any;
    // 最后一条 message 是 assistant,其 content 包含 ⚠️
    const lastMsg = persistArgs.messages.at(-1);
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.content).toContain("⚠️");
  });

  // -------- 7. audit 含 actor.sessionId --------
  it("v1.3-7: audit actor.sessionId = session.id（区别 ask 的 admin_token）", async () => {
    const longAnswer = "长答案 " + "x".repeat(200) + " [1]";
    mockEmbedAndChat(longAnswer);
    mockProviderVerify.mockResolvedValue({
      verdict: "neutral",
      score: 0.7,
      scores: { entailment: 0.2, neutral: 0.7, contradiction: 0.1 },
      latencyMs: 1000,
    });

    const ev = makeEvent({ q: "长问" }, userToken);
    await chatMain(ev);

    const auditEntry = auditSpy.mock.calls[0]?.[0] as any;
    expect(auditEntry.actor.sessionId).toBe(MOCK_SESSION_ID);
  });

  // -------- 8. audit 含 actor.via "jwt" --------
  it("v1.3-8: audit actor.via = \"jwt\"（区别 ask 的 \"admin_token\"）", async () => {
    const longAnswer = "长答案 " + "x".repeat(200) + " [1]";
    mockEmbedAndChat(longAnswer);
    mockProviderVerify.mockResolvedValue({
      verdict: "neutral",
      score: 0.7,
      scores: { entailment: 0.2, neutral: 0.7, contradiction: 0.1 },
      latencyMs: 1000,
    });

    const ev = makeEvent({ q: "长问" }, userToken);
    await chatMain(ev);

    const auditEntry = auditSpy.mock.calls[0]?.[0] as any;
    expect(auditEntry.actor.via).toBe("jwt");
  });
});

// ==================== P9: NLI_ASYNC 灰度分支 ====================
//
// P9 把 P5 v1.3 同步 NLI 改成 setImmediate 异步 + chat response 返 nliTurnId 字段。
// 灰度开关 env.NLI_ASYNC ("1" = async, 其他 = P5 v1.3 sync backward compat)。
//
// 4 个 case:
//  1. NLI_ASYNC=1 + chat 200 → response.nliTurnId 非空 (turnId 格式 `${session_id}:${turn_seq}`)
//  2. NLI_ASYNC=1 + setImmediate 内 NLI runtime_error → audit_log 写 chat_nli_async failure, chat 不抛
//  3. NLI_ASYNC=undefined (默认) → 走 P5 v1.3 sync 路径, response.nliTurnId 为 undefined (backward compat)
//  4. NLI_ASYNC=1 + turnSeq 计数正确 (创 session turnSeq=0, 第 2 轮 turnSeq=1)

describe("api-chat handler NLI_ASYNC (P9)", () => {
  let auditSpy: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let userToken: string;

  beforeEach(async () => {
    resetEnv();
    resetProviders();
    userToken = await makeUserToken();

    mockProviderVerify = (globalThis as any).__mockNliVerify;
    mockRecordNliSuccess = (globalThis as any).__mockNliSuccess;
    mockRecordNliFailure = (globalThis as any).__mockNliFailure;

    // P9 测试用 loadEnvForTest; 每个 case 自行覆盖 NLI_ASYNC / NLI_PROVIDER

    vi.mocked(db.whereQuery).mockImplementation(async (coll: string) => {
      if (coll === "chunk") return [MOCK_CHUNK_1, MOCK_CHUNK_2] as any;
      return [];
    });
    vi.mocked(db.getById).mockImplementation(async (coll: string, id: string) => {
      if (coll === "document" && id === "01K_DOC_1") return MOCK_DOC_1 as any;
      if (coll === "chatSession") return null;  // 默认模拟新 session
      return null;
    });

    auditSpy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(auditSpy);

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockProviderVerify.mockReset();
    mockRecordNliSuccess.mockReset();
    mockRecordNliFailure.mockReset();
  });

  function loadEnvWithAsyncFlag(nliAsync: "0" | "1" | undefined) {
    loadEnvForTest({
      ADMIN_TOKEN: "x",
      JWT_SECRET,
      MINIMAX_API_KEY: "sk-test",
      KEK_SECRET_V1: "kek-secret-32-bytes-min-aaaaaaaaa",
      ENVIRONMENT: "production",
      ALLOWED_ORIGIN: "*",
      ADMIN_IP_ALLOWLIST: "127.0.0.1,::1",
      MINIMAX_BASE_URL: "https://api.test/v1",
      DEFAULT_USER_ID: MOCK_USER,
      KEK_CURRENT_VERSION: "1",
      SILICONFLOW_API_KEY: "sk-siliconflow-test",
      SILICONFLOW_BASE_URL: "https://api.siliconflow.test/v1",
      NLI_MODEL: "Qwen/Qwen2.5-7B-Instruct",
      NLI_PROVIDER: "noop",  // 默认 noop,各 case 覆盖
      ...(nliAsync === undefined ? {} : { NLI_ASYNC: nliAsync }),
    });
  }

  // helper: 默认 fetch mock（embed + chat 都返）
  function mockEmbedAndChat(chatContent: string) {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ vectors: [new Array(1536).fill(0.99)] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: chatContent } }] }),
      } as Response);
  }

  // 等 setImmediate 内 promise 跑完 (chat response 返后, NLI async 任务仍在跑)
  async function flushSetImmediate() {
    // 多次 flush 保证 setImmediate + 后续 microtasks (provider.verify + recordAudit) 都跑完
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  // -------- 1. NLI_ASYNC=1 + chat 200 → response.nliTurnId 非空 --------
  it("P9-1: NLI_ASYNC=1 + chat 200 → response.nliTurnId 非空 (turnId 格式 `${session_id}:${turn_seq}`)", async () => {
    loadEnvWithAsyncFlag("1");
    const longAnswer = "长答案 " + "x".repeat(200) + " [1]";
    mockEmbedAndChat(longAnswer);
    mockProviderVerify.mockResolvedValue({
      verdict: "entailed",
      score: 0.95,
      scores: { entailment: 0.95, neutral: 0.04, contradiction: 0.01 },
      latencyMs: 800,
    });

    const ev = makeEvent({ q: "长问" }, userToken);
    const res = await chatMain(ev);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // 关键 P9 断言: response.nliTurnId 非空且格式正确
    expect(body.nliTurnId).toBeDefined();
    expect(body.nliTurnId).not.toBeNull();
    expect(body.nliTurnId).toMatch(/^01K_SESSION_TEST:0$/);
    // 新 session 没 assistant msg, turnSeq=0

    // 异步 NLI 任务跑完后, audit 写 1 次 chat_nli_async success
    await flushSetImmediate();
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const auditEntry = auditSpy.mock.calls[0]?.[0] as any;
    expect(auditEntry.action).toBe("chat_nli_async");
    expect(auditEntry.result).toBe("success");
    expect(auditEntry.nliSnapshot.turnId).toBe(body.nliTurnId);
    expect(auditEntry.nliSnapshot.reason).toBe("async");
    expect(auditEntry.nliSnapshot.verdict).toBe("entailed");
  });

  // -------- 2. NLI_ASYNC=1 + setImmediate 内 NLI runtime_error → audit_log 写 failure, chat 不抛 --------
  it("P9-2: NLI_ASYNC=1 + setImmediate 内 NLI runtime_error → audit_log 写 chat_nli_async failure, chat 不抛", async () => {
    loadEnvWithAsyncFlag("1");
    const longAnswer = "长答案 " + "x".repeat(200) + " [1]";
    mockEmbedAndChat(longAnswer);
    mockProviderVerify.mockRejectedValue(new NliRuntimeError("network fail"));

    const ev = makeEvent({ q: "长问" }, userToken);
    const res = await chatMain(ev);

    // chat 仍 200, 不抛 (setImmediate 不影响主路径)
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.nliTurnId).toMatch(/^01K_SESSION_TEST:0$/);
    // answer 不含 ⚠️ (warning 移到轮询 verdict, async 路径不 apply prefix)
    expect(body.answer).not.toContain("⚠️");
    expect(body.answer).toBe(longAnswer);

    // 等 setImmediate 内 catch 跑完, audit 写 1 次 chat_nli_async failure
    await flushSetImmediate();
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const auditEntry = auditSpy.mock.calls[0]?.[0] as any;
    expect(auditEntry.action).toBe("chat_nli_async");
    expect(auditEntry.result).toBe("failure");
    expect(auditEntry.error).toBeDefined();
    expect(auditEntry.nliSnapshot.turnId).toBe(body.nliTurnId);
    expect(auditEntry.nliSnapshot.reason).toBe("runtime_error");
    expect(auditEntry.nliSnapshot.verdict).toBe("neutral");
    expect(auditEntry.nliSnapshot.score).toBe(0);
  });

  // -------- 3. NLI_ASYNC=undefined (默认) → 走 P5 v1.3 sync 路径, response.nliTurnId 为 undefined (backward compat) --------
  it("P9-3: NLI_ASYNC=undefined (默认) → 走 P5 v1.3 sync 路径, response.nliTurnId 为 undefined (backward compat)", async () => {
    loadEnvWithAsyncFlag(undefined);  // default
    const longAnswer = "长答案 " + "x".repeat(200) + " [1]";
    mockEmbedAndChat(longAnswer);
    mockProviderVerify.mockResolvedValue({
      verdict: "neutral",
      score: 0.7,
      scores: { entailment: 0.2, neutral: 0.7, contradiction: 0.1 },
      latencyMs: 1000,
    });

    const ev = makeEvent({ q: "长问" }, userToken);
    const res = await chatMain(ev);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // 关键 P9 断言: sync 路径不返 nliTurnId (backward compat)
    expect(body.nliTurnId).toBeUndefined();

    // sync 路径仍按 P5 v1.3 行为: reject → 写 audit chat_nli_reject + answer 含 ⚠️
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const auditEntry = auditSpy.mock.calls[0]?.[0] as any;
    expect(auditEntry.action).toBe("chat_nli_reject");  // sync 旧 action
    expect(auditEntry.result).toBe("success");
    expect(body.answer).toContain("⚠️");
  });

  // -------- 4. NLI_ASYNC=1 + turnSeq 计数正确 (创 session turnSeq=0, 第 2 轮 turnSeq=1) --------
  it("P9-4: NLI_ASYNC=1 + turnSeq 计数正确 (创 session turnSeq=0, 第 2 轮 turnSeq=1)", async () => {
    loadEnvWithAsyncFlag("1");

    // 第 1 轮: 新 session, getById(chatSession) → null → 创 session
    const longAnswer1 = "第一轮长答案 " + "x".repeat(200) + " [1]";
    mockEmbedAndChat(longAnswer1);
    mockProviderVerify.mockResolvedValue({
      verdict: "entailed",
      score: 0.95,
      scores: { entailment: 0.95, neutral: 0.04, contradiction: 0.01 },
      latencyMs: 800,
    });

    const ev1 = makeEvent({ q: "第一轮" }, userToken);
    const res1 = await chatMain(ev1);
    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1.nliTurnId).toBe("01K_SESSION_TEST:0");

    // 等第 1 轮 async audit 写完
    await flushSetImmediate();
    const auditCountAfterFirst = auditSpy.mock.calls.length;

    // 第 2 轮: 同 session (session.id 已被 newId mock 固定为 01K_SESSION_TEST)
    // 让 db.getById(chatSession) 返第 1 轮持久化的 session (含 1 条 assistant msg)
    const persistedSession = {
      _id: MOCK_SESSION_ID,
      id: MOCK_SESSION_ID,
      userId: MOCK_USER,
      title: "第一轮",
      messages: [
        { role: "user", content: "第一轮", createdAt: 1000 },
        {
          role: "assistant",
          content: longAnswer1,
          retrievedChunkIds: [MOCK_CHUNK_1._id],
          nliTurnId: "01K_SESSION_TEST:0",
          createdAt: 1000,
        },
      ],
      createdAt: 1000,
      updatedAt: 1000,
    };
    vi.mocked(db.getById).mockImplementation(async (coll: string, id: string) => {
      if (coll === "document" && id === "01K_DOC_1") return MOCK_DOC_1 as any;
      // CloudBase collection 名是 "chat_session" (snake_case), not "chatSession"
      if (coll === "chat_session" && id === MOCK_SESSION_ID) return persistedSession as any;
      return null;
    });

    const longAnswer2 = "第二轮长答案 " + "x".repeat(200) + " [1]";
    mockEmbedAndChat(longAnswer2);
    mockProviderVerify.mockResolvedValue({
      verdict: "entailed",
      score: 0.95,
      scores: { entailment: 0.95, neutral: 0.04, contradiction: 0.01 },
      latencyMs: 800,
    });

    const ev2 = makeEvent({ q: "第二轮", session_id: MOCK_SESSION_ID }, userToken);
    const res2 = await chatMain(ev2);
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);

    // 关键 P9 断言: 第 2 轮 turnId = `${session_id}:1` (因为 session 已有 1 条 assistant msg, turnSeq=1)
    expect(body2.nliTurnId).toBe("01K_SESSION_TEST:1");

    // 等第 2 轮 async audit 写完, 验 audit 又 +1 次
    await flushSetImmediate();
    expect(auditSpy.mock.calls.length).toBe(auditCountAfterFirst + 1);
    const audit2 = auditSpy.mock.calls[auditSpy.mock.calls.length - 1]?.[0] as any;
    expect(audit2.nliSnapshot.turnId).toBe("01K_SESSION_TEST:1");
  });
});
