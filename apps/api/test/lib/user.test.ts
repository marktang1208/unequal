/**
 * M6.2 lib/user.ts findOrCreateUser 测试套件（spec §3.6）。
 *
 * 测试策略：spy-style fake D1（同 chat.test.ts 模式），不解析 SQL，不走 miniflare。
 * 4 用例覆盖 spec §3.6 数据流：find existing / create new / 多 user 去重 / 空 openid 守门。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { findOrCreateUser, updateUserSessionKey } from "../../src/lib/user.js";

/* ---------- spy-style fake D1 ---------- */

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

const EXISTING_USER = {
  id: "01HEXISTINGUSER0000000000",
  wx_openid: "mock_openid_001",
  nickname: null,
  created_at: 1700000000000,
};

describe("user.findOrCreateUser (spy-style fake D1)", () => {
  let fakeDB: ReturnType<typeof makeFakeDB>;
  let d1: D1Database;

  beforeEach(() => {
    fakeDB = makeFakeDB();
    d1 = fakeDB.db;
  });

  it("find existing: SELECT 找到 → 返 user + isNew=false（不 INSERT）", async () => {
    fakeDB = makeFakeDB({
      first: async (params) => ({ ...EXISTING_USER, wx_openid: params[0] }),
    });
    d1 = fakeDB.db;
    const got = await findOrCreateUser(d1, "mock_openid_001");
    expect(got.isNew).toBe(false);
    expect(got.user.id).toBe(EXISTING_USER.id);
    expect(got.user.wx_openid).toBe("mock_openid_001");
    // 不应 INSERT
    const inserts = fakeDB.calls.filter((c) => c.op === "run" && c.sql.includes("INSERT"));
    expect(inserts).toHaveLength(0);
  });

  it("create new: SELECT 返 null → INSERT ulid 新 user + isNew=true", async () => {
    fakeDB = makeFakeDB({ first: async () => null });
    d1 = fakeDB.db;
    const got = await findOrCreateUser(d1, "new_openid_xyz");
    expect(got.isNew).toBe(true);
    expect(got.user.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    expect(got.user.wx_openid).toBe("new_openid_xyz");
    expect(got.user.nickname).toBeNull();
    const inserts = fakeDB.calls.filter((c) => c.op === "run" && c.sql.includes("INSERT"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params[0]).toBe(got.user.id);
    expect(inserts[0]!.params[1]).toBe("new_openid_xyz");
  });

  it("multi user: 第一次返 null + 第二次返 user（去重）", async () => {
    const firstCall = vi.fn(async () => null);
    const secondCall = vi.fn(async (params: unknown[]) => ({
      ...EXISTING_USER,
      wx_openid: params[0],
    }));
    let isFirst = true;
    fakeDB = makeFakeDB({
      first: async (params) => {
        if (isFirst) {
          isFirst = false;
          return firstCall();
        }
        return secondCall(params);
      },
    });
    d1 = fakeDB.db;
    // 第一次：创建
    const r1 = await findOrCreateUser(d1, "duplicate_openid");
    expect(r1.isNew).toBe(true);
    // 第二次：复用
    const r2 = await findOrCreateUser(d1, "duplicate_openid");
    expect(r2.isNew).toBe(false);
    expect(r2.user.id).toBe(EXISTING_USER.id);
  });

  it("空 openid → 抛 Error（不查 DB）", async () => {
    await expect(findOrCreateUser(d1, "")).rejects.toThrow(/non-empty/);
    // 不应调 DB
    expect(fakeDB.calls).toHaveLength(0);
  });
});

/**
 * M6.3b updateUserSessionKey 测试套件（spec §5/§6/§9.1）。
 *
 * 4 用例覆盖：写入 / 覆盖 / 空 skip / D1 throw 透传。
 */
describe("user.updateUserSessionKey (spy-style fake D1)", () => {
  let fakeDB: ReturnType<typeof makeFakeDB>;
  let d1: D1Database;

  beforeEach(() => {
    fakeDB = makeFakeDB();
    d1 = fakeDB.db;
  });

  it("写入：updateUserSessionKey 调 1 次 UPDATE user SET session_key", async () => {
    await updateUserSessionKey(d1, "user_1", "new_session_key_abc");
    const updates = fakeDB.calls.filter(
      (c) => c.op === "run" && c.sql.includes("UPDATE user SET session_key"),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.params).toEqual(["new_session_key_abc", "user_1"]);
  });

  it("覆盖：先写 A 再写 B → 终值 B", async () => {
    await updateUserSessionKey(d1, "user_1", "old_key");
    await updateUserSessionKey(d1, "user_1", "new_key");
    const updates = fakeDB.calls.filter(
      (c) => c.op === "run" && c.sql.includes("UPDATE user SET session_key"),
    );
    expect(updates).toHaveLength(2);
    expect(updates[0]!.params[0]).toBe("old_key");
    expect(updates[1]!.params[0]).toBe("new_key");
  });

  it("空 sessionKey → skip（不调 DB）", async () => {
    await updateUserSessionKey(d1, "user_1", "");
    expect(fakeDB.calls).toHaveLength(0);
  });

  it("D1 throw → 透传（不吞）", async () => {
    fakeDB = makeFakeDB({
      run: async () => {
        throw new Error("D1 IO error");
      },
    });
    d1 = fakeDB.db;
    await expect(updateUserSessionKey(d1, "user_1", "any_key")).rejects.toThrow(
      /D1 IO error/,
    );
  });
});
