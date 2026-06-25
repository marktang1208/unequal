/**
 * verify-p8-vector-db.ts — P8 Phase 4 真接验证 (4 步)
 *
 * 占位: 主线程在 P8 灰度时实现各 step。当前阶段只 export 入口 + 4 step stub,
 *       保证 tsx 能起, package.json script 能跑, 后续真接日逐步填实现。
 *
 * 步骤:
 *   1. 验云端 25 vars 完整 (含 VECTOR_STORE=pg + PG_CONNECTION_STRING)
 *   2. verify:nli-cross-turn (P8 现有) — T1+T2 双轮 200, retrieval P99 < 100ms
 *   3. 查 audit_log NLI reject 7 天趋势 (vs P7 #3 baseline 30%+)
 *   4. 验 VECTOR_STORE=pg 真切流 (handler 日志走 PG 分支)
 *
 * 决策:
 *   - step1: 调 cloudbase SDK ListFunctionConfig 验 25 vars (14 template + 9 secrets + VECTOR_STORE + PG_CONNECTION_STRING)
 *   - step2: exec "pnpm -F api verify:nli-cross-turn", 抓 latencyMs
 *   - step3: 调 admin SDK 查 audit_log collection, filter action=chat_nli_reject, sort timestamp desc, limit 7 天
 *   - step4: 调 /api-chat 看 handler 日志 (走 PG 分支会含 "[api-chat] PG retrieval" 调过; nosql 不会)
 *
 * Usage:
 *   pnpm -F api verify:p8-vector-db
 *
 * 前置 (主线程灰度日填):
 *   - 已 deploy VECTOR_STORE=pg + PG_CONNECTION_STRING
 *   - macOS Keychain 已有 JWT_SECRET + ADMIN_TOKEN + CLOUDBASE_SECRET_ID/KEY + PG_CONNECTION_STRING
 */

import { execSync } from "node:child_process";

const KEYCHAIN_ACCOUNT = "unequal-deploy";
const KEYCHAIN_PREFIX = "unequal:api-router:";

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

async function step1_verifyEnvVars(): Promise<StepResult> {
  // TODO: 调 cloudbase SDK ListFunctionConfig 验 25 vars 完整
  // 期望: 14 template + 9 secrets + VECTOR_STORE(=pg) + PG_CONNECTION_STRING(非空) = 25 vars
  void keychainGet; // 占位引用,避免 unused 警告 (keychainGet 在 step2-4 真接时用)
  return { passed: false, detail: "TODO: 实现 ListFunctionConfig 验 25 vars" };
}

async function step2_runNliCrossTurn(): Promise<StepResult> {
  // TODO: exec "pnpm -F api verify:nli-cross-turn", 抓 T1+T2 latencyMs
  // 期望: T1+T2 双轮 200, retrieval 部分 P99 < 100ms
  return { passed: false, detail: "TODO: 实现 exec verify:nli-cross-turn + 抓 latency" };
}

async function step3_checkNliRejectTrend(): Promise<StepResult> {
  // TODO: 调 admin SDK 查 audit_log collection, filter action=chat_nli_reject, sort timestamp desc, 7 天窗口
  // 期望: reject 率 < P7 baseline 30%+ (越大越差)
  return { passed: false, detail: "TODO: 实现 audit_log 7 天 reject count + 趋势对比" };
}

async function step4_verifyVectorStorePg(): Promise<StepResult> {
  // TODO: 调 /api-chat (admin 1 user), 验 handler 日志走 PG 分支
  // 期望: cloudbase fn log 含 "[api-chat] PG retrieval" (调过 PG) 或 handler 返 retrieval 命中数 > P7 现状
  return { passed: false, detail: "TODO: 实现 /api-chat 真接 + 验 PG 路径" };
}

async function main(): Promise<void> {
  const results: Array<[string, StepResult]> = [];
  results.push(["step1_env_vars", await step1_verifyEnvVars()]);
  results.push(["step2_nli_cross_turn", await step2_runNliCrossTurn()]);
  results.push(["step3_nli_reject_trend", await step3_checkNliRejectTrend()]);
  results.push(["step4_vector_store_pg", await step4_verifyVectorStorePg()]);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ results }, null, 2));

  const failed = results.filter(([, r]) => !r.passed).length;
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`[verify-p8-vector-db] ❌ ${failed}/${results.length} step(s) FAILED — 主线程待填实现`);
    process.exit(1);
  } else {
    // eslint-disable-next-line no-console
    console.error(`[verify-p8-vector-db] ✅ ${results.length}/${results.length} PASS`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[verify-p8-vector-db] FATAL:`, err);
  process.exit(2);
});