import { SignJWT, jwtVerify } from "jose";
import { HttpError } from "./auth.js";

export interface JwtPayload {
  userId: string;
  isAdmin: boolean;
}

const ALG = "HS256";
const ISSUER = "unequal-api";
const TTL_SECONDS = 24 * 60 * 60; // 24h

export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return await new SignJWT({ userId: payload.userId, isAdmin: payload.isAdmin })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(key);
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload> {
  const key = new TextEncoder().encode(secret);
  let payload;
  try {
    const result = await jwtVerify(token, key, { issuer: ISSUER });
    payload = result.payload;
  } catch (err) {
    // jose 抛 JWTExpired / JWTInvalid / JWSInvalid 等
    const code = (err as { code?: string }).code;
    if (code === "ERR_JWT_EXPIRED") {
      throw new HttpError(401, "JWT_EXPIRED", "JWT has expired");
    }
    throw new HttpError(401, "INVALID_JWT", err instanceof Error ? err.message : "JWT verify failed");
  }
  if (typeof payload.userId !== "string" || typeof payload.isAdmin !== "boolean") {
    throw new HttpError(401, "INVALID_JWT_CLAIMS", "JWT payload missing userId or isAdmin");
  }
  return { userId: payload.userId as string, isAdmin: payload.isAdmin as boolean };
}