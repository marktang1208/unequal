/**
 * P3-7 种子 URL 库: json-io 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJsonAtomic, writeJsonAtomic, withFileLock, fileExistsAndNonEmpty } from "../src/json-io.js";

describe("readJsonAtomic (P3-7)", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "json-io-test-"));
    filePath = join(tmpDir, "test.json");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("正常读: 写入后读取一致", () => {
    const data = { name: "test", count: 42, items: ["a", "b"] };
    writeJsonAtomic(filePath, data);
    const result = readJsonAtomic<typeof data>(filePath);
    expect(result).toEqual(data);
  });

  it("文件不存在 → 返 null", () => {
    const result = readJsonAtomic(filePath);
    expect(result).toBeNull();
  });

  it("空文件 → 返 null", () => {
    writeFileSync(filePath, "", "utf-8");
    const result = readJsonAtomic(filePath);
    expect(result).toBeNull();
  });

  it("JSON 解析错 → throw (含文件名)", () => {
    writeFileSync(filePath, "{ invalid json", "utf-8");
    expect(() => readJsonAtomic(filePath)).toThrow(/readJsonAtomic.*test\.json/);
  });
});

describe("writeJsonAtomic (P3-7)", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "json-io-test-"));
    filePath = join(tmpDir, "subdir", "test.json");  // 不存在的子目录
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("原子写: 自动 mkdir parent dir + 写后 rename", () => {
    const data = { url: "https://example.com", count: 1 };
    writeJsonAtomic(filePath, data);
    const result = readJsonAtomic<typeof data>(filePath);
    expect(result).toEqual(data);
  });

  it("原子写: 覆盖原内容", () => {
    writeJsonAtomic(filePath, { v: 1 });
    writeJsonAtomic(filePath, { v: 2 });
    const result = readJsonAtomic<{ v: number }>(filePath);
    expect(result?.v).toBe(2);
  });

  it("JSON.stringify 失败 → throw (circular ref)", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular["self"] = circular;  // 循环引用
    expect(() => writeJsonAtomic(filePath, circular)).toThrow(/JSON\.stringify/);
  });
});

describe("withFileLock (P3-7)", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "json-io-test-"));
    filePath = join(tmpDir, "test.json");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("单调用: fn 完成后锁释放", async () => {
    let ran = false;
    await withFileLock(filePath, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    // 锁目录已清除（withFileLock finally rmdir）
    const lockDir = `${filePath}.lock`;
    const fs = await import("node:fs");
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("串行调用: 不阻塞", async () => {
    const results: number[] = [];
    await withFileLock(filePath, async () => { results.push(1); });
    await withFileLock(filePath, async () => { results.push(2); });
    await withFileLock(filePath, async () => { results.push(3); });
    expect(results).toEqual([1, 2, 3]);
  });

  it("fn 抛错 → 锁仍释放", async () => {
    let threw = false;
    try {
      await withFileLock(filePath, async () => {
        threw = true;
        throw new Error("fn error");
      });
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("fn error");
    }
    expect(threw).toBe(true);
    // 锁释放
    const lockDir = `${filePath}.lock`;
    const fs = await import("node:fs");
    expect(fs.existsSync(lockDir)).toBe(false);
  });
});

describe("fileExistsAndNonEmpty (P3-7)", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "json-io-test-"));
    filePath = join(tmpDir, "test.json");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("不存在 → false", () => {
    expect(fileExistsAndNonEmpty(filePath)).toBe(false);
  });

  it("存在且非空 → true", () => {
    writeJsonAtomic(filePath, { x: 1 });
    expect(fileExistsAndNonEmpty(filePath)).toBe(true);
  });

  it("存在但空 → false", () => {
    writeFileSync(filePath, "", "utf-8");
    expect(fileExistsAndNonEmpty(filePath)).toBe(false);
  });
});