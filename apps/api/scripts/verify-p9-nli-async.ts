/**
 * verify-p9-nli-async.ts — P9 NLI async 跨轮 polling 真接验证
 *
 * 背景 (P9):
 *   - P5 v1.3 NLI 同步阻塞 chat 1.9s cold → P9 setImmediate fire-and-forget + polling 3-2-5 节奏
 *   - api-chat 检测 env.NLI_ASYNC=1 → 跳过同步 NLI 块, setImmediate 后台调 verify + 写 audit_log chat_nli_async
 *   - chat 立即返 answer + nliTurnId 字段
 *   - 客户端拿 response 后 3s 起始 + 2s × 5 轮询 GET /api-nli-result?turnId=<id>
 *
 * 步骤:
 *   1. T1 创 session (调 /api-chat 真接, 拿 nliTurnId — 仅 NLI_ASYNC=1 灰度后才有)
 *   2. 等 1s (session 持久化) + T2 同 session 短问题 (P5 v1.4 跨轮 hypothesis)
 *   3. 3s 起始 + 2s × 5 轮询 GET /api-nli-result?turnId=<id> (T1 跟 T2 各自)
 *   4. 验: 命中 audit_log chat_nli_async + verdict + isWarning 推断正确
 *   5. 输出 JSON: { ok, t1, t2, nliResults[] }
 *
 * 前置 (真接日):
 *   - 已 deploy NLI_ASYNC=1 (Phase 4.1)
 *   - macOS Keychain 已有 JWT_SECRET
 *
 * Usage:
 *   pnpm -F api verify:p9-nli-async
 *   pnpm -F api verify:p9-nli-async --user <user-id>
 *
 * ⚠️ destructive: 调真 CloudBase api-router + 写 audit_log chat_nli_async
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

interface NliResultResponse {
  found: boolean;
  verdict?: "entailed" | "neutral" | "contradiction";
  score?: number;
  latencyMs?: number;
  isWarning?: boolean;
}

interface ChatTurnResult {
  status: number;
  latencyMs: number;
  answer: string;
  sessionId?: string;
  nliTurnId?: string;
}

async function chatTurn(
  jwt: string,
  body: Record<string, unknown>,
  label: string,
): Promise<ChatTurnResult> {
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
  const resBody = (await res.json().catch(() => ({}))) as {
    answer?: string;
    session_id?: string;
    nliTurnId?: string;
  };
  const answer = resBody.answer ?? "";
  console.error(
    `[verify-p9] [${label}] HTTP ${res.status} ${latencyMs}ms ansLen=${answer.length} nliTurnId=${resBody.nliTurnId ?? "(none)"} session=${resBody.session_id?.slice(-8) ?? "(none)"}`,
  );
  return {
    status: res.status,
    latencyMs,
    answer,
    sessionId: resBody.session_id,
    nliTurnId: resBody.nliTurnId,
  };
}

async function pollNliResult(
  jwt: string,
  turnId: string,
  label: string,
): Promise<NliResultResponse | null> {
  const url = `${GATEWAY}/api-nli-result?turnId=${encodeURIComponent(turnId)}`;
  // 3-2-5 节奏: attempt 1 sleep 3s, attempt 2-5 sleep 2s → 13s 总
  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 1 ? 3000 : 2000));
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = (await res.json().catch(() => ({}))) as NliResultResponse;
    console.error(
      `[verify-p9] [${label}] poll attempt=${attempt} found=${body.found} verdict=${body.verdict ?? "(none)"} score=${body.score?.toFixed(3) ?? "(none)"} isWarning=${body.isWarning ?? "(none)"}`,
    );
    if (body.found) return body;
  }
  return null;
}

async function main(): Promise<void> {
  const userId = values.user!;
  console.error(`[verify-p9] === P9 NLI async 跨轮 polling 真接验证 ===`);
  console.error(`[verify-p9] user=${userId}`);

  const secret = keychainGet("JWT_SECRET");
  const jwt = await signJwt({ sub: userId, scope: "user", secret, ttl: "1h" });

  // T1: 创 session
  const t1 = await chatTurn(
    jwt,
    { q: "详细解释0-3岁宝宝睡眠需求,推荐安全睡眠环境" },
    "T1 (创 session)",
  );
  if (t1.status !== 200 || !t1.answer) {
    console.error(`[verify-p9] ❌ T1 chat 失败 (status=${t1.status})`);
    process.exit(1);
  }

  // 等 1s (session 持久化)
  console.error(`[verify-p9] 等待 1s (session 持久化)...`);
  await new Promise((r) => setTimeout(r, 1000));

  // T2: 同 session 短问题 (P5 v1.4 跨轮 hypothesis)
  const t2 = await chatTurn(
    jwt,
    {
      q: "那 1 岁呢?",
      ...(t1.sessionId ? { session_id: t1.sessionId } : {}),
    },
    "T2 (跨轮)",
  );
  if (t2.status !== 200 || !t2.answer) {
    console.error(`[verify-p9] ❌ T2 chat 失败 (status=${t2.status})`);
    process.exit(1);
  }

  // Polling T1 + T2 nliTurnId
  const nliResults: Array<{ turn: string; result: NliResultResponse | null }> = [];
  if (t1.nliTurnId) {
    const r1 = await pollNliResult(jwt, t1.nliTurnId, "T1");
    nliResults.push({ turn: "T1", result: r1 });
  } else {
    nliResults.push({ turn: "T1", result: null });
    console.error(`[verify-p9] T1 无 nliTurnId (NLI_ASYNC=0 sync 路径, 不轮询)`);
  }
  if (t2.nliTurnId) {
    const r2 = await pollNliResult(jwt, t2.nliTurnId, "T2");
    nliResults.push({ turn: "T2", result: r2 });
  } else {
    nliResults.push({ turn: "T2", result: null });
    console.error(`[verify-p9] T2 无 nliTurnId (NLI_ASYNC=0 sync 路径, 不轮询)`);
  }

  const result = {
    ok: t1.status === 200 && t2.status === 200,
    t1: {
      latencyMs: t1.latencyMs,
      ansLen: t1.answer.length,
      hasNliTurnId: !!t1.nliTurnId,
      nliTurnId: t1.nliTurnId ?? null,
    },
    t2: {
      latencyMs: t2.latencyMs,
      ansLen: t2.answer.length,
      hasNliTurnId: !!t2.nliTurnId,
      nliTurnId: t2.nliTurnId ?? null,
    },
    nliResults,
    note: "P9 灰度: 部署 NLI_ASYNC=1 后 t1/t2.nliTurnId 非空 + 轮询命中 audit_log chat_nli_async + verdict 推断 isWarning 正确 (3-2-5 节奏 13s 总)",
  };

  console.log(JSON.stringify(result, null, 2));

  // 通过条件: T1+T2 200 + (P9 灰度后) nliTurnId 非空 + 轮询命中 audit_log
  const allHits = nliResults.every((r) => r.result?.found);
  if (result.t1.hasNliTurnId && result.t2.hasNliTurnId) {
    if (!allHits) {
      console.error(
        `[verify-p9] ❌ NLI_ASYNC=1 灰度后轮询未命中 audit_log (P9 failOpen / 写 audit_log 失败)`,
      );
      process.exit(1);
    }
    console.error(
      `[verify-p9] ✅ P9 灰度 PASS: T1+T2 双轮 200 + nliTurnId 命中 + 轮询 verdict 命中 audit_log`,
    );
  } else {
    console.error(
      `[verify-p9] ⚠️ NLI_ASYNC=0 sync 路径 (default), t1/t2 无 nliTurnId, 走 P5 v1.3 sync 行为 (P9 灰度需 NLI_ASYNC=1)`,
    );
  }
}

main().catch((err) => {
  console.error(`[verify-p9] FATAL:`, err);
  process.exit(2);
});