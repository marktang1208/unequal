/**
 * gen-jwt.ts — 真接 / 调试 JWT 生成工具 (P7 follow-up #3)
 *
 * 用法:
 *   # 默认 (placeholder user, scope=user, ttl=7d)
 *   pnpm -F api gen-jwt
 *
 *   # 真用户 (admin 真接 / NLI 真接验证用)
 *   pnpm -F api gen-jwt --sub 01KVCZ2JRBAGF3MY75D7KEY4RZ
 *
 *   # Admin scope (admin endpoints)
 *   pnpm -F api gen-jwt --scope admin --sub 01H0000000000000000000000
 *
 *   # 短 ttl (调试)
 *   pnpm -F api gen-jwt --ttl 1h
 *
 * 输出: stdout = JWT string (无 newline)
 *
 * 来源: macOS Keychain `security find-generic-password -a unequal-deploy -s unequal:api-router:JWT_SECRET -w`
 */

import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { signJwt } from "./gen-jwt-lib.js";

const { values } = parseArgs({
  options: {
    sub: { type: "string", default: "01H0000000000000000000000" },
    scope: { type: "string", default: "user" },
    ttl: { type: "string", default: "7d" },
    issuer: { type: "string", default: "unequal-api" },
  },
  allowPositionals: false,
});

const KEYCHAIN_ACCOUNT = "unequal-deploy";
const KEYCHAIN_PREFIX = "unequal:api-router:";

function keychainGet(key: string): string {
  const r = execSync(
    `security find-generic-password -a ${KEYCHAIN_ACCOUNT} -s "${KEYCHAIN_PREFIX}${key}" -w`,
    { encoding: "utf-8" },
  );
  return r.trim();
}

const secret = keychainGet("JWT_SECRET");
const jwt = await signJwt({
  sub: values.sub!,
  scope: values.scope!,
  secret,
  issuer: values.issuer,
  ttl: values.ttl,
});

process.stdout.write(jwt);
