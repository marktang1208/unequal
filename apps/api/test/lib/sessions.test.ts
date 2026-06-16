/**
 * M6.1 lib/sessions.ts 测试套件（spec §3.3）。
 *
 * spy-style fake D1 + 预设 handler，让 10 个用例在 ms 级跑完。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { listSessions, getSession, renameSession, deleteSession } from "../../src/lib/sessions.js";
import { HttpError } from "../../src/lib/auth.js";

/* ---------- spy-style fake D1（与 chat.test.ts 同模式） ---------- */

type D1Handler = (params: unknown[]) => Promise<unknown>;
interface D1Call { sql: string; params: unknown[]; op: "first" | "all" | "run" }

function makeFakeDB(handlers: { first?: D1Handler; all?: D1Handler; run?: D1Handler } = {}) {
  const calls: D1Call[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => {
        const record = (op: D1Call["op"]): D1Call => ({ sql, params, op });
        return {
          first: async <T>(): Promise<T | null> => {
            calls.push(record("first"));
            if (handlers.first) return (await handlers.first(params)) as T;
            return null;
          },
          all: async <T>(): Promise<{ results: T[] }> => {
            calls.push(record("all"));
            if (handlers.all) return (await handlers.all(params)) as { results: T[] };
            return { results: [] };
          },
          run: async (): Promise<void> => {
            calls.push(record("run"));
            if (handlers.run) await handlers.run(params);
          },
        };
      },
    }),
  };
  return { db: db as unknown as D1Database, calls };
}

const now = 1_700_000_000_000;
const SAMPLE_ROWS = [
  { id: "01HAAAAAAAAAAAA0000000001", user_id: "u1", title: "宝宝发烧", created_at: now - 3000, last_active_at: now - 100, degraded_at: null },
  { id: "01HAAAAAAAAAAAA0000000002", user_id: "u1", title: "辅食添加", created_at: now - 5000, last_active_at: now - 300, degraded_at: null },
  { id: "01HAAAAAAAAAAAA0000000003", user_id: "u1", title: null, created_at: now - 2000, last_active_at: now - 50, degraded_at: null },
];

