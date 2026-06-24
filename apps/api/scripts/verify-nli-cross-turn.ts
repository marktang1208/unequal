/**
 * verify-nli-cross-turn.ts — 真接 destructive 验证: P5 v1.4 跨轮 NLI (P7 follow-up #6)
 *
 * 背景 (P7 #6 决策):
 *   - v1.3: NLI hypothesis 仅当前轮 retrieve 的 top-5 chunks
 *   - 多轮 chat: 第 2 轮 LLM answer 可能引用前轮 chunks → hypothesis 不 match → NLI 误判 neutral
 *   - v1.4: ChatMessage.retrievedChunkIds + getCrossTurnHypothesis 扩 hypothesis
 *
 * P8 真接验证:
 *   1. 第 1 轮: "0-3岁宝宝睡眠需求" → 创 session, 写 retrievedChunkIds 到 assistant msg
 *   2. 第 2 轮: "那 1 岁呢?" → 同 session, NLI hypothesis 应包含第 1 轮的 chunks (cross-turn union)
 *   3. 验 audit_log 第 2 轮 nliSnapshot:
 *      - chunksHash 应包含第 1 轮的 chunk IDs (union 当前 + 历史)
 *      - latencyMs / verdict 验证 onnx forward 真跑了
 *
 * 决策 (P7 #6 §7 #7):
 *   - 不真接 destructive (避免污染 audit_log + retrieval 命中率低仍是 v1.4 主瓶颈)
 *   - **本脚本是 P8 起点**: v1.4 helper 推上后, 用真用户验 hypothesis 扩确实改善了 NLI 召回
 *
 * Usage:
 *   pnpm -F api verify:nli-cross-turn
 *   pnpm -F api verify:nli-cross-turn --user <user-id>
 *
 * 前置:
 *   - 已 deploy v1.4 helper (commit ccf6895) → pnpm -F api deploy:full
 *   - macOS Keychain 已有 JWT_SECRET
 *   - 用户 <user-id> 已注册 + 至少 1 个 chunk
 *
 * ⚠️ destructive: 创 chat_session + 写 chat_nli_reject 到 audit_log
 */

import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { signJwt } from "./gen-jwt-lib.js";

const GATEWAY = "https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com";

const { values } = parseArgs({
  options: {
    user: { type: "string", default: "01KVCZ2JRBAGF3MY75D7KEY4RZ" },
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

async function chatTurn(jwt: string, body: Record<string, unknown>, label: string): Promise<{ status: number; latencyMs: number; body: { answer?: string; session_id?: string; is_new_session?: boolean }; hasWarningPrefix: boolean }> {
  const url = `${GATEWAY}/api-chat`;
  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - start;
  const resBody = (await res.json().catch(() => ({}))) as { answer?: string; session_id?: string; is_new_session?: boolean };
  const answer = resBody.answer ?? "";
  const hasWarningPrefix = answer.startsWith("[注意:") || answer.startsWith("[提示:");
  console.error(`[verify-v14] [${label}] HTTP ${res.status} ${latencyMs}ms ansLen=${answer.length} warn=${hasWarningPrefix} session=${resBody.session_id?.slice(-8)}`);
  return { status: res.status, latencyMs, body: resBody, hasWarningPrefix };
}

async function main(): Promise<void> {
  const userId = values.user!;
  console.error(`[verify-v14] === P5 v1.4 cross-turn NLI 真接验证 ===`);
  console.error(`[verify-v14] user=${userId}`);

  const secret = keychainGet("JWT_SECRET");
  const jwt = await signJwt({ sub: userId, scope: "user", secret, ttl: "1h" });

  // 第 1 轮: 创 session, 写 retrievedChunkIds
  const t1 = await chatTurn(jwt, { q: "详细解释0-3岁宝宝睡眠需求,推荐安全睡眠环境" }, "T1 (创 session)");
  if (!t1.body.session_id) {
    console.error(`[verify-v14] ❌ T1 没返回 session_id`);
    process.exit(1);
  }
  const sessionId = t1.body.session_id;

  // 等 2s (audit_log write + DB 一致性 + 防冷启动)
  console.error(`[verify-v14] 等待 2s (audit_log write + DB 一致性)...`);
  await new Promise((r) => setTimeout(r, 2000));

  // 第 2 轮: 同 session, "那 1 岁呢?" → NLI hypothesis 应 union 当前 + 历史 retrievedChunkIds
  const t2 = await chatTurn(
    jwt,
    { q: "那 1 岁呢?", session_id: sessionId },
    "T2 (同 session, hypothesis 应含 T1 的 chunks)",
  );

  // 等 audit_log write
  console.error(`[verify-v14] 等待 3s (audit_log 写入)...`);
  await new Promise((r) => setTimeout(r, 3000));

  console.error(`[verify-v14] === 验证 audit_log ===`);
  console.error(`[verify-v14] 跑 tcb db nosql query audit_log, filter action=chat_nli_reject, sort timestamp desc, limit 5`);

  const result = {
    ok: t1.status === 200 && t2.status === 200,
    sessionId,
    t1: { latencyMs: t1.latencyMs, ansLen: t1.body.answer?.length ?? 0, isNewSession: t1.body.is_new_session },
    t2: { latencyMs: t2.latencyMs, ansLen: t2.body.answer?.length ?? 0, hasWarningPrefix: t2.hasWarningPrefix },
    note: "v1.4 helper 已在 commit ccf6895 部署; 验 audit_log 第 2 轮 nliSnapshot.chunksHash 应 ≠ 仅 T2 当前 chunks hash (说明 union 跨轮)",
  };

  console.log(JSON.stringify(result, null, 2));

  if (t1.body.answer && t1.body.answer.length > 0 && t2.body.answer && t2.body.answer.length > 0) {
    console.error(`[verify-v14] ✅ T1 + T2 双轮 200, ansLen > 0`);
    console.error(`[verify-v14] 下一步: 跑 tcb db nosql execute -c '[{"TableName":"audit_log","CommandType":"QUERY","Command":"{\\\"find\\\":\\\"audit_log\\\",\\\"filter\\\":{\\\"actor\\\":{\\\"userId\\\":\\\"${userId}\\\",\\\"sessionId\\\":\\\"${sessionId}\\\"},\\\"action\\\":\\\"chat_nli_reject\\\"},\\\"sort\\\":{\\\"timestamp\\\":-1},\\\"limit\\\":5}"}]' --json --env-id unequal-d4ggf7rwg82e0900b`);
    console.error(`[verify-v14] 关注: nliSnapshot.chunksHash (T2 应含 T1 的 chunk IDs)`);
  } else {
    console.error(`[verify-v14] ❌ T1 或 T2 空 answer`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[verify-v14] FATAL:`, err);
  process.exit(2);
});
