/**
 * tmp-config.test.ts — Unit tests for lib/tmp-config.ts
 *
 * 4 cases:
 * 1. makeTmpConfig: 模板读取 + 合并 envVars + 写 /tmp
 * 2. makeTmpConfig: chmod 0600
 * 3. cleanupTmp: 删除文件
 * 4. cleanupTmp: 静默忽略删除失败
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockMkdtemp, mockWriteFile, mockChmod, mockReadFile, mockUnlink } = vi.hoisted(() => ({
  mockMkdtemp: vi.fn(),
  mockWriteFile: vi.fn(),
  mockChmod: vi.fn(),
  mockReadFile: vi.fn(),
  mockUnlink: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdtemp: mockMkdtemp,
  writeFile: mockWriteFile,
  chmod: mockChmod,
  readFile: mockReadFile,
  unlink: mockUnlink,
}));

vi.mock("node:os", () => ({
  tmpdir: () => "/var/folders/abc/T/",
}));

import { makeTmpConfig, cleanupTmp } from "./tmp-config.js";

const SAMPLE_TEMPLATE = JSON.stringify({
  version: "2.0",
  envId: "unequal-d4ggf7rwg82e0900b",
  functions: [
    {
      name: "api-router",
      type: "Event",
      envVariables: {
        ENVIRONMENT: "production",
        KEK_CURRENT_VERSION: "1",
      },
    },
  ],
});

describe("makeTmpConfig", () => {
  beforeEach(() => {
    mockMkdtemp.mockReset();
    mockWriteFile.mockReset();
    mockChmod.mockReset();
    mockReadFile.mockReset();
    mockUnlink.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("1. 读模板 + 合并 envVars + 写 /tmp/<dir>/cloudbaserc.json", async () => {
    mockMkdtemp.mockResolvedValueOnce("/var/folders/abc/T/unequal-deploy-XXX");
    mockReadFile.mockResolvedValueOnce(SAMPLE_TEMPLATE);

    const cfgPath = await makeTmpConfig({ ADMIN_TOKEN: "secret-64", KEK_SECRET_V1: "kek-64" });

    expect(cfgPath).toBe("/var/folders/abc/T/unequal-deploy-XXX/cloudbaserc.json");
    expect(mockMkdtemp).toHaveBeenCalledWith("/var/folders/abc/T/unequal-deploy-");
    expect(mockReadFile).toHaveBeenCalledWith("cloudbaserc.json", "utf-8");

    // writeFile 应收到合并后的 config（template envVars + merged）
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [path, content] = mockWriteFile.mock.calls[0] as [string, string];
    expect(path).toBe(cfgPath);
    const written = JSON.parse(content);
    expect(written.functions[0].envVariables).toEqual({
      ENVIRONMENT: "production",
      KEK_CURRENT_VERSION: "1",
      ADMIN_TOKEN: "secret-64",
      KEK_SECRET_V1: "kek-64",
    });
  });

  it("2. 调 chmod 0600", async () => {
    mockMkdtemp.mockResolvedValueOnce("/var/folders/abc/T/unequal-deploy-YYY");
    mockReadFile.mockResolvedValueOnce(SAMPLE_TEMPLATE);

    await makeTmpConfig({});

    expect(mockChmod).toHaveBeenCalledWith(
      "/var/folders/abc/T/unequal-deploy-YYY/cloudbaserc.json",
      0o600,
    );
  });
});

describe("cleanupTmp", () => {
  beforeEach(() => {
    mockUnlink.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("3. 删除文件 + 尝试删除父目录", async () => {
    mockUnlink.mockResolvedValueOnce(undefined);
    mockUnlink.mockResolvedValueOnce(undefined);

    await cleanupTmp("/var/folders/abc/T/unequal-deploy-XXX/cloudbaserc.json");

    expect(mockUnlink).toHaveBeenCalledTimes(2);
    expect(mockUnlink).toHaveBeenNthCalledWith(1, "/var/folders/abc/T/unequal-deploy-XXX/cloudbaserc.json");
    expect(mockUnlink).toHaveBeenNthCalledWith(2, "/var/folders/abc/T/unequal-deploy-XXX");
  });

  it("4. 静默忽略 unlink 失败（不抛）", async () => {
    mockUnlink.mockRejectedValueOnce(new Error("ENOENT: no such file"));

    await expect(cleanupTmp("/var/folders/abc/T/unequal-deploy-XXX/cloudbaserc.json")).resolves.toBeUndefined();
  });
});