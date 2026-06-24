/**
 * upload-nli-model-to-cos 单测 (TDD)
 *
 * 覆盖:
 *   1. 必需文件缺失 → throw
 *   2. 必需文件齐全 → upload 每个文件 + 记录 cloud path
 *   3. upload mock 返 fileID → 正确传给 caller
 *   4. requiredFiles override 生效
 *   5. cosPathPrefix 拼接正确
 *   6. 文件大小正确 (sizeBytes)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadNliModel, type CloudbaseUploader } from "../upload-nli-model-to-cos.js";

describe("upload-nli-model-to-cos", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "nli-upload-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function writeAllAssets(): Promise<void> {
    await writeFile(join(workDir, "nli-MiniLM2-L6-H768-quint8_avx2.onnx"), "fake model");
    await writeFile(join(workDir, "merges.txt"), "Ġ t\nĠ a\n");
    await writeFile(join(workDir, "vocab.json"), '{"<s>": 0}');
    await writeFile(join(workDir, "special_tokens_map.json"), "{}");
    await writeFile(join(workDir, "config.json"), '{"id2label": {"0": "contradiction"}}');
  }

  function makeMockUploader(
    captured: Array<{ cloudPath: string; size: number }>,
  ): CloudbaseUploader {
    return {
      uploadFile: async (opts) => {
        captured.push({ cloudPath: opts.cloudPath, size: opts.fileContent.length });
        return { fileID: `cloud://mock-env/${opts.cloudPath}` };
      },
    };
  }

  it("should throw if required files missing", async () => {
    // Arrange: 空目录
    const app = makeMockUploader([]);

    // Act + Assert
    await expect(uploadNliModel({ app, assetsDir: workDir })).rejects.toThrow(
      /Missing required NLI asset files/,
    );
  });

  it("should upload all 5 required files with correct cloud paths", async () => {
    // Arrange
    await writeAllAssets();
    const captured: Array<{ cloudPath: string; size: number }> = [];
    const app = makeMockUploader(captured);

    // Act
    const results = await uploadNliModel({ app, assetsDir: workDir });

    // Assert
    expect(results).toHaveLength(5);
    const paths = results.map((r) => r.cloudPath).sort();
    expect(paths).toEqual([
      "nli-model/config.json",
      "nli-model/merges.txt",
      "nli-model/nli-MiniLM2-L6-H768-quint8_avx2.onnx",
      "nli-model/special_tokens_map.json",
      "nli-model/vocab.json",
    ]);
    expect(captured).toHaveLength(5);
  });

  it("should report correct sizeBytes per file", async () => {
    // Arrange
    await writeAllAssets();
    const captured: Array<{ cloudPath: string; size: number }> = [];
    const app = makeMockUploader(captured);

    // Act
    const results = await uploadNliModel({ app, assetsDir: workDir });

    // Assert
    const modelResult = results.find((r) => r.fileName.endsWith(".onnx"));
    expect(modelResult?.sizeBytes).toBe("fake model".length);

    const mergesResult = results.find((r) => r.fileName === "merges.txt");
    expect(mergesResult?.sizeBytes).toBe(Buffer.from("Ġ t\nĠ a\n", "utf-8").length);
  });

  it("should pass fileID from uploader back to caller", async () => {
    // Arrange
    await writeAllAssets();
    const app = makeMockUploader([]);

    // Act
    const results = await uploadNliModel({ app, assetsDir: workDir });

    // Assert
    for (const r of results) {
      expect(r.fileID).toMatch(/^cloud:\/\/mock-env\//);
    }
  });

  it("should support custom cosPathPrefix", async () => {
    // Arrange
    await writeAllAssets();
    const captured: Array<{ cloudPath: string; size: number }> = [];
    const app = makeMockUploader(captured);

    // Act
    await uploadNliModel({ app, assetsDir: workDir, cosPathPrefix: "v1/nli/" });

    // Assert
    for (const c of captured) {
      expect(c.cloudPath).toMatch(/^v1\/nli\//);
    }
  });

  it("should support custom requiredFiles whitelist", async () => {
    // Arrange: 只放 merges.txt
    await writeFile(join(workDir, "merges.txt"), "fake");
    const captured: Array<{ cloudPath: string; size: number }> = [];
    const app = makeMockUploader(captured);

    // Act
    const results = await uploadNliModel({
      app,
      assetsDir: workDir,
      requiredFiles: ["merges.txt"],
    });

    // Assert
    expect(results).toHaveLength(1);
    expect(results[0]?.fileName).toBe("merges.txt");
  });

  it("should propagate upload errors", async () => {
    // Arrange: 上传 mock 抛错
    await writeAllAssets();
    const app: CloudbaseUploader = {
      uploadFile: async () => {
        throw new Error("Network error");
      },
    };

    // Act + Assert
    await expect(uploadNliModel({ app, assetsDir: workDir })).rejects.toThrow(/Network error/);
  });
});