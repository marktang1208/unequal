/**
 * lib/nli/nli-cos-downloader.ts — 运行时从 CloudBase COS 下载 NLI 模型到 /tmp
 *
 * 用途：CloudBase 函数 cold start 时, OnnxNliProvider 检测到 /tmp/nli-model.onnx
 *      不存在 → 调 downloadFromCos() 拉到 /tmp。避免 50MB 本地 upload 限制。
 *
 * 设计：
 *   - 与 deploy/lib/nli-downloader.ts 共享架构, 但本模块在 src/lib/nli/ 运行时位置
 *   - 不在 OnnxNliProvider 内部直接 import cloudbase SDK (隔离 + 测试友好)
 *   - get-provider.ts 在 onnx 路由时, 若 opts.onnxDownloadFromCos 未注入 → 自动用本模块创建
 *   - 测试: 注入 app mock 即可, 不需真起 SDK
 *
 * v1 spec §2.4: download path = cloud://${envId}/${NLI_MODEL_COS_KEY}, 写到 ${NLI_MODEL_LOCAL_PATH}
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

// P6 Phase 4.2 修: 在 CJS bundle 下, import.meta.url 是空字符串
// 用 module 自身 (CJS-friendly) 替代, createRequire(__filename) 等价于 import.meta.url
const moduleFilename = typeof __filename !== "undefined" ? __filename : "";

export interface NliCosDownloaderOptions {
  /** CloudBase env ID (默认 unequal-d4ggf7rwg82e0900b) */
  envId?: string;
  /** COS key (默认 nli-model/nli-MiniLM2-L6-H768-quint8_avx2.onnx) */
  cosKey?: string;
  /** 本地写入路径 (默认 /tmp/nli-model.onnx) */
  localPath?: string;
  /** CloudBase SDK secret (test mock 可跳过) */
  cloudbaseSecretId?: string;
  cloudbaseSecretKey?: string;
  /** 测试用: 注入 SDK app (避免真 init) */
  testApp?: CloudbaseStorageApp;
  /** 测试用: 跳过 SDK init */
  skipSdk?: boolean;
  /** 测试用: 注入 customDownload (cosKey → Buffer) */
  customDownload?: (cosKey: string) => Promise<Buffer>;
}

export interface NliCosDownloader {
  /** COS → 本地文件。idempotent (本地已有则跳过) */
  downloadFromCos: () => Promise<void>;
  /** 拿云端 temp URL (debug 用) */
  getRemoteUrl: () => Promise<string>;
}

export interface CloudbaseStorageApp {
  getTempFileURL?: (opts: { fileList: string[] }) => Promise<Array<{
    fileID: string;
    tempFileURL: string;
    error?: { code: string; message: string };
  }>>;
}

const DEFAULT_ENV_ID = "unequal-d4ggf7rwg82e0900b";
const DEFAULT_COS_KEY = "nli-model/nli-MiniLM2-L6-H768-quint8_avx2.onnx";
const DEFAULT_LOCAL_PATH = "/tmp/nli-model.onnx";

/**
 * 创建 NliCosDownloader 实例
 * - 真云端: CloudBase SDK 拿 temp URL → http GET → writeFile
 * - 测试: 注入 testApp / customDownload 跳过 SDK
 */
export function createNliCosDownloader(opts: NliCosDownloaderOptions = {}): NliCosDownloader {
  const envId = opts.envId ?? DEFAULT_ENV_ID;
  const cosKey = opts.cosKey ?? DEFAULT_COS_KEY;
  const localPath = opts.localPath ?? DEFAULT_LOCAL_PATH;
  const cloudPath = `cloud://${envId}/${cosKey}`;

  const fetchFromCos = async (): Promise<Buffer> => {
    if (opts.customDownload) {
      return await opts.customDownload(cosKey);
    }
    const sdkApp = opts.testApp ?? (opts.skipSdk ? undefined : await initCloudbaseSdk(envId, opts));
    if (!sdkApp) {
      throw new Error("NliCosDownloader: no customDownload/testApp and skipSdk=true");
    }
    if (!sdkApp.getTempFileURL) {
      throw new Error("NliCosDownloader: SDK missing getTempFileURL");
    }
    const result = await sdkApp.getTempFileURL({ fileList: [cloudPath] });
    const entry = result[0];
    if (!entry || entry.error || !entry.tempFileURL) {
      throw new Error(
        `NliCosDownloader: getTempFileURL failed for ${cloudPath}: ${entry?.error?.message ?? "no tempFileURL"}`,
      );
    }
    const resp = await fetch(entry.tempFileURL);
    if (!resp.ok) {
      throw new Error(
        `NliCosDownloader: HTTP GET tempFileURL failed: ${resp.status} ${resp.statusText}`,
      );
    }
    return Buffer.from(await resp.arrayBuffer());
  };

  return {
    async downloadFromCos(): Promise<void> {
      if (existsSync(localPath)) return; // idempotent
      const content = await fetchFromCos();
      mkdirSync(dirname(localPath), { recursive: true });
      await writeFile(localPath, content);
    },
    async getRemoteUrl(): Promise<string> {
      if (opts.customDownload) return cloudPath;
      const sdkApp = opts.testApp ?? (opts.skipSdk ? undefined : await initCloudbaseSdk(envId, opts));
      if (!sdkApp?.getTempFileURL) return cloudPath;
      const result = await sdkApp.getTempFileURL({ fileList: [cloudPath] });
      const entry = result[0];
      if (!entry || entry.error || !entry.tempFileURL) {
        throw new Error(`NliCosDownloader: getTempFileURL failed: ${entry?.error?.message ?? "unknown"}`);
      }
      return entry.tempFileURL;
    },
  };
}

async function initCloudbaseSdk(envId: string, opts: NliCosDownloaderOptions): Promise<CloudbaseStorageApp> {
  // P6 Phase 5 真接发现: cloudbaserc.json 没有 CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY
  // (deploy 阶段用 TCB_SECRET_ID / TCB_SECRET_KEY, runtime 阶段为了一致也读这两个)
  // 优先 opts 注入 → CLOUDBASE_* env → TCB_* env (Keychain 已有)
  const secretId =
    opts.cloudbaseSecretId ??
    process.env.CLOUDBASE_SECRET_ID ??
    process.env.TCB_SECRET_ID;
  const secretKey =
    opts.cloudbaseSecretKey ??
    process.env.CLOUDBASE_SECRET_KEY ??
    process.env.TCB_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error(
      "NliCosDownloader: missing CLOUDBASE_SECRET_ID/KEY (or TCB_SECRET_ID/KEY) env",
    );
  }
  // createRequire 在 CJS bundle 下需要真实 __filename
  // ESM test runner 下 __filename 不存在, 用 import.meta.url (workaround: moduleFilename)
  const require = createRequire(moduleFilename || import.meta.url || "file:///");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cloudbase = require("@cloudbase/node-sdk");
  return cloudbase.init({ env: envId, secretId, secretKey }) as CloudbaseStorageApp;
}