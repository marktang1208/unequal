/**
 * CP-6: JWT 签发与验证
 *
 * 用 jose（HS256）签发短期 JWT，含 user_id + scope + exp。
 * 验证返 payload 或 throw。
 */

import { SignJWT, jwtVerify } from "jose";

const ALG = "HS256";
const ISSUER = "unequal-api";
const EXPIRES_IN = "7d"; // 7 天

export interface JwtPayload {
  sub: string;          // user_id
  scope: "admin" | "user";
  iat: number;
  exp: number;
}

function getSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signJwt(opts: {
  userId: string;
  scope: "admin" | "user";
  secret: string;
}): Promise<string> {
  const jwt = await new SignJWT({ scope: opts.scope })
    .setProtectedHeader({ alg: ALG })
    .setSubject(opts.userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(EXPIRES_IN)
    .sign(getSecret(opts.secret));

  return jwt;
}

export async function verifyJwt(opts: {
  token: string;
  secret: string;
}): Promise<JwtPayload> {
  const { payload } = await jwtVerify(opts.token, getSecret(opts.secret), {
    issuer: ISSUER,
  });
  if (typeof payload.sub !== "string") throw new Error("invalid sub");
  if (payload.scope !== "admin" && payload.scope !== "user") {
    throw new Error("invalid scope");
  }
  return payload as unknown as JwtPayload;
}