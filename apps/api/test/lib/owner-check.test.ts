/**
 * M7-C: owner-check helper 单测
 *
 * 验证：
 * 1. 同 userId → ok=true，继续
 * 2. 不同 userId → ok=false + 401 + audit_log recordAudit(result=denied)
 * 3. audit 失败不阻塞 401（defense in depth）
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { assertOwner } from "../../src/lib/owner-check.js";
import { __resetAuditImpl, __setAuditImpl } from "../../src/lib/audit.js";

describe("assertOwner M7-C", () => {
  let auditCalls: any[] = [];

  beforeEach(() => {
    auditCalls = [];
    __setAuditImpl(async (entry) => {
      auditCalls.push(entry);
    });
  });

  afterEach(() => {
    __resetAuditImpl();
  });

  it("happy: userId 匹配 → ok=true", async () => {
    const result = await assertOwner({
      resource: { userId: "u1", _id: "res1" },
      currentUserId: "u1",
      resourceType: "chat_session",
      action: "session_rename",
    });
    expect(result.ok).toBe(true);
    expect(auditCalls).toHaveLength(0); // 成功不 audit
  });

  it("denied: userId 不匹配 → ok=false + 401 UNAUTHORIZED", async () => {
    const result = await assertOwner({
      resource: { userId: "u_owner", _id: "res1" },
      currentUserId: "u_attacker",
      resourceType: "chat_session",
      action: "session_rename",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return; // type narrow
    expect(result.response.statusCode).toBe(401);
    const body = JSON.parse(result.response.body);
    expect(body.error).toBe("UNAUTHORIZED");
  });

  it("denied: 写 1 条 audit_log (result=denied, actor=currentUser, target=resource)", async () => {
    await assertOwner({
      resource: { userId: "u_owner", _id: "res_target" },
      currentUserId: "u_attacker",
      resourceType: "chat_session",
      action: "session_rename",
    });

    expect(auditCalls).toHaveLength(1);
    const e = auditCalls[0];
    expect(e.action).toBe("session_rename");
    expect(e.result).toBe("denied");
    expect(e.actor.via).toBe("jwt_user");
    expect(e.actor.userId).toBe("u_attacker");
    expect(e.target.userId).toBe("u_owner");
    expect(e.target.resourceId).toBe("res_target");
    expect(e.target.resourceType).toBe("chat_session");
  });

  it("audit 写失败 → 仍返 401（defense in depth）", async () => {
    __setAuditImpl(async () => {
      throw new Error("audit collection down");
    });

    const result = await assertOwner({
      resource: { userId: "u_owner", _id: "res1" },
      currentUserId: "u_attacker",
      resourceType: "user",
      action: "nickname_update",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.statusCode).toBe(401);
  });

  it("clientIp 透传到 audit.actor", async () => {
    await assertOwner({
      resource: { userId: "u_owner", _id: "r1" },
      currentUserId: "u_attacker",
      resourceType: "document",
      action: "session_rename",
      actor: { clientIp: "203.0.113.42" },
    });
    expect(auditCalls[0].actor.clientIp).toBe("203.0.113.42");
  });
});
