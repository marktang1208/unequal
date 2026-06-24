/**
 * nli-downloader.test.ts — TDD (P6 Phase 4)
 *
 * 覆盖 7 cases:
 *   - downloadFromCos (5): idempotent skip / 真下载写本地 / customDownload 注入 / 缺 customDownload + skipSdk → throw / SDK getTempFileURL error → throw
 *   - getRemoteUrl (2): customDownload 模式返 cloudPath / SDK 正常返 tempFileURL
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNliDownloader, type CloudbaseStorageApp } from "./nli-downloader.js";

let tmpDir: string;

describe("createNliDownloader", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nli-dl-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ===== downloadFromCos =====

  it("downloadFromCos: 本地文件已存在 → 跳过 (idempotent)", async () => {
    const localPath = join(tmpDir, "model.onnx");
    writeFileSync(localPath, "existing-content");
    const customDownload = vi.fn();

    const downloader = createNliDownloader(
      {
        localPath,
        cosKey: "nli-model/test.onnx",
        customDownload,
      },
    );

    await downloader.downloadFromCos();
    expect(customDownload).not.toHaveBeenCalled();
    // 文件没被覆盖
    expect(readFileSync(localPath, "utf-8")).toBe("existing-content");
  });

  it("downloadFromCos: 本地缺 → 调 customDownload → 写文件", async () => {
    const localPath = join(tmpDir, "model.onnx");
    const fakeContent = Buffer.from("fake-model-bytes-12345");
    const customDownload = vi.fn(async () => fakeContent);

    const downloader = createNliDownloader(
      {
        localPath,
        cosKey: "nli-model/test.onnx",
        customDownload,
      },
    );

    await downloader.downloadFromCos();

    expect(customDownload).toHaveBeenCalledWith("nli-model/test.onnx");
    expect(existsSync(localPath)).toBe(true);
    expect(readFileSync(localPath)).toEqual(fakeContent);
  });

  it("downloadFromCos: 缺 customDownload + skipSdk=true → throw", async () => {
    const localPath = join(tmpDir, "model.onnx");
    const downloader = createNliDownloader({
      localPath,
      cosKey: "nli-model/test.onnx",
      skipSdk: true,
    });

    await expect(downloader.downloadFromCos()).rejects.toThrow(/no customDownload/);
  });

  it("downloadFromCos: SDK getTempFileURL 返 error → throw", async () => {
    const localPath = join(tmpDir, "model.onnx");
    const mockApp: CloudbaseStorageApp = {
      getTempFileURL: vi.fn(async () => [
        {
          fileID: "cloud://test/nli-model/test.onnx",
          tempFileURL: "",
          error: { code: "INVALID", message: "file not found in COS" },
        },
      ]),
    };

    const downloader = createNliDownloader(
      {
        localPath,
        cosKey: "nli-model/test.onnx",
        envId: "test",
        skipSdk: true,
      },
      mockApp,
    );

    await expect(downloader.downloadFromCos()).rejects.toThrow(/file not found in COS/);
  });

  it("downloadFromCos: SDK getTempFileURL success + HTTP GET → 写本地", async () => {
    const localPath = join(tmpDir, "model.onnx");
    const fakeModelContent = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const mockApp: CloudbaseStorageApp = {
      getTempFileURL: vi.fn(async () => [
        {
          fileID: "cloud://test/nli-model/test.onnx",
          tempFileURL: "https://fake-cdn.example.com/model.onnx?token=abc",
        },
      ]),
    };

    // mock global fetch
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => fakeModelContent.buffer,
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const downloader = createNliDownloader(
        {
          localPath,
          cosKey: "nli-model/test.onnx",
          envId: "test",
          skipSdk: true,
        },
        mockApp,
      );

      await downloader.downloadFromCos();

      expect(fetchMock).toHaveBeenCalledWith("https://fake-cdn.example.com/model.onnx?token=abc");
      expect(existsSync(localPath)).toBe(true);
      const written = readFileSync(localPath);
      expect(written.length).toBe(8);
      expect(written[0]).toBe(1);
      expect(written[7]).toBe(8);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // ===== getRemoteUrl =====

  it("getRemoteUrl: customDownload 模式 → 返 cloudPath (不调 SDK)", async () => {
    const downloader = createNliDownloader({
      localPath: join(tmpDir, "model.onnx"),
      cosKey: "nli-model/test.onnx",
      envId: "prod-env",
      customDownload: vi.fn(),
    });

    const url = await downloader.getRemoteUrl();
    expect(url).toBe("cloud://prod-env/nli-model/test.onnx");
  });

  it("getRemoteUrl: SDK 模式 → 返 tempFileURL", async () => {
    const mockApp: CloudbaseStorageApp = {
      getTempFileURL: vi.fn(async () => [
        {
          fileID: "cloud://test/nli-model/test.onnx",
          tempFileURL: "https://fake-cdn.example.com/model.onnx?token=xyz",
        },
      ]),
    };

    const downloader = createNliDownloader(
      {
        localPath: join(tmpDir, "model.onnx"),
        cosKey: "nli-model/test.onnx",
        envId: "test",
        skipSdk: true,
      },
      mockApp,
    );

    const url = await downloader.getRemoteUrl();
    expect(url).toBe("https://fake-cdn.example.com/model.onnx?token=xyz");
  });

  // ===== P6 Phase 5 真接发现: TCB_SECRET_ID/KEY 兜底 =====

  it("Phase 5 fix: 缺 CLOUDBASE_* 时 fallback TCB_* env", async () => {
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
      const downloader = createNliDownloader({
        localPath: join(tmpDir, "model.onnx"),
        cosKey: "nli-model/test.onnx",
        envId: "test-env",
        skipSdk: false,
      });
      // 真 init SDK 会 fail (fake creds) — 但抛错前已找到 TCB_* 兜底
      await expect(downloader.downloadFromCos()).rejects.not.toThrow(/CLOUDBASE_SECRET_ID.*env not set/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});