/**
 * tcb.test.ts — Unit tests for lib/tcb.ts
 *
 * 3 cases:
 * 1. Merge mode: expect "Merge update" 提示
 * 2. Override mode: expect "Override update" 提示
 * 3. expect 缺失 → throw
 *
 * tcb.ts 用 spawn() 跑 expect，spawn 是 EventEmitter 风格。
 * 用 vitest 提供的 vi.fn() 模拟 spawn 返回 ChildProcess。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const { mockSpawn, mockExistsSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

import { runTcbConfigUpdate } from "./tcb.js";

/** 模拟 spawn 返回的 ChildProcess */
function createMockChild(exitCode: number, stdoutData: string, stderrData: string = ""): EventEmitter & {
  stdout: Readable;
  stderr: Readable;
} {
  const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable };
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  // 异步触发 data + close
  setImmediate(() => {
    if (stdoutData) child.stdout.push(stdoutData);
    child.stdout.push(null);
    if (stderrData) child.stderr.push(stderrData);
    child.stderr.push(null);
    child.emit("close", exitCode);
  });
  return child;
}

describe("runTcbConfigUpdate", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockExistsSync.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("1. Merge mode 期待 'Merge update' 提示", async () => {
    mockExistsSync.mockReturnValue(true);
    mockSpawn.mockReturnValueOnce(
      createMockChild(0, "Configuration for function [api-router] updated successfully!\nenvVariables=13项\n", ""),
    );

    const result = await runTcbConfigUpdate(
      "/tmp/unequal-deploy-XXX/cloudbaserc.json",
      "merge",
      "unequal-d4ggf7rwg82e0900b",
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("updated successfully");
    // expect 脚本应含 "Merge update" 提示
    const callArgs = mockSpawn.mock.calls[0] as [string, string[]];
    expect(callArgs[0]).toBe("expect");
    // expectScript 在 callArgs[1][1] (index 1 是 -c <script>)
    const script = callArgs[1][1];
    expect(script).toContain('expect "Merge update"');
  });

  it("2. Override mode 期待 'Override update' 提示", async () => {
    mockExistsSync.mockReturnValue(true);
    mockSpawn.mockReturnValueOnce(
      createMockChild(0, "Configuration for function [api-router] updated successfully!\n", ""),
    );

    const result = await runTcbConfigUpdate(
      "/tmp/unequal-deploy-XXX/cloudbaserc.json",
      "override",
      "unequal-d4ggf7rwg82e0900b",
    );

    expect(result.code).toBe(0);
    const callArgs = mockSpawn.mock.calls[0] as [string, string[]];
    const script = callArgs[1][1];
    expect(script).toContain('expect "Override update"');
  });

  it("3. expect 缺失 → throw 'expect not found'", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(
      runTcbConfigUpdate(
        "/tmp/unequal-deploy-XXX/cloudbaserc.json",
        "merge",
        "unequal-d4ggf7rwg82e0900b",
      ),
    ).rejects.toThrow(/expect.*not found/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});