describe("lib/sessions (spy-style fake D1)", () => {
  let fakeDB: ReturnType<typeof makeFakeDB>;
  let d1: D1Database;

  beforeEach(() => {
    fakeDB = makeFakeDB();
    d1 = fakeDB.db;
  });

  /* ---- 1. listSessions 排序 ---- */
  it("listSessions: 按 last_active_at DESC + 返 [{...}]", async () => {
    fakeDB = makeFakeDB({ all: async () => ({ results: SAMPLE_ROWS }) });
    d1 = fakeDB.db;
    const got = await listSessions(d1, "u1");
    expect(got).toHaveLength(3);
    expect(got[0]!.id).toBe("01HAAAAAAAAAAAA0000000001");
    // verify SQL 含 ORDER BY + LIMIT
    expect(fakeDB.calls[0]!.sql).toContain("ORDER BY last_active_at DESC");
    expect(fakeDB.calls[0]!.sql).toContain("LIMIT");
  });

  /* ---- 2. listSessions 限额 50 ---- */
  it("listSessions: limit 参数 > 50 自动截到 50", async () => {
    fakeDB = makeFakeDB({ all: async () => ({ results: [] }) });
    d1 = fakeDB.db;
    await listSessions(d1, "u1", 200);
    const limitParam = fakeDB.calls[0]!.params[1] as number;
    expect(limitParam).toBe(50);
  });

  /* ---- 3. listSessions 空 → [] ---- */
  it("listSessions: 无 session → 返 []", async () => {
    fakeDB = makeFakeDB({ all: async () => ({ results: [] }) });
    d1 = fakeDB.db;
    const got = await listSessions(d1, "u1");
    expect(got).toEqual([]);
  });

  /* ---- 4. getSession 找到 ---- */
  it("getSession: 找到 → 返 row", async () => {
    fakeDB = makeFakeDB({
      first: async (params) => ({ ...SAMPLE_ROWS[0], id: params[0], user_id: params[1] }),
    });
    d1 = fakeDB.db;
    const got = await getSession(d1, "u1", "01HAAAAAAAAAAAA0000000001");
    expect(got).not.toBeNull();
    expect(got!.id).toBe("01HAAAAAAAAAAAA0000000001");
  });

  /* ---- 5. getSession 找不到 → null ---- */
  it("getSession: 找不到 → 返 null（不抛 404，让 caller 决定）", async () => {
    fakeDB = makeFakeDB({ first: async () => null });
    d1 = fakeDB.db;
    const got = await getSession(d1, "u1", "01HBOGUS00000000000000000");
    expect(got).toBeNull();
  });

  /* ---- 6. renameSession 找到 → UPDATE title ---- */
  it("renameSession: 找到 → UPDATE title + 返 void", async () => {
    fakeDB = makeFakeDB({
      first: async (params) => ({ ...SAMPLE_ROWS[0], id: params[0] }),
    });
    d1 = fakeDB.db;
    await renameSession(d1, "u1", "01HAAAAAAAAAAAA0000000001", "新标题");
    const updates = fakeDB.calls.filter((c) => c.op === "run" && c.sql.includes("UPDATE"));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.params[0]).toBe("新标题");
  });

  /* ---- 7. renameSession 找不到 → 404 ---- */
  it("renameSession: 找不到 → 抛 HttpError 404 CHAT_SESSION_NOT_FOUND", async () => {
    fakeDB = makeFakeDB({ first: async () => null });
    d1 = fakeDB.db;
    await expect(renameSession(d1, "u1", "01HBOGUS00000000000000000", "title"))
      .rejects.toMatchObject({ status: 404, code: "CHAT_SESSION_NOT_FOUND" });
  });

  /* ---- 8. deleteSession 找到 → 标 degraded_at + last_active_at ---- */
  it("deleteSession: 找到 → 标 degraded_at=now（不真删）", async () => {
    fakeDB = makeFakeDB({
      first: async (params) => ({ ...SAMPLE_ROWS[0], id: params[0] }),
    });
    d1 = fakeDB.db;
    const before = Date.now();
    await deleteSession(d1, "u1", "01HAAAAAAAAAAAA0000000001");
    const updates = fakeDB.calls.filter((c) => c.op === "run" && c.sql.includes("UPDATE"));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.sql).toContain("degraded_at = ?");
    expect(updates[0]!.sql).toContain("last_active_at = ?");
    expect((updates[0]!.params[0] as number) >= before).toBe(true);
  });

  /* ---- 9. deleteSession 找不到 → 404 ---- */
  it("deleteSession: 找不到 → 抛 HttpError 404 CHAT_SESSION_NOT_FOUND", async () => {
    fakeDB = makeFakeDB({ first: async () => null });
    d1 = fakeDB.db;
    await expect(deleteSession(d1, "u1", "01HBOGUS00000000000000000"))
      .rejects.toMatchObject({ status: 404, code: "CHAT_SESSION_NOT_FOUND" });
  });

  /* ---- 10. userId 隔离（别人的 session 返 null/404） ---- */
  it("userId 隔离: 'u1' 查 'u2' 的 session → 返 null（不串）", async () => {
    fakeDB = makeFakeDB({
      // loadRow WHERE id=? AND user_id=? 永远返 null（不匹配）
      first: async () => null,
    });
    d1 = fakeDB.db;
    const got = await getSession(d1, "u1", "01HBELONGSTOU2SESSION0000");
    expect(got).toBeNull();
    // verify SQL 含 AND user_id = ?
    expect(fakeDB.calls[0]!.sql).toContain("user_id = ?");
    expect(fakeDB.calls[0]!.params[1]).toBe("u1");
  });
});
