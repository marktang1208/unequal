/**
 * M6.7 + M6.8 lib/envelope.ts 测试套件（spec §5 + §10 + M6.8 §5）。
 *
 * M6.7 8 用例：encrypt happy / decrypt happy / 往返 / KEK 缺失 (undefined+"") / DEK 随机 / tamper / 错误 KEK
 * M6.8 5 用例：getAllKekVersions 扫描 V1-V3 / env 无 KEK / tryDecryptWithAnyKek fallback 成功 / 全失败 / 多 KEK 轮换
 *
 * M6.8 改：encryptEnvelope/decryptEnvelope 签名加 version 参数；KEK 来源从 env.KEK_SECRET 改为 env.KEK_SECRET_V{version}。
 *
 * 测试策略：纯函数单元测试，不依赖 D1 / miniflare。env 参数 mock。
 */
import { describe, it, expect } from "vitest";
import {
  encryptEnvelope,
  decryptEnvelope,
  getAllKekVersions,
  tryDecryptWithAnyKek,
} from "../../src/lib/envelope.js";

const TEST_KEK_V1 = "test-kek-v1-32-bytes-long-please-please-xxx";
const TEST_KEK_V2 = "test-kek-v2-32-bytes-long-please-please-xxx";

describe("envelope.encryptEnvelope / decryptEnvelope (M6.7 + M6.8 version)", () => {
  it("encrypt happy: 返 ciphertext + wrappedDek 都非空 base64", async () => {
    const env = { KEK_SECRET_V1: TEST_KEK_V1 };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext-session", env, 1);
    expect(ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(wrappedDek).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(wrappedDek.length).toBeGreaterThan(0);
  });

  it("decrypt happy: ciphertext + wrappedDek → 还原 plaintext", async () => {
    const env = { KEK_SECRET_V1: TEST_KEK_V1 };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext-session", env, 1);
    const decrypted = await decryptEnvelope(ciphertext, wrappedDek, env, 1);
    expect(decrypted).toBe("plaintext-session");
  });

  it("往返: encrypt → decrypt 还原任意 plaintext（空 / 普通 / emoji / 中文 / 长串）", async () => {
    const env = { KEK_SECRET_V1: "k" };  // 短 KEK 也应能 round-trip
    const samples = [
      "",
      "abc",
      "session_key_🦊_emoji",
      "中文 + special chars: !@#$%^&*()",
      "x".repeat(1000),
    ];
    for (const s of samples) {
      const { ciphertext, wrappedDek } = await encryptEnvelope(s, env, 1);
      const decrypted = await decryptEnvelope(ciphertext, wrappedDek, env, 1);
      expect(decrypted).toBe(s);
    }
  });

  it("KEK 缺失: env.KEK_SECRET_V1=undefined → throw 'KEK_SECRET_V1 not configured'", async () => {
    await expect(encryptEnvelope("x", {}, 1)).rejects.toThrow("KEK_SECRET_V1 not configured");
    await expect(decryptEnvelope("aGVsbG8=", "d29ybGQ=", {}, 1)).rejects.toThrow("KEK_SECRET_V1 not configured");
  });

  it("KEK 缺失（空字符串）: env.KEK_SECRET_V1='' → throw", async () => {
    await expect(encryptEnvelope("x", { KEK_SECRET_V1: "" }, 1)).rejects.toThrow("KEK_SECRET_V1 not configured");
    await expect(decryptEnvelope("aGVsbG8=", "d29ybGQ=", { KEK_SECRET_V1: "" }, 1)).rejects.toThrow("KEK_SECRET_V1 not configured");
  });

  it("不同 plaintext 两次 encrypt → 不同 ciphertext（DEK 随机）", async () => {
    const env = { KEK_SECRET_V1: TEST_KEK_V1 };
    const a = await encryptEnvelope("same-plaintext", env, 1);
    const b = await encryptEnvelope("same-plaintext", env, 1);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    expect(await decryptEnvelope(a.ciphertext, a.wrappedDek, env, 1)).toBe("same-plaintext");
    expect(await decryptEnvelope(b.ciphertext, b.wrappedDek, env, 1)).toBe("same-plaintext");
  });

  it("decrypt 失败: 篡改 ciphertext 1 byte → throw 'envelope decrypt failed'", async () => {
    const env = { KEK_SECRET_V1: TEST_KEK_V1 };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext", env, 1);
    const tampered = ciphertext.slice(0, 10) + (ciphertext[10] === "A" ? "B" : "A") + ciphertext.slice(11);
    await expect(decryptEnvelope(tampered, wrappedDek, env, 1)).rejects.toThrow("envelope decrypt failed");
  });

  it("decrypt 失败: 错误 KEK (V1 vs V2) → throw", async () => {
    const env1 = { KEK_SECRET_V1: TEST_KEK_V1 };
    const env2 = { KEK_SECRET_V1: TEST_KEK_V1, KEK_SECRET_V2: TEST_KEK_V2 };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext", env1, 1);
    // V2 试解 V1 加密的 wrappedDek 应失败
    await expect(decryptEnvelope(ciphertext, wrappedDek, env2, 2)).rejects.toThrow("envelope decrypt failed");
  });
});

describe("envelope.getAllKekVersions (M6.8)", () => {
  it("扫描 env 找 V1, V2, V3 跳 V4（无）", () => {
    expect(getAllKekVersions({
      KEK_SECRET_V1: "x",
      KEK_SECRET_V2: "y",
      KEK_SECRET_V3: "z",
      OTHER: "noise",
    })).toEqual([1, 2, 3]);
  });

  it("env 无 KEK → 返 []", () => {
    expect(getAllKekVersions({})).toEqual([]);
  });

  it("跳过非法 version (含字母 / 0)", () => {
    expect(getAllKekVersions({
      KEK_SECRET_V1: "x",
      KEK_SECRET_Vabc: "y",  // 非法
      KEK_SECRET_V0: "z",   // 非法（< 1）
    })).toEqual([1]);
  });
});

describe("envelope.tryDecryptWithAnyKek (M6.8) fallback", () => {
  it("fallback 成功: V1 写入 + env 有 V1 → tryDecryptWithAnyKek V1 试解成功", async () => {
    // 注意：AES-GCM 不可跨 KEK 解密 — V1 加密的 wrappedDek 用 V2 永远解不开
    // fallback 真正救回的是"env V1 临时被改名/重映射"场景
    // 测试：用 V1 加密 → env 有 V1（无 V2） → tryDecryptWithAnyKek 用 V1 试解 → 成功
    const env1 = { KEK_SECRET_V1: TEST_KEK_V1 };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext", env1, 1);
    // 同样 env 调 tryDecryptWithAnyKek
    const decrypted = await tryDecryptWithAnyKek(ciphertext, wrappedDek, env1);
    expect(decrypted).toBe("plaintext");
  });

  it("fallback 跨 KEK 不可解: V1 写入 → V1 缺失 → V2 试解 V1 wrappedDek 失败 → throw 'all KEKs failed'", async () => {
    // 真实场景：V1 KEK 丢失，admin 引入 V2 替代 → 老 V1 数据不可读
    // fallback 救不回：tryDecryptWithAnyKek 遍历 V2 → V2 试解 V1 wrappedDek 失败
    const env1 = { KEK_SECRET_V1: TEST_KEK_V1 };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext", env1, 1);
    const env2 = { KEK_SECRET_V2: TEST_KEK_V2 };  // 只有 V2
    await expect(tryDecryptWithAnyKek(ciphertext, wrappedDek, env2)).rejects.toThrow("all KEKs failed to decrypt");
  });

  it("fallback 全失败: env 无 KEK → throw 'no KEK configured'", async () => {
    await expect(tryDecryptWithAnyKek("xxx", "yyy", {})).rejects.toThrow("no KEK configured");
  });

  it("多 KEK 轮换: V1 写入 + V2 写入（不同 KEK）→ 两个 ciphertext 都能 fallback 解", async () => {
    const envFull = { KEK_SECRET_V1: TEST_KEK_V1, KEK_SECRET_V2: TEST_KEK_V2 };
    // V1 写入 + V1 env 存在
    const a = await encryptEnvelope("same", { KEK_SECRET_V1: TEST_KEK_V1 }, 1);
    // V2 写入 + V2 env 存在
    const b = await encryptEnvelope("same", { KEK_SECRET_V2: TEST_KEK_V2 }, 2);
    // 不同 KEK → 不同 wrappedDek
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    // envFull 有 V1+V2 → 两个 ciphertext 都能解
    expect(await tryDecryptWithAnyKek(a.ciphertext, a.wrappedDek, envFull)).toBe("same");
    expect(await tryDecryptWithAnyKek(b.ciphertext, b.wrappedDek, envFull)).toBe("same");
  });
});
