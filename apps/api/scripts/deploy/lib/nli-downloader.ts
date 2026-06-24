/**
 * lib/nli-downloader.ts — P6 Phase 4: 从 CloudBase COS 下载 NLI 模型到 /tmp
 *
 * 用途：CloudBase 函数 cold start 时，OnnxNliProvider 检测到 /tmp/nli-model.onnx
 *      不存在 → 调 downloadFromCos() 拉到 /tmp。避免 50MB 本地 upload 限制。
 *
 * 设计：
 *   - export interface NliDownloader { downloadFromCos(): Promise<void> }
 *   - export async function createNliDownloader(opts): Promise<NliDownloader>
 *   - 真云端实现: 用 @cloudbase/node-sdk 拿 default storage bucket, getTempFileURL + http GET
 *   - 测试 mock: 直接注入 downloaderFn
 *
 * 为什么不在 OnnxNliProvider 内部直接 import cloudbase SDK?
 *   - 隔离: onnx-provider.ts 不需要依赖 SDK
 *   - 测试: 单测用 mock downloader, 不需真起 SDK
 *   - 部署位置: 在 push.ts (或独立 nli-pull command) 创建 downloader 注入 OnnxNliProvider
 *
 * v1 spec §2.4: download path = cloud://${envId}/${NLI_MODEL_COS_KEY}, 写到 ${NLI_MODEL_LOCAL_PATH}
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

// CJS bundle 兼容: __filename 在 bundle 后是真实文件路径, import.meta.url 在 CJS 是空
const moduleFilename = typeof __filename !== "undefined" ? __filename : "";

export interface NliDownloaderOptions {
  /** CloudBase env ID (默认 unequal-d4ggf7rwg82e0900b) */
  envId?: string;
  /** COS key (默认 nli-model/nli-MiniLM2-L6-H768-quint8_avx2.onnx) */
  cosKey?: string;
  /** 本地写入路径 (默认 /tmp/nli-model.onnx) */
  localPath?: string;
  /** 测试用: 注入自定义下载函数 */
  customDownload?: (cosKey: string) => Promise<Buffer>;
  /** 测试用: 跳过 SDK init */
  skipSdk?: boolean;
}

export interface NliDownloader {
  /** COS → 本地文件。idempotent (本地已有则跳过) */
  downloadFromCos: () => Promise<void>;
  /** 真云端 URL (debug 用, 不写文件) */
  getRemoteUrl: () => Promise<string>;
}

/** CloudBase SDK app interface (test mock 用) */
export interface CloudbaseStorageApp {
  /** 拿临时下载 URL (5min 有效) */
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
 * 创建 NliDownloader 实例
 * - 真云端: 通过 CloudBase SDK 拿 temp URL → http GET → writeFile
 * - 测试: 注入 customDownload 跳过 SDK
 */
export function createNliDownloader(
  opts: NliDownloaderOptions = {},
  app?: CloudbaseStorageApp,
): NliDownloader {
  const envId = opts.envId ?? DEFAULT_ENV_ID;
  const cosKey = opts.cosKey ?? DEFAULT_COS_KEY;
  const localPath = opts.localPath ?? DEFAULT_LOCAL_PATH;
  const cloudPath = `cloud://${envId}/${cosKey}`;

  /** 拿 temp URL + GET 内容 */
  const fetchFromCos = async (): Promise<Buffer> => {
    if (opts.customDownload) {
      return await opts.customDownload(cosKey);
    }
    // 拿 SDK app instance (注入 or 真 init)
    // skipSdk=true 意味着"不真 init SDK, 必须注入 app 或 customDownload"
    const sdkApp = app ?? (opts.skipSdk ? undefined : await initCloudbaseSdk(envId));
    if (!sdkApp) {
      throw new Error("NliDownloader: no customDownload provided and no app injected (skipSdk=true)");
    }
    if (!sdkApp.getTempFileURL) {
      throw new Error("NliDownloader: CloudBase SDK missing getTempFileURL method");
    }

    const fileID = cloudPath;
    const result = await sdkApp.getTempFileURL({ fileList: [fileID] });
    const entry = result[0];
    if (!entry || entry.error || !entry.tempFileURL) {
      throw new Error(
        `NliDownloader: getTempFileURL failed for ${fileID}: ${entry?.error?.message ?? "no tempFileURL"}`,
      );
    }

    // http GET temp URL
    const resp = await fetch(entry.tempFileURL);
    if (!resp.ok) {
      throw new Error(
        `NliDownloader: HTTP GET tempFileURL failed: ${resp.status} ${resp.statusText}`,
      );
    }
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  };

  return {
    async downloadFromCos(): Promise<void> {
      // idempotent: 本地已有就跳过
      if (existsSync(localPath)) {
        return;
      }
      const content = await fetchFromCos();
      // 确保父目录存在
      mkdirSync(dirname(localPath), { recursive: true });
      await writeFile(localPath, content);
    },
    async getRemoteUrl(): Promise<string> {
      if (opts.customDownload) {
        return cloudPath; // mock 模式返 cloudPath 即可
      }
      const sdkApp = app ?? (opts.skipSdk ? undefined : await initCloudbaseSdk(envId));
      if (!sdkApp) {
        return cloudPath;
      }
      if (!sdkApp.getTempFileURL) {
        return cloudPath;
      }
      const result = await sdkApp.getTempFileURL({ fileList: [cloudPath] });
      const entry = result[0];
      if (!entry || entry.error || !entry.tempFileURL) {
        throw new Error(`NliDownloader: getTempFileURL failed: ${entry?.error?.message ?? "unknown"}`);
      }
      return entry.tempFileURL;
    },
  };
}

/** 真 init CloudBase SDK (走 CJS require, 与 upload-nli-model-to-cos.ts 一致)
 *  P6 Phase 5 真接发现: 优先 CLOUDBASE_* env, 兜底 TCB_SECRET_ID/KEY (Keychain 已有)
 */
async function initCloudbaseSdk(envId: string): Promise<CloudbaseStorageApp> {
  const require = createRequire(moduleFilename || import.meta.url || "file:///");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cloudbase = require("@cloudbase/node-sdk");
  const secretId = process.env.CLOUDBASE_SECRET_ID ?? process.env.TCB_SECRET_ID;
  const secretKey = process.env.CLOUDBASE_SECRET_KEY ?? process.env.TCB_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error(
      "NliDownloader: CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY (or TCB_SECRET_ID/KEY) env not set",
    );
  }
  return cloudbase.init({ env: envId, secretId, secretKey }) as CloudbaseStorageApp;
}