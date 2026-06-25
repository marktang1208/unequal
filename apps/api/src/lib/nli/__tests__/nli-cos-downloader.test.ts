/**
 * nli-cos-downloader.test.ts — 运行时 downloader TDD (P6 Phase 4)
 *
 * 覆盖 6 cases (与 deploy/lib/nli-downloader.test.ts 平行):
 *   - downloadFromCos (4): idempotent skip / 真下载 (customDownload) / testApp SDK 模式 / SDK error
 *   - getRemoteUrl (2): customDownload 模式返 cloudPath / testApp 返 tempFileURL
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNliCosDownloader,
  type CloudbaseStorageApp,
} from "../nli-cos-downloader.js";

let tmpDir: string;

describe("createNliCosDownloader (runtime)", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nli-cos-dl-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ===== downloadFromCos =====

  it("downloadFromCos: 本地已有 → 跳过 (idempotent)", async () => {
    const localPath = join(tmpDir, "model.onnx");
    writeFileSync(localPath, "existing");
    const customDownload = vi.fn();

    const dl = createNliCosDownloader({
      localPath,
      cosKey: "nli-model/test.onnx",
      customDownload,
    });

    await dl.downloadFromCos();
    expect(customDownload).not.toHaveBeenCalled();
    expect(readFileSync(localPath, "utf-8")).toBe("existing");
  });

  it("downloadFromCos: 本地缺 + customDownload → 写文件", async () => {
    const localPath = join(tmpDir, "model.onnx");
    const fakeContent = Buffer.from("fake-model-payload");
    const customDownload = vi.fn(async () => fakeContent);

    const dl = createNliCosDownloader({
      localPath,
      cosKey: "nli-model/test.onnx",
      customDownload,
    });

    await dl.downloadFromCos();

    expect(customDownload).toHaveBeenCalledWith("nli-model/test.onnx");
    expect(existsSync(localPath)).toBe(true);
    expect(readFileSync(localPath)).toEqual(fakeContent);
  });

  it("downloadFromCos: testApp 注入 + fetch mock → SDK path 写本地", async () => {
    const localPath = join(tmpDir, "model.onnx");
    const modelBytes = new Uint8Array([10, 20, 30, 40, 50]);
    const mockApp: CloudbaseStorageApp = {
      getTempFileURL: vi.fn(async () => [
        {
          fileID: "cloud://test/nli-model/test.onnx",
          tempFileURL: "https://cdn.example.com/model.onnx?token=abc",
        },
      ]),
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => modelBytes.buffer,
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const dl = createNliCosDownloader({
        localPath,
        cosKey: "nli-model/test.onnx",
        envId: "test",
        skipSdk: true,
        testApp: mockApp,
      });

      await dl.downloadFromCos();

      expect(mockApp.getTempFileURL).toHaveBeenCalledWith({
        fileList: ["cloud://test/nli-model/test.onnx"],
      });
      expect(fetchMock).toHaveBeenCalledWith("https://cdn.example.com/model.onnx?token=abc");
      const written = readFileSync(localPath);
      expect(written.length).toBe(5);
      expect(written[0]).toBe(10);
      expect(written[4]).toBe(50);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("downloadFromCos: SDK getTempFileURL error → throw 含原因", async () => {
    const localPath = join(tmpDir, "model.onnx");
    const mockApp: CloudbaseStorageApp = {
      getTempFileURL: vi.fn(async () => [
        {
          fileID: "cloud://test/nli-model/test.onnx",
          tempFileURL: "",
          error: { code: "STORAGE_FILE_NOT_EXIST", message: "nli-model/test.onnx not found" },
        },
      ]),
    };

    const dl = createNliCosDownloader({
      localPath,
      cosKey: "nli-model/test.onnx",
      envId: "test",
      skipSdk: true,
      testApp: mockApp,
    });

    await expect(dl.downloadFromCos()).rejects.toThrow(/not found/);
  });

  // ===== getRemoteUrl =====

  it("getRemoteUrl: customDownload 模式 → 返 cloud://path", async () => {
    const dl = createNliCosDownloader({
      localPath: join(tmpDir, "model.onnx"),
      cosKey: "nli-model/test.onnx",
      envId: "prod-env",
      customDownload: vi.fn(),
    });

    const url = await dl.getRemoteUrl();
    expect(url).toBe("cloud://prod-env/nli-model/test.onnx");
  });

  it("getRemoteUrl: testApp 模式 → 返 tempFileURL", async () => {
    const mockApp: CloudbaseStorageApp = {
      getTempFileURL: vi.fn(async () => [
        {
          fileID: "cloud://test/nli-model/test.onnx",
          tempFileURL: "https://cdn.example.com/model.onnx?token=xyz",
        },
      ]),
    };

    const dl = createNliCosDownloader({
      localPath: join(tmpDir, "model.onnx"),
      cosKey: "nli-model/test.onnx",
      envId: "test",
      skipSdk: true,
      testApp: mockApp,
    });

    const url = await dl.getRemoteUrl();
    expect(url).toBe("https://cdn.example.com/model.onnx?token=xyz");
  });

  // ===== P6 Phase 5 真接发现: TCB_SECRET_ID/KEY 兜底 =====

  it("Phase 5 fix: 缺 CLOUDBASE_* 时 fallback TCB_* env", async () => {
    // 模拟 deploy 阶段: cloudbaserc 没设 CLOUDBASE_*, 只有 TCB_SECRET_ID/KEY
    const saved = {
      sid: process.env.TCB_SECRET_ID,
      key: process.env.TCB_SECRET_KEY,
      csid: process.env.CLOUDBASE_SECRET_ID,
      ckey: process.env.CLOUDBASE_SECRET_KEY,
    };
    delete process.env.CLOUDBASE_SECRET_ID;
    delete process.env.CLOUDBASE_SECRET_KEY;
    process.env.TCB_SECRET_ID = "fake-sid";
    process.env.TCB_SECRET_KEY = "fake-key";

    try {
      // 真 init SDK 会 fail (fake creds) — 但抛错前应该已经找到 TCB_* 兜底
      // 所以不应该抛 "missing CLOUDBASE_SECRET_ID" — 而应该抛 SDK init 错
      const dl = createNliCosDownloader({
        localPath: join(tmpDir, "model.onnx"),
        cosKey: "nli-model/test.onnx",
        envId: "test-env",
        skipSdk: false,
      });
      await expect(dl.downloadFromCos()).rejects.toThrow(/SDK|secret|credential|invalid/i);
      // 关键断言: 不是 "missing CLOUDBASE_SECRET_ID" 错误 (说明 TCB_* 兜底生效)
      await expect(dl.downloadFromCos()).rejects.not.toThrow(/CLOUDBASE_SECRET_ID.*env not set/);
    } finally {
      // restore env
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("Phase 5 fix: 全缺 (CLOUDBASE_* + TCB_*) → 抛明确 'missing' 错", async () => {
    const saved = {
      sid: process.env.TCB_SECRET_ID,
      key: process.env.TCB_SECRET_KEY,
      csid: process.env.CLOUDBASE_SECRET_ID,
      ckey: process.env.CLOUDBASE_SECRET_KEY,
    };
    delete process.env.CLOUDBASE_SECRET_ID;
    delete process.env.CLOUDBASE_SECRET_KEY;
    delete process.env.TCB_SECRET_ID;
    delete process.env.TCB_SECRET_KEY;

    try {
      const dl = createNliCosDownloader({
        localPath: join(tmpDir, "model.onnx"),
        cosKey: "nli-model/test.onnx",
        envId: "test-env",
        skipSdk: false,
      });
      await expect(dl.downloadFromCos()).rejects.toThrow(/missing.*env|env not set/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  // P9 真接 follow-up #10: Cold start race condition retry
  it("downloadFromCos: getTempFileURL 前 2 次 no tempFileURL → 第 3 次 success (retry 生效)", async () => {
    const localPath = join(tmpDir, "model-retry.onnx");
    let attempt = 0;
    const mockApp = {
      getTempFileURL: vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt < 3) {
          // 前 2 次: 模拟 cold start race condition
          return [{ fileID: "test", error: { code: "STORAGE_INIT", message: "no tempFileURL" } }];
        }
        // 第 3 次: SDK init 完, 返真 tempFileURL
        return [{ fileID: "test", tempFileURL: "data:text/plain;base64,dGVzdA==" }];
      }),
    };
    const dl = createNliCosDownloader({
      localPath,
      cosKey: "nli-model/test.onnx",
      envId: "test-env",
      testApp: mockApp as never,
      skipSdk: true,
    });
    await dl.downloadFromCos();
    expect(attempt).toBe(3);
    expect(existsSync(localPath)).toBe(true);
  });
});