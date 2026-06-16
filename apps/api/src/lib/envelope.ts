/**
 * M6.7 + M6.8 envelope encryption（Web Crypto AES-256-GCM，spec §5 + §10）。
 *
 * M6.7 流程：
 * - 写：随机 DEK + 2 个 96-bit nonce；DEK 加密 plaintext → ciphertext；KEK 加密 DEK → wrappedDek
 * - 读：从 ciphertext + wrappedDek + 2 nonce 恢复 plaintext
 *
 * M6.8 改：KEK version + multi-KEK fallback
 * - KEK 来源：env.KEK_SECRET_V{version}（如 KEK_SECRET_V1, V2, V3...）
 * - KEK 派生：SHA-256(env.KEK_SECRET_V{version})[:32] → AES-256 raw key
 * - 缺失 throw `KEK_SECRET_V${version} not configured`
 * - fallback（tryDecryptWithAnyKek）：遍历 env 所有 KEK_SECRET_V* 试解
 *
 * 错误：
 * - KEK 缺失 → throw `KEK_SECRET_V${version} not configured`（auth.ts try/catch 兜底，不阻断登录）
 * - decrypt 失败（KEK 错 / tamper / 格式坏）→ throw "envelope decrypt failed"
 *   readUserSessionKey 1st try 失败 → fallback tryDecryptWithAnyKek
 * - 全失败 → readUserSessionKey 返 null + console.error
 *
 * M6.7 决策（D-1 ~ D-10）：Web Crypto / KEK env / 真 envelope / Lazy 兼容 / SHA-256 派生 /
 * session_key=NULL / decrypt throw + readUserSessionKey try/catch / base64 串行化 /
 * env 显式传 / 0 KEK version
 * M6.8 决策（D-1 ~ D-8）：表加 version 列 / KEK_SECRET_V* 多 env / fallback 遍历 /
 * 1st try row.session_key_kek_version / 写 currentVersion 默认 1 /
 * 0 主动重 wrap 工具 / 0 KEK 自动轮换调度 / 派生算法 hardcode SHA-256
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
 * M6.8: KEK env 子集（任意 string 字段）。
 * envelope 函数只读这些字段（D1/R2 等无关）。
 */
export type KekEnv = Record<string, string | undefined>;

/**
 * M6.7 + M6.8 加密 plaintext 返 ciphertext + wrappedDek。
 * 每次调用生成新 DEK + 2 个 96-bit nonce（DEK/KEK 各 1）。
 *
 * M6.8 改：加 version 参数；按 `env.KEK_SECRET_V${version}` 取 KEK。
 */
export async function encryptEnvelope(
  plaintext: string,
  env: KekEnv,
  version: number,
): Promise<EnvelopeCipher> {
  const kek = await deriveKek(env, version);

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
 * M6.7 + M6.8 解密 envelope 返 plaintext。
 * 失败 throw "envelope decrypt failed"（KEK 错 / ciphertext tamper / 格式坏）。
 *
 * M6.8 改：加 version 参数；按 `env.KEK_SECRET_V${version}` 取 KEK。
 */
export async function decryptEnvelope(
  ciphertext_b64: string,
  wrappedDek_b64: string,
  env: KekEnv,
  version: number,
): Promise<string> {
  const kek = await deriveKek(env, version);

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

/**
 * M6.8: 扫描 env 找所有 `KEK_SECRET_V{N}` 变量，返回版本号数组（升序）。
 * 用于 fallback 遍历所有 KEK 试解（last resort）。
 */
export function getAllKekVersions(env: KekEnv): number[] {
  const versions: number[] = [];
  for (const key of Object.keys(env)) {
    const match = key.match(/^KEK_SECRET_V(\d+)$/);
    if (match) {
      const v = parseInt(match[1]!, 10);
      if (Number.isFinite(v) && v >= 1) versions.push(v);
    }
  }
  return versions.sort((a, b) => a - b);
}

/**
 * M6.8: fallback 遍历所有 env KEK 试解。
 * 1st try 优先用 row.session_key_kek_version（fast path），失败 → fallback 此函数。
 *
 * 错误：env 无 KEK → throw "no KEK configured"；所有 KEK 都失败 → throw "all KEKs failed to decrypt"。
 */
export async function tryDecryptWithAnyKek(
  ciphertext_b64: string,
  wrappedDek_b64: string,
  env: KekEnv,
): Promise<string> {
  const versions = getAllKekVersions(env);
  if (versions.length === 0) {
    throw new Error("no KEK configured");
  }
  for (const v of versions) {
    try {
      return await decryptEnvelope(ciphertext_b64, wrappedDek_b64, env, v);
    } catch {
      continue;  // 该 KEK 错/缺失，试下一个
    }
  }
  throw new Error("all KEKs failed to decrypt");
}

/* ---------- 内部 helper ---------- */

/**
 * M6.8: KEK 派生（按 version 选 secret）。
 * SHA-256(env.KEK_SECRET_V{version})[:32] → AES-256 raw key。
 * 缺失 throw `KEK_SECRET_V${version} not configured`。
 */
async function deriveKek(env: KekEnv, version: number): Promise<CryptoKey> {
  // 显式 switch：避免 dynamic key 访问 + 类型丢失
  const secret =
    version === 1 ? env.KEK_SECRET_V1 :
    version === 2 ? env.KEK_SECRET_V2 :
    version === 3 ? env.KEK_SECRET_V3 :
    undefined;
  if (!secret) {
    throw new Error(`KEK_SECRET_V${version} not configured`);
  }
  const raw = new TextEncoder().encode(secret);
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
