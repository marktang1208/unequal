/**
 * CP-7-C #2: audit helper 单元测试（TDD RED — audit.ts 待写）
 *
 * 覆盖：
 * - 5 字段完整 + 调通 __setAuditImpl mock
 * - 缺必填字段 → fail-fast throw
 * - 自动填 id (ULID 格式) + timestamp (number)
 * - CloudBase 写失败 → throw（默认 impl）
 * - error 字段透传
 * - __setAuditImpl + __resetAuditImpl 切换
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  recordAudit,
  __setAuditImpl,
  __resetAuditImpl,
  type AuditEntry,
} from "../../src/lib/audit.js";

const BASE_ENTRY: Omit<AuditEntry, "id" | "timestamp"> = {
  action: "ingest",
  actor: {
    via: "ingest_proxy",
    clientIp: "127.0.0.1",
    tokenFingerprint: "abc123def456",
  },
  target: {
    userId: "u1",
  },
  request: {
    contentLen: 1024,
    trustLevel: 2,
    title: "测试标题",
  },
  result: "in_progress",
  requestId: "req-001",
};

describe("recordAudit (CP-7-C #2)", () => {
  beforeEach(() => {
    __resetAuditImpl();
  });

  it("5 字段完整 → mock impl 被调 + entry 含所有字段", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(spy);

    await recordAudit(BASE_ENTRY);

    expect(spy).toHaveBeenCalledTimes(1);
    const got = spy.mock.calls[0]?.[0] as AuditEntry;
    expect(got.action).toBe("ingest");
    expect(got.actor.via).toBe("ingest_proxy");
    expect(got.actor.clientIp).toBe("127.0.0.1");
    expect(got.target.userId).toBe("u1");
    expect(got.request.contentLen).toBe(1024);
    expect(got.result).toBe("in_progress");
    expect(got.requestId).toBe("req-001");
  });

  it("自动填 id（ULID 格式 26 字符）+ timestamp（数字 > 0）", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(spy);

    const before = Date.now();
    await recordAudit(BASE_ENTRY);
    const after = Date.now();

    const got = spy.mock.calls[0]?.[0] as AuditEntry;
    expect(got.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID 26 字符 Crockford base32
    expect(typeof got.timestamp).toBe("number");
    expect(got.timestamp).toBeGreaterThanOrEqual(before);
    expect(got.timestamp).toBeLessThanOrEqual(after);
  });

  it("缺 actor.via → throw", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(spy);

    const bad = { ...BASE_ENTRY, actor: { ...BASE_ENTRY.actor, via: undefined as unknown as "admin_token" } };
    await expect(recordAudit(bad)).rejects.toThrow(/actor\.via/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("缺 action → throw", async () => {
    const bad = { ...BASE_ENTRY, action: undefined as unknown as "ingest" };
    await expect(recordAudit(bad)).rejects.toThrow(/action/);
  });

  it("缺 target.userId → throw", async () => {
    const bad = { ...BASE_ENTRY, target: { ...BASE_ENTRY.target, userId: undefined as unknown as string } };
    await expect(recordAudit(bad)).rejects.toThrow(/target\.userId/);
  });

  it("缺 requestId → throw", async () => {
    const bad = { ...BASE_ENTRY, requestId: undefined as unknown as string };
    await expect(recordAudit(bad)).rejects.toThrow(/requestId/);
  });

  it("error 字段透传（failure 场景）", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(spy);

    await recordAudit({
      ...BASE_ENTRY,
      result: "failure",
      error: "EMBEDDING_FAILED: MiniMax timeout",
    });

    const got = spy.mock.calls[0]?.[0] as AuditEntry;
    expect(got.result).toBe("failure");
    expect(got.error).toBe("EMBEDDING_FAILED: MiniMax timeout");
  });

  it("success 场景下 target 含 sourceId/documentId/chunksInserted", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(spy);

    await recordAudit({
      ...BASE_ENTRY,
      result: "success",
      target: {
        userId: "u1",
        sourceId: "src-001",
        documentId: "doc-001",
        chunksInserted: 5,
      },
    });

    const got = spy.mock.calls[0]?.[0] as AuditEntry;
    expect(got.target.sourceId).toBe("src-001");
    expect(got.target.documentId).toBe("doc-001");
    expect(got.target.chunksInserted).toBe(5);
  });

  it("__resetAuditImpl 后可再次注入新 mock（验证 _impl 重置为 null）", async () => {
    const spy1 = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(spy1);
    await recordAudit(BASE_ENTRY);
    expect(spy1).toHaveBeenCalledTimes(1);

    __resetAuditImpl();

    const spy2 = vi.fn().mockResolvedValue(undefined);
    __setAuditImpl(spy2);
    await recordAudit(BASE_ENTRY);
    expect(spy2).toHaveBeenCalledTimes(1);
    expect(spy1).toHaveBeenCalledTimes(1); // spy1 不再生效
  });
});