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
 * M6.3b + M6.7 + M6.8 updateUserSessionKey 测试套件。
 * M6.7 改：写 envelope 密文（session_key_ct + session_key_dek + session_key=NULL），签名加 env。
 * M6.8 改：写 session_key_kek_version（默认 1，env.KEK_CURRENT_VERSION 可改）。
 *
 * 5 用例覆盖：写密文 / 写 version=2 / 覆盖 / 空 skip / D1 throw 透传 / KEK 缺失抛错。
 */
describe("user.updateUserSessionKey (spy-style fake D1)", () => {
  let fakeDB: ReturnType<typeof makeFakeDB>;
  let d1: D1Database;
  const env = { KEK_SECRET_V1: "test-kek-v1-32-bytes-long-please-please" };

  beforeEach(() => {
    fakeDB = makeFakeDB();
    d1 = fakeDB.db;
  });

  it("写密文: D1 收到 ciphertext/wrappedDek/session_key_kek_version=1 写入新列 + session_key=NULL", async () => {
    await updateUserSessionKey(d1, "user_1", "new_session_key_abc", env);
    const updates = fakeDB.calls.filter(
      (c) => c.op === "run" && c.sql.includes("UPDATE user SET"),
    );
    expect(updates).toHaveLength(1);
    // 4 参数：ciphertext, wrappedDek, version, userId
    expect(updates[0]!.params).toHaveLength(4);
    expect(updates[0]!.params[0]).toMatch(/^[A-Za-z0-9+/=]+$/);  // ciphertext base64
    expect(updates[0]!.params[1]).toMatch(/^[A-Za-z0-9+/=]+$/);  // wrappedDek base64
    expect(updates[0]!.params[2]).toBe(1);  // version=1（M6.7 兼容）
    expect(updates[0]!.params[3]).toBe("user_1");
    // session_key=NULL 在 SQL 文本里
    expect(updates[0]!.sql).toContain("session_key = NULL");
    expect(updates[0]!.sql).toContain("session_key_kek_version = ?");
  });

  it("写 version: env.KEK_CURRENT_VERSION='2' → 写 session_key_kek_version=2", async () => {
    const env2 = { KEK_SECRET_V1: "k1", KEK_SECRET_V2: "k2", KEK_CURRENT_VERSION: "2" };
    await updateUserSessionKey(d1, "user_1", "key", env2);
    const updates = fakeDB.calls.filter(
      (c) => c.op === "run" && c.sql.includes("session_key_kek_version"),
    );
    expect(updates[0]!.params[2]).toBe(2);  // version=2
  });

  it("写 version: env.KEK_CURRENT_VERSION 非法（'abc'）→ fallback version=1", async () => {
    const envBad = { KEK_SECRET_V1: "k1", KEK_CURRENT_VERSION: "abc" };
    await updateUserSessionKey(d1, "user_1", "key", envBad);
    const updates = fakeDB.calls.filter((c) => c.op === "run");
    expect(updates[0]!.params[2]).toBe(1);  // fallback
  });

  it("覆盖: 先写 A 再写 B → 终值 B（密文不同）", async () => {
    await updateUserSessionKey(d1, "user_1", "old_key", env);
    await updateUserSessionKey(d1, "user_1", "new_key", env);
    const updates = fakeDB.calls.filter(
      (c) => c.op === "run" && c.sql.includes("UPDATE user SET"),
    );
    expect(updates).toHaveLength(2);
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

  it("KEK 缺失 → throw 'KEK_SECRET_V1 not configured'（不调 DB）", async () => {
    await expect(
      updateUserSessionKey(d1, "user_1", "any_key", {}),
    ).rejects.toThrow("KEK_SECRET_V1 not configured");
    expect(fakeDB.calls).toHaveLength(0);
  });
});

/**
 * M6.7 + M6.8 readUserSessionKey 测试套件。
 * M6.7 改：透明兼容明文（session_key_ct=NULL fallback 旧明文）。
 * M6.8 改：1st try 优先用 row.session_key_kek_version（fast path）；失败 fallback 遍历所有 env KEK。
 *
 * 5 用例覆盖：新密文 / 老明文 fallback / decrypt 失败（fallback 也救不回）/ env 无 KEK / 1st try 失败 → 2nd try 成功。
 */
describe("user.readUserSessionKey (M6.7 + M6.8) envelope 读路径", () => {
  let fakeDB: ReturnType<typeof makeFakeDB>;
  let d1: D1Database;
  const env = { KEK_SECRET_V1: "test-kek-v1-32-bytes-long-please-please" };

  beforeEach(() => {
    fakeDB = makeFakeDB();
    d1 = fakeDB.db;
  });

  it("新 user: 解 envelope 返 plaintext（fast path 1st try V1 成功）", async () => {
    const plaintext = "wx_session_key_abc";
    const { ciphertext, wrappedDek } = await encryptEnvelope(plaintext, env, 1);
    fakeDB = makeFakeDB({
      first: async () => ({
        session_key_ct: ciphertext,
        session_key_dek: wrappedDek,
        session_key: null,
        session_key_kek_version: 1,
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
        session_key_kek_version: null,
      }),
    });
    d1 = fakeDB.db;
    const got = await readUserSessionKey(d1, "user_1", env);
    expect(got).toBe("old_plaintext_xyz");
  });

  it("decrypt 失败 + 1st try V1 缺失 + 2nd try 跨 KEK 不可解 → 返 null + console.error", async () => {
    // V1 加密的 wrappedDek，env 无 V1 + 有 V2 → fallback 跨 KEK 不可解
    const env2 = { KEK_SECRET_V2: "test-kek-v2-32-bytes-long-please-please" };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext", env, 1);
    fakeDB = makeFakeDB({
      first: async () => ({
        session_key_ct: ciphertext,
        session_key_dek: wrappedDek,
        session_key: null,
        session_key_kek_version: 1,  // 1st try 找 V1
      }),
    });
    d1 = fakeDB.db;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const got = await readUserSessionKey(d1, "user_1", env2);
    expect(got).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("fallback 全失败: env 无 KEK → 返 null + console.error", async () => {
    const envEmpty = {};
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext", env, 1);
    fakeDB = makeFakeDB({
      first: async () => ({
        session_key_ct: ciphertext,
        session_key_dek: wrappedDek,
        session_key: null,
        session_key_kek_version: 1,
      }),
    });
    d1 = fakeDB.db;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const got = await readUserSessionKey(d1, "user_1", envEmpty);
    expect(got).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("1st try 失败（V1 缺失）→ 2nd try V2 试解 V2 写入的数据 → 成功（env 同时有 V1+V2）", async () => {
    // V2 加密的 wrappedDek + env 同时有 V1+V2
    // 1st try V1 试解 V2 wrappedDek 失败 → 2nd try V2 试解 → 成功
    const envFull = { KEK_SECRET_V1: "v1", KEK_SECRET_V2: "v2" };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext", { KEK_SECRET_V2: "v2" }, 2);
    fakeDB = makeFakeDB({
      first: async () => ({
        session_key_ct: ciphertext,
        session_key_dek: wrappedDek,
        session_key: null,
        session_key_kek_version: 1,  // 1st try V1（实际数据是 V2 加密）→ fail
      }),
    });
    d1 = fakeDB.db;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const got = await readUserSessionKey(d1, "user_1", envFull);
    expect(got).toBe("plaintext");
    warnSpy.mockRestore();
  });
});
