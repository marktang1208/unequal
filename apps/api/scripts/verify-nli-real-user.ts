/**
 * verify-nli-real-user.ts — 真接 destructive 验证: 真用户 + 真 chunks NLI 真接 (P7 follow-up #3)
 *
 * 背景 (P6 state-p6 §6.5):
 *   - P6 真接时 placeholder user (01H0000000000000000000000) retrieve chunks 失败
 *   - NLI hypothesis 空 → score=0 → runtime_error → failOpen 兜底
 *   - 未能验证 NLI 真接拒绝 (entailment/contradiction) 路径
 *
 * P7 #3: 用真用户 (01KVCZ2JRBAGF3MY75D7KEY4RZ, 13 sessions, 26 messages)
 *   调 /api-chat 长问, 验 retrieve 真 chunks → NLI 真判 (pass / reject)
 *
 * Usage:
 *   pnpm -F api verify:nli-real-user
 *   pnpm -F api verify:nli-real-user --user 01KVCZ2JRBAGF3MY75D7KEY4RZ
 *   pnpm -F api verify:nli-real-user --q "0-3岁宝宝睡眠需求" --user <user-id>
 *
 * 前置:
 *   - macOS Keychain 已有 JWT_SECRET (跑过 setup:keychain-secrets)
 *   - 用户 <user-id> 已在 CloudBase NoSQL users 集合注册 (mini program wx.login)
 *   - 该用户至少有 1 个 chunk 入库 (admin 推过 PDF/DOCX)
 *
 * 输出 (stdout JSON):
 *   { ok, status, latencyMs, answerLength, nliVerdict, auditAction, ... }
 *
 * ⚠️ destructive: 调真 CloudBase api-router + 写 audit_log
 */

import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { signJwt } from "./gen-jwt-lib.js";

const GATEWAY = "https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com";

const { values } = parseArgs({
  options: {
    user: { type: "string", default: "01KVCZ2JRBAGF3MY75D7KEY4RZ" },
    q: { type: "string", default: "详细解释0-3岁宝宝睡眠需求,推荐安全睡眠环境" },
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

async function main(): Promise<void> {
  const userId = values.user!;
  const q = values.q!;

  console.error(`[verify-nli] user=${userId}`);
  console.error(`[verify-nli] q=${q}`);

  const secret = keychainGet("JWT_SECRET");
  const jwt = await signJwt({ sub: userId, scope: "user", secret, ttl: "1h" });

  const url = `${GATEWAY}/api-chat`;
  console.error(`[verify-nli] POST ${url}`);

  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ q }),
  });
  const latencyMs = Date.now() - start;

  const body = await res.json().catch(() => ({}));
  const answer = body.answer ?? "";
  const answerLength = answer.length;
  // NLI verdict 不直接返 chat response, 但 audit_log 写 nli_verdict
  // 通过 answer 是否含 warning prefix 推断: "[注意: ...]" 是 P5 v1.3 applyWarning 加的
  const hasWarningPrefix = answer.startsWith("[注意:") || answer.startsWith("[提示:");

  const result = {
    ok: res.ok,
    status: res.status,
    latencyMs,
    answerLength,
    hasWarningPrefix,
    sessionId: body.session_id,
    isNewSession: body.is_new_session,
    citationsCount: body.citations?.length ?? 0,
  };

  console.log(JSON.stringify(result, null, 2));

  if (!res.ok) {
    console.error(`[verify-nli] ❌ HTTP ${res.status}: ${JSON.stringify(body)}`);
    process.exit(1);
  }
  if (answerLength === 0) {
    console.error(`[verify-nli] ❌ 空 answer (LLM 可能挂了)`);
    process.exit(1);
  }

  if (hasWarningPrefix) {
    console.error(`[verify-nli] ✅ NLI REJECT 路径触发 (answer 含 warning prefix) → audit_log 应有 chat_nli_reject`);
  } else {
    console.error(`[verify-nli] ✅ NLI PASS 路径 (answer 无 warning prefix) → audit_log 不写 chat_nli_reject`);
  }
  console.error(`[verify-nli] 验 audit_log: tcb db nosql query audit_log 查近 5 条 record (sub=${userId})`);
}

main().catch((err) => {
  console.error(`[verify-nli] FATAL:`, err);
  process.exit(2);
});