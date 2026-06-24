/**
 * gen-jwt-lib.ts — JWT sign 函数 (与 macOS Keychain 解耦)
 *
 * 抽出来便于 unit test (sign 函数接受 secret 参数, 不 mock Keychain)
 *
 * 用法:
 *   import { signJwt } from "./gen-jwt-lib.js";
 *   const jwt = await signJwt({ sub: "01K...", scope: "user", secret: "..." });
 *
 * 与 gen-jwt.ts 的关系: gen-jwt.ts 是 CLI 包装 (读 Keychain + 调 signJwt)
 */

import { SignJWT } from "jose";

export interface SignJwtOptions {
  sub: string;
  scope: string;
  secret: string;
  /** issuer claim, 默认 "unequal-api" */
  issuer?: string;
  /** TTL string, jose 接受 "7d" / "1h" / "30m" / "60s" 等 */
  ttl?: string;
  /** 算法, 默认 HS256 */
  alg?: string;
}

/**
 * 签 HS256 JWT
 * @throws 如果 secret / sub / scope 任一为空
 */
export async function signJwt(opts: SignJwtOptions): Promise<string> {
  if (!opts.sub) throw new Error("signJwt: sub is required");
  if (!opts.scope) throw new Error("signJwt: scope is required");
  if (!opts.secret) throw new Error("signJwt: secret is required");

  const alg = opts.alg ?? "HS256";
  const issuer = opts.issuer ?? "unequal-api";
  const ttl = opts.ttl ?? "7d";

  return await new SignJWT({ scope: opts.scope })
    .setProtectedHeader({ alg })
    .setIssuer(issuer)
    .setSubject(opts.sub)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(new TextEncoder().encode(opts.secret));
}
