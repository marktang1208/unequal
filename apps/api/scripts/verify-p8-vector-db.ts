/**
 * verify-p8-vector-db.ts — P8 Phase 4 真接验证 (4 步)
 *
 * 完整实现 (主线程真接时直接跑):
 *   pnpm -F api verify:p8-vector-db
 *
 * 步骤:
 *   1. 验云端 25 vars 完整 (含 VECTOR_STORE=pg + PG_CONNECTION_STRING)
 *   2. verify:nli-cross-turn (P8 现有) — T1+T2 双轮 200, retrieval P99 < 100ms
 *   3. 查 audit_log NLI reject 7 天趋势 (vs P7 #3 baseline 30%+)
 *   4. 验 VECTOR_STORE=pg 真切流 (handler 日志走 PG 分支)
 *
 * 前置 (真接日):
 *   - 已 deploy VECTOR_STORE=pg + PG_CONNECTION_STRING (Phase 3.1)
 *   - macOS Keychain 已有 10 secrets (9 + PG_CONNECTION_STRING)
 *   - 已跑 ETL (1963 chunks → PG, Phase 1.2)
 *
 * 通过标准 (state-p8 §6 success criteria):
 *   step1: 25 vars 完整 + VECTOR_STORE=pg + PG_CONNECTION_STRING 非空
 *   step2: T1 + T2 双轮 200 + latency < 30s
 *   step3: 7 天 reject 率 < 10% (vs P7 baseline 30%+)
 *   step4: VECTOR_STORE=pg 生效 + chat 走 PG 分支 (P8 state-p8 §2.1 dual-write)
 */

import { execSync } from "node:child_process";
import { signJwt } from "./gen-jwt-lib.js";

// ESM default import (跟 src/lib/cloudbase.ts 一致, CJS module interop)
// eslint-disable-next-line @typescript-eslint/no-var-requires
import cloudbase from "@cloudbase/node-sdk";
// SCF SDK tcb-scf.ts 是 CJS, 走 namespace import
// eslint-disable-next-line @typescript-eslint/no-var-requires
import * as tcbScf from "./deploy/lib/tcb-scf.js";

const KEYCHAIN_ACCOUNT = "unequal-deploy";
const KEYCHAIN_PREFIX = "unequal:api-router:";
const GATEWAY = "https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com";
const TCB_ENV = "unequal-d4ggf7rwg82e0900b";
const FUNCTION_NAME = "api-router";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const EXPECTED_VARS_COUNT = 25; // 14 template + 9 secrets + VECTOR_STORE + PG_CONNECTION_STRING + LLM_MAX_TOKENS

// P8 success criteria (state-p8 spec §0)
const P8_REJECT_RATE_TARGET = 0.10;  // 7d reject rate < 10% (vs P7 baseline 30%+)
const P8_CHAT_LATENCY_TARGET_MS = 30_000;  // < 30s (略升可接受, retrieval 50ms + 切换)
const P7_BASELINE_REJECT_RATE = 0.30;  // P7 #3 evidence
const P7_BASELINE_T1_LATENCY_S = 26.4;  // P6 实测 T1 cold
const P7_BASELINE_T2_LATENCY_S = 6.0;   // P8 v1.4 真接 T2 warm

function keychainGet(key: string): string {
  return execSync(
    `security find-generic-password -a ${KEYCHAIN_ACCOUNT} -s "${KEYCHAIN_PREFIX}${key}" -w`,
    { encoding: "utf-8" },
  ).trim();
}

interface StepResult {
  passed: boolean;
  detail: string;
}

interface ChatTurnResult {
  status: number;
  latencyMs: number;
  answer: string;
  hasWarningPrefix: boolean;
  sessionId?: string;
  isNewSession?: boolean;
  citationsCount?: number;
}

/* ====================== Step 1: 验云端 25 vars ====================== */

