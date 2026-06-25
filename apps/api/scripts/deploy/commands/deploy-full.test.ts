/**
 * deploy-full.test.ts — TDD for deploy-full command
 *
 * 覆盖 5 cases:
 *   1. 默认 (--no-build=false --skip-push=false) → 顺序: build → tcb fn deploy → push
 *   2. --no-build → 跳过 build + tcb fn deploy, 只跑 push
 *   3. --skip-push → 跑 build + tcb fn deploy, 跳过 push
 *   4. build 失败 → 抛错不继续 (tcb fn deploy / push 都不跑)
 *   5. tcb fn deploy 失败 → 抛错不继续 (push 不跑)
 *   6. push 失败 → 抛错 (tcb fn deploy 已完成, secrets 已 wipe, 提示重跑 push)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRunBuild, mockRunTcbDeploy, mockRunPush } = vi.hoisted(() => ({
  mockRunBuild: vi.fn(),
  mockRunTcbDeploy: vi.fn(),
  mockRunPush: vi.fn(),
}));

vi.mock("./deploy-steps.js", () => ({
  runBuild: mockRunBuild,
  runTcbDeploy: mockRunTcbDeploy,
  runPush: mockRunPush,
}));

import { deployFull } from "./deploy-full.js";

describe("deployFull (P7: deploy pipeline 自动顺序)", () => {
  beforeEach(() => {
    mockRunBuild.mockReset();
    mockRunTcbDeploy.mockReset();
    mockRunPush.mockReset();
    mockRunBuild.mockResolvedValue(undefined);
    mockRunTcbDeploy.mockResolvedValue(undefined);
    mockRunPush.mockResolvedValue(undefined);
  });

  it("默认 → build → tcb fn deploy → push 三步顺序跑", async () => {
    const callOrder: string[] = [];
    mockRunBuild.mockImplementation(async () => { callOrder.push("build"); });
    mockRunTcbDeploy.mockImplementation(async () => { callOrder.push("tcb"); });
    mockRunPush.mockImplementation(async () => { callOrder.push("push"); });

    await deployFull({});

    expect(callOrder).toEqual(["build", "tcb", "push"]);
    expect(mockRunBuild).toHaveBeenCalledTimes(1);
    expect(mockRunTcbDeploy).toHaveBeenCalledTimes(1);
    expect(mockRunPush).toHaveBeenCalledTimes(1);
  });

  it("--no-build → 跳过 build + tcb fn deploy, 只跑 push", async () => {
    const callOrder: string[] = [];
    mockRunPush.mockImplementation(async () => { callOrder.push("push"); });

    await deployFull({ noBuild: true });

    expect(callOrder).toEqual(["push"]);
    expect(mockRunBuild).not.toHaveBeenCalled();
    expect(mockRunTcbDeploy).not.toHaveBeenCalled();
    expect(mockRunPush).toHaveBeenCalledTimes(1);
  });

  it("--skip-push → 跑 build + tcb fn deploy, 跳过 push (首次部署可能没 secret)", async () => {
    const callOrder: string[] = [];
    mockRunBuild.mockImplementation(async () => { callOrder.push("build"); });
    mockRunTcbDeploy.mockImplementation(async () => { callOrder.push("tcb"); });

    await deployFull({ skipPush: true });

    expect(callOrder).toEqual(["build", "tcb"]);
    expect(mockRunBuild).toHaveBeenCalledTimes(1);
    expect(mockRunTcbDeploy).toHaveBeenCalledTimes(1);
    expect(mockRunPush).not.toHaveBeenCalled();
  });

  it("build 失败 → 抛错, 不跑 tcb fn deploy / push", async () => {
    mockRunBuild.mockRejectedValue(new Error("esbuild failed: missing module"));
    mockRunTcbDeploy.mockResolvedValue(undefined);
    mockRunPush.mockResolvedValue(undefined);

    await expect(deployFull({})).rejects.toThrow(/esbuild failed/);
    expect(mockRunTcbDeploy).not.toHaveBeenCalled();
    expect(mockRunPush).not.toHaveBeenCalled();
  });

  it("tcb fn deploy 失败 → 抛错, 不跑 push (build 已完成, secrets 未 wipe, 可重试)", async () => {
    mockRunBuild.mockResolvedValue(undefined);
    mockRunTcbDeploy.mockRejectedValue(new Error("tcb fn deploy failed: network timeout"));
    mockRunPush.mockResolvedValue(undefined);

    await expect(deployFull({})).rejects.toThrow(/tcb fn deploy failed/);
    expect(mockRunPush).not.toHaveBeenCalled();
  });

  it("push 失败 → 抛错 (tcb 已完成, secrets 已 wipe, 提示重跑 deploy-full --no-build --skip-push=false)", async () => {
    mockRunBuild.mockResolvedValue(undefined);
    mockRunTcbDeploy.mockResolvedValue(undefined);
    mockRunPush.mockRejectedValue(new Error("SCF API UpdateFunctionConfiguration failed"));

    await expect(deployFull({})).rejects.toThrow(/SCF API/);
    // 关键: 错误信息应提示重跑 push 恢复 secrets
    await expect(deployFull({})).rejects.toThrow(/secrets.*wiped|重跑|push/i);
  });

  // P8 真接 follow-up #5: 两个 SECRETS 数组 (push.ts + sync-cloudbasrc.ts) 漂移
  // 之前 bug: 2026-06-25 deploy:full 只推 9 secrets, PG_CONNECTION_STRING 漏
  // 修法: 直接对比两个 SECRETS, 不一致 → 抛错
  it("P8 regression: PUSH_SECRETS 跟 sync-cloudbasrc SECRETS 一致 (防漂移)", async () => {
    const { PUSH_SECRETS } = await import("./push.js");
    const { SECRETS: SYNC_SECRETS } = await import("../lib/sync-cloudbasrc.js");
    expect([...PUSH_SECRETS].sort()).toEqual([...SYNC_SECRETS].sort());
  });
});
