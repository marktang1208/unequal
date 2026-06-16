/**
 * M6.7 lib/envelope.ts 测试套件（spec §5 + §10）。
 *
 * 8 用例覆盖：
 * 1. encrypt happy: 返 ciphertext + wrappedDek 都非空 base64
 * 2. decrypt happy: ciphertext + wrappedDek → 还原 plaintext
 * 3. 往返: encrypt → decrypt 还原任意 plaintext（空 / 普通 / emoji / 中文 / 长串）
 * 4. KEK 缺失: env.KEK_SECRET=undefined → throw 'KEK_SECRET not configured'
 * 5. KEK 缺失（空字符串）: env.KEK_SECRET='' → throw
 * 6. 不同 plaintext 两次 encrypt → 不同 ciphertext（DEK 随机）
 * 7. decrypt 失败: 篡改 ciphertext 1 byte → throw 'envelope decrypt failed'
 * 8. decrypt 失败: 错误 KEK → throw
 *
 * 测试策略：纯函数单元测试，不依赖 D1 / miniflare。env 参数 mock。
 */
import { describe, it, expect } from "vitest";
import {
  encryptEnvelope,
  decryptEnvelope,
} from "../../src/lib/envelope.js";

const TEST_KEK = "test-kek-secret-32-bytes-long-please-please-xxx";

describe("envelope.encryptEnvelope / decryptEnvelope (M6.7)", () => {
  it("encrypt happy: 返 ciphertext + wrappedDek 都非空 base64", async () => {
    const env = { KEK_SECRET: TEST_KEK };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext-session", env);
    // base64 字符集 + 长度 > 0
    expect(ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(wrappedDek).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(wrappedDek.length).toBeGreaterThan(0);
  });

  it("decrypt happy: ciphertext + wrappedDek → 还原 plaintext", async () => {
    const env = { KEK_SECRET: TEST_KEK };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext-session", env);
    const decrypted = await decryptEnvelope(ciphertext, wrappedDek, env);
    expect(decrypted).toBe("plaintext-session");
  });

  it("往返: encrypt → decrypt 还原任意 plaintext（空 / 普通 / emoji / 中文 / 长串）", async () => {
    const env = { KEK_SECRET: "k" };  // 短 KEK 也应能 round-trip（SHA-256 统一到 32 字节）
    const samples = [
      "",
      "abc",
      "session_key_🦊_emoji",
      "中文 + special chars: !@#$%^&*()",
      "x".repeat(1000),
    ];
    for (const s of samples) {
      const { ciphertext, wrappedDek } = await encryptEnvelope(s, env);
      const decrypted = await decryptEnvelope(ciphertext, wrappedDek, env);
      expect(decrypted).toBe(s);
    }
  });

  it("KEK 缺失: env.KEK_SECRET=undefined → throw 'KEK_SECRET not configured'", async () => {
    await expect(encryptEnvelope("x", {})).rejects.toThrow("KEK_SECRET not configured");
    await expect(decryptEnvelope("aGVsbG8=", "d29ybGQ=", {})).rejects.toThrow("KEK_SECRET not configured");
  });

  it("KEK 缺失（空字符串）: env.KEK_SECRET='' → throw", async () => {
    await expect(encryptEnvelope("x", { KEK_SECRET: "" })).rejects.toThrow("KEK_SECRET not configured");
    await expect(decryptEnvelope("aGVsbG8=", "d29ybGQ=", { KEK_SECRET: "" })).rejects.toThrow("KEK_SECRET not configured");
  });

  it("不同 plaintext 两次 encrypt → 不同 ciphertext（DEK 随机）", async () => {
    const env = { KEK_SECRET: TEST_KEK };
    const a = await encryptEnvelope("same-plaintext", env);
    const b = await encryptEnvelope("same-plaintext", env);
    // DEK 每次随机 → ciphertext + wrappedDek 都应不同
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    // 但两者 decrypt 都应还原同一 plaintext
    expect(await decryptEnvelope(a.ciphertext, a.wrappedDek, env)).toBe("same-plaintext");
    expect(await decryptEnvelope(b.ciphertext, b.wrappedDek, env)).toBe("same-plaintext");
  });

  it("decrypt 失败: 篡改 ciphertext 1 byte → throw 'envelope decrypt failed'", async () => {
    const env = { KEK_SECRET: TEST_KEK };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext", env);
    // 篡改 ciphertext 中间 1 byte
    const tampered = ciphertext.slice(0, 10) + (ciphertext[10] === "A" ? "B" : "A") + ciphertext.slice(11);
    await expect(decryptEnvelope(tampered, wrappedDek, env)).rejects.toThrow("envelope decrypt failed");
  });

  it("decrypt 失败: 错误 KEK → throw", async () => {
    const env1 = { KEK_SECRET: "kek-one-32-bytes-long-please-please-xxx" };
    const env2 = { KEK_SECRET: "kek-two-32-bytes-long-please-please-xxx" };
    const { ciphertext, wrappedDek } = await encryptEnvelope("plaintext", env1);
    await expect(decryptEnvelope(ciphertext, wrappedDek, env2)).rejects.toThrow("envelope decrypt failed");
  });
});
