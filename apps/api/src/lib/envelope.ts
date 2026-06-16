/**
 * M6.7 envelope encryption（Web Crypto AES-256-GCM，spec §5 + §10）。
 *
 * 流程：
 * - 写：随机 DEK + 2 个 96-bit nonce；DEK 加密 plaintext → ciphertext；KEK 加密 DEK → wrappedDek
 * - 读：从 ciphertext + wrappedDek + 2 nonce 恢复 plaintext
 *
 * KEK 来源：env.KEK_SECRET（wrangler secret put 注入）
 * KEK 派生：SHA-256(env.KEK_SECRET)（任意长度 secret 统一到 32 字节 raw key，AES-256）
 *
 * 错误：
 * - KEK 缺失 → throw Error("KEK_SECRET not configured")（auth.ts try/catch 兜底，不阻断登录）
 * - decrypt 失败（KEK 错 / tamper / 格式坏）→ throw Error("envelope decrypt failed")
 *   readUserSessionKey try/catch 返 null + console.warn
 *
 * M6.7 决策（D-1 ~ D-10）：Web Crypto / KEK env / 真 envelope / Lazy 兼容 / SHA-256 派生 /
 * session_key=NULL / decrypt throw + readUserSessionKey try/catch / base64 串行化 /
 * env 显式传 / 0 KEK version（YAGNI）
 */

const NONCE_BYTES = 12;  // AES-GCM 推荐 96-bit nonce
const DEK_BYTES = 32;    // AES-256 key

export interface EnvelopeCipher {
  /** base64(nonce_12B || encrypted_data + 16-byte auth tag) */
  ciphertext: string;
  /** base64(nonce_12B || wrapped_DEK + 16-byte auth tag) */
  wrappedDek: string;
}

/**
 * 加密 plaintext 返 ciphertext + wrappedDek。
 * 每次调用生成新 DEK + 2 个 96-bit nonce（DEK/KEK 各 1）。
 */
export async function encryptEnvelope(
  plaintext: string,
  env: { KEK_SECRET?: string },
): Promise<EnvelopeCipher> {
  const kek = await deriveKek(env);

  // 1. 随机 DEK + DEK 加密 plaintext
  const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
  const nonce1 = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce1 },
    await importDekKey(dek),
    plaintextBytes,
  );
  const ciphertext = encodeBase64(concatBytes(nonce1, new Uint8Array(ctBuf)));

  // 2. KEK 加密 DEK
  const nonce2 = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const dekBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce2 },
    kek,
    dek,
  );
  const wrappedDek = encodeBase64(concatBytes(nonce2, new Uint8Array(dekBuf)));

  return { ciphertext, wrappedDek };
}

/**
 * 解密 envelope 返 plaintext。
 * 失败 throw "envelope decrypt failed"（KEK 错 / ciphertext tamper / 格式坏）。
 */
export async function decryptEnvelope(
  ciphertext_b64: string,
  wrappedDek_b64: string,
  env: { KEK_SECRET?: string },
): Promise<string> {
  const kek = await deriveKek(env);

  // 1. 解 wrappedDek → DEK
  const dekBytes = decodeBase64(wrappedDek_b64);
  const nonce2 = dekBytes.slice(0, NONCE_BYTES);
  const wrappedDekData = dekBytes.slice(NONCE_BYTES);
  let dekBytesDecrypted: ArrayBuffer;
  try {
    dekBytesDecrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce2 },
      kek,
      wrappedDekData,
    );
  } catch {
    throw new Error("envelope decrypt failed");
  }

  // 2. 解 ciphertext → plaintext
  const ctRaw = decodeBase64(ciphertext_b64);
  const nonce1 = ctRaw.slice(0, NONCE_BYTES);
  const ctData = ctRaw.slice(NONCE_BYTES);
  let ptBuf: ArrayBuffer;
  try {
    ptBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce1 },
      await importDekKey(new Uint8Array(dekBytesDecrypted)),
      ctData,
    );
  } catch {
    throw new Error("envelope decrypt failed");
  }

  return new TextDecoder().decode(ptBuf);
}

/* ---------- 内部 helper ---------- */

/** SHA-256(env.KEK_SECRET) 截 32 字节 → AES-256 raw key */
async function deriveKek(env: { KEK_SECRET?: string }): Promise<CryptoKey> {
  if (!env.KEK_SECRET) {
    throw new Error("KEK_SECRET not configured");
  }
  const raw = new TextEncoder().encode(env.KEK_SECRET);
  const hash = await crypto.subtle.digest("SHA-256", raw);
  return crypto.subtle.importKey(
    "raw",
    hash,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** 32 字节 DEK raw → AES-256 CryptoKey */
async function importDekKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Uint8Array 连接（a + b） */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Uint8Array → base64 字符串 */
function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

/** base64 字符串 → Uint8Array */
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
