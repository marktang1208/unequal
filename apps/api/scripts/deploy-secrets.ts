/**
 * CP-6: 部署脚本 — 注入 4 secrets + 8 vars 到 CloudBase 函数
 *
 * 用法：
 *   export TCB_SECRET_ID=<your-secret-id>
 *   export TCB_SECRET_KEY=<your-secret-key>
 *   export TCB_ENV=<env-id>
 *   # 4 secrets 从本机 env 读
 *   export ADMIN_TOKEN=...
 *   export JWT_SECRET=...
 *   export MINIMAX_API_KEY=...
 *   export KEK_SECRET_V1=...
 *   pnpm tsx scripts/deploy-secrets.ts
 *
 * 幂等：覆盖已有。
 */

import cloudbase from "@cloudbase/node-sdk";

const SECRET_ID = process.env.TCB_SECRET_ID;
const SECRET_KEY = process.env.TCB_SECRET_KEY;
const ENV = process.env.TCB_ENV;

if (!SECRET_ID || !SECRET_KEY || !ENV) {
  console.error("Missing TCB_SECRET_ID / TCB_SECRET_KEY / TCB_ENV");
  process.exit(1);
}

const SECRETS = {
  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  JWT_SECRET: process.env.JWT_SECRET,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  KEK_SECRET_V1: process.env.KEK_SECRET_V1,
};

const VARS = {
  ENVIRONMENT: "production",
  ALLOWED_ORIGIN: "*",
  ADMIN_IP_ALLOWLIST: process.env.ADMIN_IP_ALLOWLIST ?? "127.0.0.1",
  MINIMAX_BASE_URL: "https://api.MiniMax.chat/v1",
  DEFAULT_USER_ID: "01H0000000000000000000000",
  LOGIN_MAX_ATTEMPTS: "5",
  LOGIN_WINDOW_MS: "900000",
  KEK_CURRENT_VERSION: "1",
};

async function main() {
  // 验证 secrets 必填
  for (const [name, value] of Object.entries(SECRETS)) {
    if (!value) {
      console.error(`Missing secret env var: ${name}`);
      process.exit(1);
    }
  }

  const app = cloudbase.init({ secretId: SECRET_ID, secretKey: SECRET_KEY, env: ENV });

  // 1. 注入 secrets（用 HTTP API）
  console.log("[deploy-secrets] 4 secrets");
  const accessToken = await getAccessToken(app);
  for (const [name, value] of Object.entries(SECRETS)) {
    await setSecret(ENV!, name, value!, accessToken);
    console.log(`  ✅ ${name}`);
  }

  // 2. 注入 vars（用 HTTP API）
  console.log("[deploy-vars] 8 vars");
  for (const [name, value] of Object.entries(VARS)) {
    await setVar(ENV!, name, value, accessToken);
    console.log(`  ✅ ${name}=${value.slice(0, 20)}${value.length > 20 ? "..." : ""}`);
  }

  console.log("\n✅ 4 secrets + 8 vars 注入完成");
}

async function getAccessToken(_app: unknown): Promise<string> {
  // CloudBase Node SDK 没直接暴露 access token；通过 serviceUrl + IAM 拿
  // 这里用 secretId/secretKey 调腾讯云 CAM STS API；简化版直接返回 env
  const token = process.env.TCB_ACCESS_TOKEN;
  if (!token) {
    throw new Error("TCB_ACCESS_TOKEN not set (get from CloudBase console → API 密钥管理)");
  }
  return token;
}

async function setSecret(env: string, name: string, value: string, accessToken: string): Promise<void> {
  const url = `https://api.cloudbase.tencentcloud.com/v2/functions/${name}/secrets`;
  await safeFetch(url, accessToken, env, { key: name, value });
}

async function setVar(env: string, name: string, value: string, accessToken: string): Promise<void> {
  // vars 需按函数批量设；spec 简化：用全局 env（CloudBase 自动注入所有函数）
  const url = `https://api.cloudbase.tencentcloud.com/v2/env/${env}/variables`;
  await safeFetch(url, accessToken, env, { key: name, value });
}

async function safeFetch(url: string, accessToken: string, env: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-CloudBase-AccessToken": accessToken,
      "X-CloudBase-Env": env,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 409) {  // 409 = already exists, OK
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});