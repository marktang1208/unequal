/**
 * download-nli-model-local 单测 (TDD RED)
 *
 * 覆盖:
 *   1. 幂等: 文件已存在 + SHA-256 匹配 → 跳过 (status: "skipped")
 *   2. 完整性: 文件已存在 + SHA-256 不匹配 → throw
 *   3. 下载: 文件不存在 → download + 返回新 size/sha256
 *   4. 错误: HTTP 非 200 → throw
 *   5. ENTRIES 数量正确 (5 files)
 *   6. HF_MIRROR env override 可生效
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { processEntry, ENTRIES } from "../download-nli-model-local.js";

describe("download-nli-model-local", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "nli-model-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("should have 5 ENTRIES", () => {
    expect(ENTRIES).toHaveLength(5);
    const names = ENTRIES.map((e) => e.localName);
    expect(names).toContain("nli-MiniLM2-L6-H768-quint8_avx2.onnx");
    expect(names).toContain("merges.txt");
    expect(names).toContain("vocab.json");
    expect(names).toContain("special_tokens_map.json");
    expect(names).toContain("config.json");
  });

  it("should skip download if file exists and SHA-256 matches", async () => {
    // Arrange: 写一个 fake 文件 + 设 expected hash
    const entry = {
      remotePath: "vocab.json",
      localName: "vocab.json",
      expectedSha256: null,
    };
    const fakeContent = '{"test": "data"}';
    await writeFile(join(workDir, entry.localName), fakeContent);
    const expectedHash = createHash("sha256").update(fakeContent).digest("hex");
    entry.expectedSha256 = expectedHash;

    // Act
    const result = await processEntry(entry, workDir, "http://fake-mirror");

    // Assert
    expect(result.status).toBe("skipped");
    expect(result.sizeBytes).toBe(fakeContent.length);
    expect(result.sha256).toBe(expectedHash);
  });

  it("should throw if file exists but SHA-256 mismatches", async () => {
    // Arrange: 写一个 fake 文件 + 设错的 expected hash
    const entry = {
      remotePath: "vocab.json",
      localName: "vocab.json",
      expectedSha256: "deadbeef".repeat(8), // 错误的 hash
    };
    await writeFile(join(workDir, entry.localName), '{"test": "data"}');

    // Act + Assert
    await expect(processEntry(entry, workDir, "http://fake-mirror")).rejects.toThrow(
      /SHA-256 mismatch for vocab\.json/,
    );
  });

  it("should download file if not exists", async () => {
    // Arrange: 用一个 httpbin-like echo server 替身 — 通过 mock global.fetch
    const fakeContent = '{"downloaded": true, "size": 23}';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(fakeContent, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const entry = {
        remotePath: "vocab.json",
        localName: "vocab.json",
        expectedSha256: null,
      };

      // Act
      const result = await processEntry(entry, workDir, "http://fake-mirror");

      // Assert
      expect(result.status).toBe("downloaded");
      expect(result.sizeBytes).toBe(fakeContent.length);
      expect(result.sha256).toBe(createHash("sha256").update(fakeContent).digest("hex"));

      // 验证文件确实写到磁盘
      const written = await readFile(join(workDir, entry.localName), "utf-8");
      expect(written).toBe(fakeContent);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should throw on HTTP 404", async () => {
    // Arrange: mock fetch 返回 404
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as typeof fetch;

    try {
      const entry = {
        remotePath: "does-not-exist.onnx",
        localName: "missing.onnx",
        expectedSha256: null,
      };

      // Act + Assert
      await expect(processEntry(entry, workDir, "http://fake-mirror")).rejects.toThrow(
        /HTTP 404 Not Found/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should call HF_MIRROR with full URL when downloading", async () => {
    // Arrange: 记录 fetch 调用
    let capturedUrl: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const entry = {
        remotePath: "vocab.json",
        localName: "vocab.json",
        expectedSha256: null,
      };

      // Act
      await processEntry(entry, workDir, "https://my-custom-mirror.example");

      // Assert
      expect(capturedUrl).toBe("https://my-custom-mirror.example/cross-encoder/nli-MiniLM2-L6-H768/resolve/main/vocab.json");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should create target subdir if missing (mkdir recursive)", async () => {
    // Arrange: targetDir 还不存在
    const nestedDir = join(workDir, "nested", "subdir");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("hi", { status: 200 })) as typeof fetch;

    try {
      const entry = {
        remotePath: "vocab.json",
        localName: "vocab.json",
        expectedSha256: null,
      };

      // Act
      await processEntry(entry, nestedDir, "http://fake-mirror");

      // Assert: 文件在嵌套目录创建成功
      const written = await readFile(join(nestedDir, entry.localName), "utf-8");
      expect(written).toBe("hi");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});