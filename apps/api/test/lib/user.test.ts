/**
 * M6.2 lib/user.ts findOrCreateUser 测试套件（spec §3.6）。
 *
 * 测试策略：spy-style fake D1（同 chat.test.ts 模式），不解析 SQL，不走 miniflare。
 * 4 用例覆盖 spec §3.6 数据流：find existing / create new / 多 user 去重 / 空 openid 守门。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  findOrCreateUser,
  updateUserSessionKey,
  readUserSessionKey,
} from "../../src/lib/user.js";
import { encryptEnvelope } from "../../src/lib/envelope.js";

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
 * M6.7 改：写 envelope 密文（session_key_ct + session_key_dek + session_key=NULL），签名加 env。
 *
 * 5 用例覆盖：写密文 / 覆盖 / 空 skip / D1 throw 透传 / KEK 缺失抛错。
 */
describe("user.updateUserSessionKey (spy-style fake D1)", () => {
  let fakeDB: ReturnType<typeof makeFakeDB>;
  let d1: D1Database;
  const env = { KEK_SECRET: "test-kek-secret-32-bytes-long-please-please" };

  beforeEach(() => {
    fakeDB = makeFakeDB();
    d1 = fakeDB.db;
  });

  it("写密文: D1 收到 ciphertext/wrappedDek 写入新列 + session_key=NULL", async () => {
    await updateUserSessionKey(d1, "user_1", "new_session_key_abc", env);
    const updates = fakeDB.calls.filter(
      (c) => c.op === "run" && c.sql.includes("UPDATE user SET session_key_ct"),
    );
    expect(updates).toHaveLength(1);
    // 3 参数：ciphertext, wrappedDek, userId
    expect(updates[0]!.params).toHaveLength(3);
    expect(updates[0]!.params[0]).toMatch(/^[A-Za-z0-9+/=]+$/);  // ciphertext base64
    expect(updates[0]!.params[1]).toMatch(/^[A-Za-z0-9+/=]+$/);  // wrappedDek base64
    expect(updates[0]!.params[2]).toBe("user_1");
    // session_key=NULL 在 SQL 文本里（不是参数）
    expect(updates[0]!.sql).toContain("session_key = NULL");
  });

  it("覆盖: 先写 A 再写 B → 终值 B（密文不同）", async () => {
    await updateUserSessionKey(d1, "user_1", "old_key", env);
    await updateUserSessionKey(d1, "user_1", "new_key", env);
    const updates = fakeDB.calls.filter(
      (c) => c.op === "run" && c.sql.includes("UPDATE user SET session_key_ct"),
    );
    expect(updates).toHaveLength(2);
    // DEK 每次随机，密文应不同
    expect(updates[0]!.params[0]).not.toBe(updates[1]!.params[0]);
  });

  it("空 sessionKey → skip（不调 DB）", async () => {
    await updateUserSessionKey(d1, "user_1", "", env);
    expect(fakeDB.calls).toHaveLength(0);
  });

  it("D1 throw → 透传（不吞）", async () => {
    fakeDB = makeFakeDB({
      run: async () => {
        throw new Error("D1 IO error");
      },
    });
    d1 = fakeDB.db;
    await expect(
      updateUserSessionKey(d1, "user_1", "any_key", env),
    ).rejects.toThrow(/D1 IO error/);
  });

  it("KEK 缺失 → throw 'KEK_SECRET not configured'（不调 DB）", async () => {
    await expect(
      updateUserSessionKey(d1, "user_1", "any_key", {}),
    ).rejects.toThrow("KEK_SECRET not configured");
    expect(fakeDB.calls).toHaveLength(0);
  });
});

/**
 * M6.7 readUserSessionKey 测试套件（spec §6.2 + §10）。
 *
 * 3 用例覆盖：新密文 user 读 / 老明文 user fallback / decrypt 失败 try/catch。
 */
describe("user.readUserSessionKey (M6.7) envelope 读路径", () => {
  let fakeDB: ReturnType<typeof makeFakeDB>;
  let d1: D1Database;
  const env = { KEK_SECRET: "test-kek-secret-32-bytes-long-please-please" };

  beforeEach(() => {
    fakeDB = makeFakeDB();
    d1 = fakeDB.db;
  });

  it("新 user: 解 envelope 返 plaintext", async () => {
    const plaintext = "wx_session_key_abc";
    const { ciphertext, wrappedDek } = await encryptEnvelope(plaintext, env);
    fakeDB = makeFakeDB({
      first: async () => ({
        session_key_ct: ciphertext,
        session_key_dek: wrappedDek,
        session_key: null,
      }),
    });
    d1 = fakeDB.db;
    const got = await readUserSessionKey(d1, "user_1", env);
    expect(got).toBe(plaintext);
  });

  it("老 user: session_key_ct=NULL 时返旧明文（lazy fallback）", async () => {
    fakeDB = makeFakeDB({
      first: async () => ({
        session_key_ct: null,
        session_key_dek: null,
        session_key: "old_plaintext_xyz",
      }),
    });
    d1 = fakeDB.db;
    const got = await readUserSessionKey(d1, "user_1", env);
    expect(got).toBe("old_plaintext_xyz");
  });

  it("decrypt 失败: try/catch 返 null + console.warn（不抛）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeDB = makeFakeDB({
      first: async () => ({
        session_key_ct: "garbage-not-base64-of-valid-envelope",
        session_key_dek: "garbage-not-base64-of-valid-envelope",
        session_key: null,
      }),
    });
    d1 = fakeDB.db;
    const got = await readUserSessionKey(d1, "user_1", env);
    expect(got).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain("envelope");
    warnSpy.mockRestore();
  });
});
