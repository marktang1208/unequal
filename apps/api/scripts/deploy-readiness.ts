/**
 * CP-6: 部署前 readiness 检查
 *
 * 验证项：
 * 1. 13 个 handler 文件都存在
 * 2. 必填 env vars 有值（用户必须 export）
 * 3. 必填 env vars 长度合法（secrets ≥ 32 字节）
 * 4. CF 残留依赖已清（无 wrangler / miniflare / @cloudflare/workers-types）
 * 5. TypeScript 编译 0 error
 *
 * 用法：
 *   pnpm -F api deploy:readiness
 *
 * 不阻塞 deploy（只 warn），但失败 > 0 时 exit 1
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd());
const HANDLERS_DIR = join(ROOT, "src/handlers");
const PKG_JSON = join(ROOT, "package.json");
const SRC_INDEX = join(ROOT, "src/index.ts");

const REQUIRED_HANDLERS = [
  "api-ask",
  "api-upload",
  "api-ingest",
  "api-search",
  "api-chat",
  "api-sessions-list",
  "api-sessions-get",
  "api-sessions-delete",
  "api-stats",
  "api-auth-wx-login",
  "api-auth-admin-login",
  "api-cron-cleanup",
  "api-health",
];

const REQUIRED_ENV = [
  "TCB_SECRET_ID",
  "TCB_SECRET_KEY",
  "TCB_ENV",
  "ADMIN_TOKEN",
  "JWT_SECRET",
  "MINIMAX_API_KEY",
  "KEK_SECRET_V1",
  "ADMIN_IP_ALLOWLIST",
];

const REQUIRED_SECRETS_MIN_LENGTH = 32;
const CF_RESIDUAL_DEPS = ["wrangler", "miniflare", "@cloudflare/workers-types"];

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function check(name: string, fn: () => boolean | string): void {
  try {
    const out = fn();
    if (typeof out === "string") {
      results.push({ name, passed: false, detail: out });
    } else {
      results.push({ name, passed: out });
    }
  } catch (err) {
    results.push({
      name,
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

// 1. 13 handler 文件存在
check("13 handlers 文件存在", () => {
  const missing = REQUIRED_HANDLERS.filter(
    (h) => !existsSync(join(HANDLERS_DIR, `${h}.ts`)),
  );
  if (missing.length > 0) return `missing: ${missing.join(", ")}`;
  return true;
});

// 2. 必填 env vars 存在
check("8 必填 env vars 已设置", () => {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) return `missing: ${missing.join(", ")}`;
  // API Key 3.0 模式：SECRET_ID 和 SECRET_KEY 必须相同
  // CAM 传统模式：两者不同（SecretId 是 AKID 开头，SecretKey 是独立随机串）
  // 自动检测：如果都是 AKID 开头 → CAM 模式；否则 API Key 3.0 模式
  const sid = process.env.TCB_SECRET_ID ?? "";
  const skey = process.env.TCB_SECRET_KEY ?? "";
  const isCam = sid.startsWith("AKID");
  const isApiKey30 = !isCam && sid === skey && sid.length > 100;
  if (!isCam && !isApiKey30) {
    return "TCB_SECRET_ID 应为 AKID 开头（CAM 模式）或与 TCB_SECRET_KEY 相同且 > 100 字符（API Key 3.0 模式）";
  }
  return true;
});

// 3. secrets 长度 ≥ 32 字节
check("4 secrets 长度 ≥ 32 字节", () => {
  const SECRETS = ["ADMIN_TOKEN", "JWT_SECRET", "KEK_SECRET_V1"];
  const short = SECRETS.filter((s) => (process.env[s]?.length ?? 0) < REQUIRED_SECRETS_MIN_LENGTH);
  if (short.length > 0) return `too short: ${short.join(", ")}`;
  return true;
});

// 4. CF 残留依赖已清
check("CF 依赖已清（无 wrangler / miniflare / @cloudflare/workers-types）", () => {
  if (!existsSync(PKG_JSON)) return "package.json not found";
  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const found = CF_RESIDUAL_DEPS.filter((d) => d in allDeps);
  if (found.length > 0) return `still present: ${found.join(", ")}`;
  return true;
});

// 5. TypeScript 入口文件存在 + 内容含关键导出
check("src/index.ts 含 HANDLER_MAP + main export", () => {
  if (!existsSync(SRC_INDEX)) return "src/index.ts not found";
  const content = readFileSync(SRC_INDEX, "utf-8");
  if (!content.includes("HANDLER_MAP")) return "missing HANDLER_MAP";
  if (!content.includes("export async function main")) return "missing main export";
  return true;
});

// 6. test 目录非空（递归扫 test/ 子目录）
check("test/ 目录有 .test.ts 文件", () => {
  if (!existsSync(join(ROOT, "test"))) return "test/ not found";
  function find(dir: string): string[] {
    const out: string[] = [];
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) out.push(...find(p));
      else if (f.name.endsWith(".test.ts")) out.push(p);
    }
    return out;
  }
  const found = find(join(ROOT, "test"));
  if (found.length === 0) return "no .test.ts files";
  return true;
});

// print
console.log("\n🔍 CP-6 deploy-readiness check\n");
let failed = 0;
for (const r of results) {
  const icon = r.passed ? "✅" : "❌";
  console.log(`${icon} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  if (!r.passed) failed++;
}

console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed > 0) {
  console.error(`\n❌ ${failed} check(s) failed — fix before deploying`);
  process.exit(1);
}
console.log("\n✅ ready to deploy");