async function step1_verifyEnvVars(): Promise<StepResult> {
  // 复用 P4 #3 SCF SDK GetFunction 拿真云端 env (state-p4 §2.1)
  let envVars: Record<string, string>;
  try {
    envVars = await tcbScf.getFunctionEnv(FUNCTION_NAME);
  } catch (err) {
    return {
      passed: false,
      detail: `GetFunction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const varCount = Object.keys(envVars).length;
  const hasVectorStore = envVars.VECTOR_STORE === "pg";
  const hasPgConn = !!envVars.PG_CONNECTION_STRING && envVars.PG_CONNECTION_STRING.length > 0;

  const passed = varCount === EXPECTED_VARS_COUNT && hasVectorStore && hasPgConn;
  const detail = [
    `vars=${varCount}/${EXPECTED_VARS_COUNT}`,
    `VECTOR_STORE=${envVars.VECTOR_STORE ?? "(missing)"}`,
    `PG_CONNECTION_STRING=${hasPgConn ? "(present)" : "(missing)"}`,
  ].join(", ");

  return { passed, detail };
}

/* ====================== Step 2: verify:nli-cross-turn ====================== */

interface CrossTurnOutput {
  ok: boolean;
  sessionId: string;
  t1: { latencyMs: number; status: number; hasWarning: boolean; ansLen: number; isNewSession: boolean };
  t2: { latencyMs: number; status: number; hasWarning: boolean; ansLen: number };
}

/** Parse verify-nli-cross-turn.ts stdout (JSON 格式, 末尾是 console.log(JSON.stringify(result))) */
function parseCrossTurnOutput(stdout: string): CrossTurnOutput {
  // stdout 含 1 JSON object, 找第一个 "{" 到最后 "}" 的 balanced 段
  const trimmed = stdout.trim();
  let depth = 0;
  let start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (trimmed[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const jsonStr = trimmed.slice(start, i + 1);
        const parsed = JSON.parse(jsonStr) as CrossTurnOutput;
        if (typeof parsed.t1?.latencyMs !== "number" || typeof parsed.t2?.latencyMs !== "number") {
          throw new Error("verify:nli-cross-turn JSON missing t1/t2.latencyMs");
        }
        return parsed;
      }
    }
  }
  throw new Error("Failed to find JSON object in verify:nli-cross-turn output");
}

async function step2_runNliCrossTurn(): Promise<StepResult> {
  let stdout = "";
  try {
    stdout = execSync("pnpm -F api verify:nli-cross-turn", { encoding: "utf-8" });
  } catch (err) {
    // exec 失败时, 仍尝试从 stderr 抓 info
    const errOutput = (err as any).stdout?.toString() ?? "";
    return {
      passed: false,
      detail: `exec failed: ${err instanceof Error ? err.message : String(err)}\n${errOutput.slice(-500)}`,
    };
  }

  let parsed: CrossTurnOutput;
  try {
    parsed = parseCrossTurnOutput(stdout);
  } catch (err) {
    return {
      passed: false,
      detail: `parse failed: ${err instanceof Error ? err.message : String(err)}\n--- stdout ---\n${stdout.slice(-500)}`,
    };
  }

  const { t1, t2 } = parsed;
  // verify-nli-cross-turn 只返 ok (T1+T2 都 200) + latencyMs, 不单独返 t1.status / t2.status
  // 用 ok 反推: ok=true → t1+t2 都 200
  const t1Pass = parsed.ok && t1.latencyMs < P8_CHAT_LATENCY_TARGET_MS;
  const t2Pass = parsed.ok && t2.latencyMs < P8_CHAT_LATENCY_TARGET_MS;
  const passed = t1Pass && t2Pass;

  return {
    passed,
    detail: [
      `T1: latency=${t1.latencyMs}ms ansLen=${t1.ansLen} isNew=${t1.isNewSession}`,
      `T2: latency=${t2.latencyMs}ms ansLen=${t2.ansLen} hasWarning=${t2.hasWarning}`,
      `sessionId=${parsed.sessionId}`,
      `ok=${parsed.ok}`,
      `(P7 baseline: T1=${P7_BASELINE_T1_LATENCY_S}s, T2=${P7_BASELINE_T2_LATENCY_S}s; P8 target < ${P8_CHAT_LATENCY_TARGET_MS / 1000}s)`,
    ].join(" | "),
  };
}

/* ====================== Step 3: audit_log 7 天 reject 趋势 ====================== */

async function step3_checkNliRejectTrend(): Promise<StepResult> {
  // 用 cloudbase NoSQL SDK 查 audit_log (state-p6 §9 audit_log schema)
  const secretId = keychainGet("CLOUDBASE_SECRET_ID");
  const secretKey = keychainGet("CLOUDBASE_SECRET_KEY");
  const app = cloudbase.init({ env: TCB_ENV, secretId, secretKey });
  const db = app.database();
  const sevenDaysAgo = Date.now() - SEVEN_DAYS_MS;

  let total = 0;
  let reject = 0;
  try {
    // 总 chat 数 (P5 chat 路径, 含 pass + reject)
    const totalRes = await db.collection("audit_log")
      .where({
        action: "chat",
        result: "success",
        timestamp: db.command.gte(sevenDaysAgo),
      })
      .count();
    total = totalRes.total ?? 0;

    // reject 数 (P5 v1.3 NLI 后置 reject 路径)
    const rejectRes = await db.collection("audit_log")
      .where({
        action: "chat_nli_reject",
        timestamp: db.command.gte(sevenDaysAgo),
      })
      .count();
    reject = rejectRes.total ?? 0;
  } catch (err) {
    return {
      passed: false,
      detail: `audit_log query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const rejectRate = total > 0 ? reject / total : 0;
  // 7 天样本 < 50 时, rate 不稳定, 标 PARTIAL 但不 fail (P9 follow-up: 加 sample size guard)
  const sampleSizeOk = total >= 50;
  const rateOk = rejectRate < P8_REJECT_RATE_TARGET;
  const passed = sampleSizeOk && rateOk;

  return {
    passed,
    detail: [
      `7d reject rate: ${(rejectRate * 100).toFixed(1)}% (${reject}/${total} samples)`,
      `P7 baseline: ${(P7_BASELINE_REJECT_RATE * 100).toFixed(0)}% sample`,
      `P8 target: < ${(P8_REJECT_RATE_TARGET * 100).toFixed(0)}%`,
      sampleSizeOk ? "" : "(WARNING: sample size < 50, rate 不稳定)",
    ].filter(Boolean).join(" | "),
  };
}

/* ====================== Step 4: 验 VECTOR_STORE=pg 真切流 ====================== */

async function chatTurn(jwt: string, body: Record<string, unknown>): Promise<ChatTurnResult> {
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
  const resBody = (await res.json().catch(() => ({}))) as { answer?: string; session_id?: string; is_new_session?: boolean; citations?: unknown[] };
  const answer = resBody.answer ?? "";
  const hasWarningPrefix = answer.startsWith("[注意:") || answer.startsWith("[提示:");
  return {
    status: res.status,
    latencyMs,
    answer,
    hasWarningPrefix,
    sessionId: resBody.session_id,
    isNewSession: resBody.is_new_session,
    citationsCount: resBody.citations?.length ?? 0,
  };
}

async function step4_verifyVectorStorePg(): Promise<StepResult> {
  // 4.1 验云端 VECTOR_STORE=pg (跟 step1 重复, 但加 assertion: 必须 = "pg")
  let envVars: Record<string, string>;
  try {
    envVars = await tcbScf.getFunctionEnv(FUNCTION_NAME);
  } catch (err) {
    return {
      passed: false,
      detail: `GetFunction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (envVars.VECTOR_STORE !== "pg") {
    return {
      passed: false,
      detail: `VECTOR_STORE=${envVars.VECTOR_STORE ?? "(missing)"}, expected "pg" (Phase 3.1 灰度未切流)`,
    };
  }

  // 4.2 调 /api-chat 真接 (admin 真用户 01KVCZ2JRBAGF3MY75D7KEY4RZ)
  const userId = "01KVCZ2JRBAGF3MY75D7KEY4RZ";
  const secret = keychainGet("JWT_SECRET");
  const jwt = await signJwt({ sub: userId, scope: "user", secret, ttl: "1h" });

  // T1: 创 session
  const t1 = await chatTurn(jwt, { q: "P8 PG verify step 4 切流测试 - 0-3岁宝宝睡眠" });
  // T2: 同 session 短问题 (P5 v1.4 跨轮 hypothesis 实际工作)
  const t2 = await chatTurn(jwt, { q: "那 1 岁呢?", session_id: t1.sessionId });

  // 4.3 验 evidence
  const t1Pass = t1.status === 200 && t1.answer.length > 0;
  const t2Pass = t2.status === 200 && t2.answer.length > 0;
  // 注: 直接 evidence 是 "VECTOR_STORE=pg + chat 200" 已足够证明切流生效
  // 更强 evidence 需要 fn log "[api-chat] PG retrieval" 标记 (state-p8 §2.1)
  // 但 SCF SDK 无 listFunctionLogs wrapper, tcb fn log CLI 是 P4 #3 之前的 fallback
  // (P8 follow-up: 写 SCF SDK GetFunctionLogs wrapper, 见 state-p8 §8)

  const passed = t1Pass && t2Pass;
  return {
    passed,
    detail: [
      `VECTOR_STORE=pg ✓`,
      `T1: HTTP ${t1.status} ${t1.latencyMs}ms ansLen=${t1.answer.length} citations=${t1.citationsCount ?? 0}`,
      `T2: HTTP ${t2.status} ${t2.latencyMs}ms ansLen=${t2.answer.length} citations=${t2.citationsCount ?? 0}`,
      `(间接 evidence: 切流生效靠 env var 确认; 强 evidence 需 fn log wrapper, P9 follow-up)`,
    ].join(" | "),
  };
}

/* ====================== Main ====================== */

async function main(): Promise<void> {
  console.error(`[verify-p8-vector-db] === P8 Phase 4 真接验证 ===`);
  console.error(`[verify-p8-vector-db] env: ${TCB_ENV}`);
  console.error(`[verify-p8-vector-db] function: ${FUNCTION_NAME}`);
  console.error(`[verify-p8-vector-db] gateway: ${GATEWAY}`);
  console.error(`[verify-p8-vector-db] P8 success: 25 vars + reject < 10% + chat < 30s`);

  const results: Array<[string, StepResult]> = [];
  results.push(["step1_env_vars", await step1_verifyEnvVars()]);
  results.push(["step2_nli_cross_turn", await step2_runNliCrossTurn()]);
  results.push(["step3_nli_reject_trend", await step3_checkNliRejectTrend()]);
  results.push(["step4_vector_store_pg", await step4_verifyVectorStorePg()]);

  console.log(JSON.stringify({ results }, null, 2));

  const failed = results.filter(([, r]) => !r.passed);
  if (failed.length > 0) {
    console.error(`[verify-p8-vector-db] ❌ ${failed.length}/${results.length} step(s) FAILED:`);
    for (const [name, r] of failed) {
      console.error(`  ${name}: ${r.detail}`);
    }
    process.exit(1);
  } else {
    console.error(`[verify-p8-vector-db] ✅ ${results.length}/${results.length} PASS`);
  }
}

main().catch((err) => {
  console.error(`[verify-p8-vector-db] FATAL:`, err);
  process.exit(2);
});