/**
 * upload-nli-model-to-cos.ts — 把本地 NLI 模型上传到 CloudBase COS
 *
 * 用法:
 *   pnpm -F api upload-nli-model
 *
 * 流程:
 *   1. 验证 ./scripts/nli-assets/ 目录有 5 文件 (model + tokenizer + config)
 *   2. 调 @cloudbase/node-sdk uploadFile API 上传到 cloudbase default bucket
 *   3. 输出 cloud path 给 push.ts 引用
 *
 * 前提:
 *   - .env (apps/api) 配 CLOUDBASE_SECRET_ID / SECRET_KEY / ENV_ID
 *   - ./scripts/nli-assets/ 已下载 (跑 download-nli-model-local)
 *
 * v1 spec §2.4 + v1 §修订 0: COS 上传避免 50MB 本地限制, 函数 init 阶段从 COS 下载到 /tmp
 */

import { readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ASSETS_DIR = join(__dirname, "..", "scripts", "nli-assets");

/** CloudBase COS 路径前缀 (同一 envId 内, 用 nli-model/ 子目录隔离) */
const COS_PATH_PREFIX = "nli-model/";

/** 必须上传的 5 文件 (与 download script ENTRIES 对齐) */
const REQUIRED_FILES = [
  "nli-MiniLM2-L6-H768-quint8_avx2.onnx",
  "merges.txt",
  "vocab.json",
  "special_tokens_map.json",
  "config.json",
] as const;

export interface UploadResult {
  fileName: string;
  cloudPath: string;
  fileID: string;
  sizeBytes: number;
}

export interface CloudbaseUploader {
  uploadFile: (opts: {
    cloudPath: string;
    fileContent: Buffer;
  }) => Promise<{ fileID: string }>;
}

export interface UploadOptions {
  /** CloudBase SDK instance (测试可注入 mock) */
  app: CloudbaseUploader;
  /** COS 路径前缀 (默认 'nli-model/') */
  cosPathPrefix?: string;
  /** 本地资源目录 (默认 ASSETS_DIR) */
  assetsDir?: string;
  /** 限制上传的 file 白名单 (默认 REQUIRED_FILES) */
  requiredFiles?: ReadonlyArray<string>;
}

export async function uploadNliModel(opts: UploadOptions): Promise<UploadResult[]> {
  const assetsDir = opts.assetsDir ?? ASSETS_DIR;
  const cosPrefix = opts.cosPathPrefix ?? COS_PATH_PREFIX;
  const requiredFiles = opts.requiredFiles ?? REQUIRED_FILES;

  // 1. 验证必需文件存在
  const existing = new Set(await readdir(assetsDir));
  const missing = requiredFiles.filter((f) => !existing.has(f));
  if (missing.length > 0) {
    throw new Error(
      `Missing required NLI asset files in ${assetsDir}: ${missing.join(", ")}\n` +
        `Run: pnpm -F api download-nli-model`,
    );
  }

  // 2. 上传每个文件
  const results: UploadResult[] = [];
  for (const fileName of requiredFiles) {
    const filePath = join(assetsDir, fileName);
    const fileStat = await stat(filePath);
    const { readFile } = await import("node:fs/promises");
    const fileContent = await readFile(filePath);
    const cloudPath = `${cosPrefix}${fileName}`;

    const t0 = Date.now();
    const { fileID } = await opts.app.uploadFile({ cloudPath, fileContent });
    const elapsed = Date.now() - t0;

    results.push({
      fileName,
      cloudPath,
      fileID,
      sizeBytes: fileStat.size,
    });
    console.log(
      `✓ ${fileName} → ${cloudPath} (${(fileStat.size / 1024 / 1024).toFixed(1)}MB, ${elapsed}ms)`,
    );
  }

  return results;
}

async function main(): Promise<void> {
  // 加载 .env (pnpm dev 风格, simple parser)
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ path: join(__dirname, "..", ".env") });
  } catch {
    // dotenv optional
  }

  const secretId = process.env.CLOUDBASE_SECRET_ID;
  const secretKey = process.env.CLOUDBASE_SECRET_KEY;
  const envId = process.env.ENV_ID;
  if (!secretId || !secretKey || !envId) {
    console.error(
      "❌ Missing env: CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY / ENV_ID",
    );
    console.error("   Set in apps/api/.env or export before running");
    process.exit(1);
  }

  // 用 CJS require 加载 @cloudbase/node-sdk (它的 main 是 CJS)
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cloudbase = require("@cloudbase/node-sdk");
  const app = cloudbase.init({ env: envId, secretId, secretKey });

  console.log(`[upload-nli-model] env: ${envId}`);
  console.log(`[upload-nli-model] source: ${ASSETS_DIR}`);
  console.log(`[upload-nli-model] target: cloud://${envId}/${COS_PATH_PREFIX}*`);

  const results = await uploadNliModel({ app });
  const totalSize = results.reduce((sum, r) => sum + r.sizeBytes, 0);
  console.log(`\n✅ Done — ${results.length} files, ${(totalSize / 1024 / 1024).toFixed(1)}MB total`);
  console.log(`\nNext: pnpm -F api deploy:push  # deploy with NLI_PROVIDER=onnx + NLI env vars`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}