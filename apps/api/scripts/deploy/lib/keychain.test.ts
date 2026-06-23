/**
 * keychain.test.ts — Unit tests for lib/keychain.ts
 *
 * Mock spawnSync 覆盖 6 cases:
 * 1. read OK: status=0 + stdout 有值
 * 2. read fail: status≠0 + stderr 有错误
 * 3. read empty stdout: status=0 + stdout 空 → throw
 * 4. write OK: status=0 + 值写入
 * 5. write fail: status≠0 → throw
 * 6. write empty value: 立即 throw（不调 spawnSync）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted 让 mock 在 vi.mock factory 中可用（避免 TDZ）
const { mockSpawnSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
}));

import { keychainGet, keychainSet, KeychainError, KEYCHAIN_PREFIX, KEYCHAIN_ACCOUNT } from "./keychain.js";

describe("keychainGet", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("1. returns trimmed value on status=0 + stdout 有值", () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "secret-value-64-chars-long\n",
      stderr: "",
    } as any);
    const result = keychainGet("ADMIN_TOKEN");
    expect(result).toBe("secret-value-64-chars-long");
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "security",
      [
        "find-generic-password",
        "-a", KEYCHAIN_ACCOUNT,
        "-s", KEYCHAIN_PREFIX + "ADMIN_TOKEN",
        "-w",
      ],
      { encoding: "utf-8" },
    );
  });

  it("2. throws KeychainError on status≠0 + stderr 有错误", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "security: SecKeychainSearchCopyNext: ... not found",
    } as any);
    expect(() => keychainGet("KEK_SECRET_V1")).toThrow(KeychainError);
    expect(() => keychainGet("KEK_SECRET_V1")).toThrow(/Keychain read failed for KEK_SECRET_V1.*not found/);
  });

  it("3. throws KeychainError on status=0 + stdout empty", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "   \n",
      stderr: "",
    } as any);
    expect(() => keychainGet("JWT_SECRET")).toThrow(KeychainError);
    expect(() => keychainGet("JWT_SECRET")).toThrow(/empty value/);
  });
});

describe("keychainSet", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("4. writes successfully on status=0", () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "",
      stderr: "",
    });
    expect(() => keychainSet("KEK_SECRET_V1", "a".repeat(64))).not.toThrow();
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "security",
      [
        "add-generic-password",
        "-a", KEYCHAIN_ACCOUNT,
        "-s", KEYCHAIN_PREFIX + "KEK_SECRET_V1",
        "-w", "a".repeat(64),
        "-U",
      ],
      { encoding: "utf-8" },
    );
  });

  it("5. throws KeychainError on status≠0", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "security: SecKeychainAddCopy failed",
    } as any);
    expect(() => keychainSet("KEK_SECRET_V1", "a".repeat(64))).toThrow(KeychainError);
    expect(() => keychainSet("KEK_SECRET_V1", "a".repeat(64))).toThrow(/Keychain write failed for KEK_SECRET_V1.*SecKeychainAddCopy failed/);
  });

  it("6. throws immediately on empty value (no spawnSync call)", () => {
    expect(() => keychainSet("KEK_SECRET_V1", "")).toThrow(/empty value/);
    expect(() => keychainSet("KEK_SECRET_V1", "")).toThrow(/empty value for KEK_SECRET_V1/);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});