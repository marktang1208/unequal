/**
 * sync-cloudbasrc.ts — 把 apps/api/cloudbaserc.json template + 9 Keychain secrets
 *                      merge 到 apps/miniprogram/cloudfunctions/api-router/cloudbaserc.json
 *
 * P7 follow-up of P6 state-p6 §7 P1 #5:
 *   "auto-sync miniprogram path cloudbaserc.json from apps/api/cloudbaserc.json + Keychain secrets"
 *
 * 背景 (P6 真接发现):
 *   - tcb fn deploy 用 --dir 指向 minipgm path, 但读 cloudbaserc.json (不带 dot 那个) 拿 env vars
 *   - P6 真接时手动 cp cloudbaserc.json + 手动填 9 Keychain secrets → 23 vars
 *   - 每次改 cloudbaserc.json 或换 Keychain secret 都要手动同步 → 容易遗漏
 *
 * 解法: deploy-build.ts 末尾自动调 syncCloudbasrcFromTemplate()
 *   - 读 apps/api/cloudbaserc.json (source of truth for non-secret vars)
 *   - 从 macOS Keychain 读 9 secrets (跟 push.ts SECRETS 一致)
 *   - merge → 写到 minipgm path (已 gitignore, 不会被 commit)
 *
 * 测试桩: keychainGet 通过参数注入 (默认从 ./keychain.js 拉, 测试用 vi.fn 注入)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { keychainGet as defaultKeychainGet } from "./keychain.js";

/** 9 个 Keychain secrets — 必须跟 commands/push.ts SECRETS 完全一致 */
export const SECRETS = [
  "ADMIN_TOKEN",
  "JWT_SECRET",
  "MINIMAX_API_KEY",
  "KEK_SECRET_V1",
  "INGEST_PROXY_SECRET",
  "ADMIN_IP_ALLOWLIST",
  "SILICONFLOW_API_KEY",
  // P6 Phase 5: runtime onnx COS downloader 需要 (cloudbaserc.json env vars 是 cloud function 唯一来源)
  "CLOUDBASE_SECRET_ID",
  "CLOUDBASE_SECRET_KEY",
] as const;

export interface SyncCloudbasrcOptions {
  /** source template 路径, 默认 apps/api/cloudbaserc.json */
  templatePath: string;
  /** target 写入路径, 默认 apps/miniprogram/cloudfunctions/api-router/cloudbaserc.json */
  targetPath: string;
  /** keychain 读取函数 (test 注入) */
  keychainGet?: (key: string) => string;
}

export interface CloudbasrcTemplate {
  version: string;
  envId: string;
  functionRoot: string;
  functions: Array<{
    name: string;
    type: string;
    runtime: string;
    handler: string;
    timeout: number;
    memorySize: number;
    installDependency: boolean;
    envVariables: Record<string, string>;
    [key: string]: unknown;
  }>;
}

/**
 * 同步 cloudbaserc.json: 读 template + 9 Keychain secrets → merge → 写 target
 *
 * 抛错条件:
 *   - templatePath 不存在 → throw (含路径提示)
 *   - template 不是合法 JSON → throw
 *   - template 缺 functions[0] / envVariables → throw
 *   - keychainGet 抛错 (Keychain 缺 secret) → throw (透传)
 */
export async function syncCloudbasrcFromTemplate(opts: SyncCloudbasrcOptions): Promise<void> {
  const keychainGet = opts.keychainGet ?? defaultKeychainGet;

  if (!existsSync(opts.templatePath)) {
    throw new Error(`syncCloudbasrcFromTemplate: template not found at ${opts.templatePath}`);
  }

  const raw = readFileSync(opts.templatePath, "utf-8");
  let template: CloudbasrcTemplate;
  try {
    template = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `syncCloudbasrcFromTemplate: failed to parse ${opts.templatePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!template.functions?.[0]?.envVariables) {
    throw new Error(
      `syncCloudbasrcFromTemplate: template missing functions[0].envVariables (${opts.templatePath})`,
    );
  }

  // 读 9 Keychain secrets (同步, keychainGet 是同步函数)
  const secrets: Record<string, string> = {};
  for (const key of SECRETS) {
    secrets[key] = keychainGet(key);
  }

  // merge: template env vars 优先, secrets 覆盖 (这样如果 template 也有同名 key, secret 最新)
  // 实际生产中 template 不会有 secret 名 (如 ADMIN_TOKEN), 所以 merge 等价于 union
  const mergedEnv = { ...template.functions[0].envVariables, ...secrets };

  // 写 target (顶层字段完全复制 template, 仅 envVariables merge)
  const target = {
    ...template,
    functions: [
      {
        ...template.functions[0],
        envVariables: mergedEnv,
      },
    ],
  };

  // ensure target dir exists
  mkdirSync(dirname(opts.targetPath), { recursive: true });
  writeFileSync(opts.targetPath, JSON.stringify(target, null, 2) + "\n", { mode: 0o600 });
  // mode 0o600: minipgm path cloudbaserc.json 含明文 secrets, 防其他用户读
}