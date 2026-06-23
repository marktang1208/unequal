/**
 * audit.test.ts — Unit tests for deploy/lib/audit.ts
 *
 * 5 cases:
 * 1. 正常写：spawnSync status=0 → 写 deploy record
 * 2. 写失败：spawnSync status≠0 → throw AuditError
 * 3. ulid 字段填充 (id, requestId, timestamp)
 * 4. action="deploy" + actor.via="deploy_script" 标记
 * 5. deploySnapshot 包含 before/after/added/removed/changed
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockSpawnSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
}));

import { writeDeployAudit } from "./audit.js";
import type { EnvSnapshot, DriftReport } from "./diff.js";

const FAKE_BEFORE: EnvSnapshot = {
  source: "local-template",
  capturedAt: 1000,
  envVariables: { A: "1", B: "2" },
};
const FAKE_AFTER: EnvSnapshot = {
  source: "remote",
  capturedAt: 2000,
  envVariables: { A: "1", B: "2", C: "3" },
};
const FAKE_DRIFT: DriftReport = {
  added: ["C"],
  removed: [],
  changed: [],
  warnings: [],
};

describe("writeDeployAudit", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("1. 正常写：spawnSync status=0 不抛错", async () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "ok",
      stderr: "",
    } as any);
    await expect(
      writeDeployAudit({
        action: "deploy",
        mode: "merge",
        before: FAKE_BEFORE,
        after: FAKE_AFTER,
        drift: FAKE_DRIFT,
        secretsCount: 6,
        operator: "tester",
      }),
    ).resolves.toBeUndefined();
  });

  it("2. 写失败：spawnSync status≠0 → throw AuditError", async () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "permission denied",
    } as any);
    await expect(
      writeDeployAudit({
        action: "deploy",
        mode: "override",
        before: FAKE_BEFORE,
        after: FAKE_AFTER,
        drift: FAKE_DRIFT,
        secretsCount: 6,
        operator: "tester",
      }),
    ).rejects.toThrow(/audit write failed.*permission denied/);
  });

  it("3. ulid 字段填充 (id, requestId, timestamp)", async () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "ok", stderr: "" } as any);
    await writeDeployAudit({
      action: "deploy",
      mode: "merge",
      before: FAKE_BEFORE,
      after: FAKE_AFTER,
      drift: FAKE_DRIFT,
      secretsCount: 6,
      operator: "tester",
    });
    const [bin, args] = mockSpawnSync.mock.calls[0] as [string, string[]];
    expect(bin).toBe("tcb");
    // --direct 后面是 JSON 字符串
    const directIdx = args.indexOf("--direct");
    expect(directIdx).toBeGreaterThan(0);
    const json = args[directIdx + 1];
    const entry = JSON.parse(json);
    expect(entry.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);  // ulid pattern
    expect(entry.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  it("4. action=deploy + actor.via=deploy_script 标记", async () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "ok", stderr: "" } as any);
    await writeDeployAudit({
      action: "deploy",
      mode: "merge",
      before: FAKE_BEFORE,
      after: FAKE_AFTER,
      drift: FAKE_DRIFT,
      secretsCount: 6,
      operator: "tester",
    });
    const [, args] = mockSpawnSync.mock.calls[0] as [string, string[]];
    const entry = JSON.parse(args[args.indexOf("--direct") + 1]);
    expect(entry.action).toBe("deploy");
    expect(entry.actor.via).toBe("deploy_script");
    expect(entry.actor.clientIp).toBe("localhost");
    expect(entry.actor.userId).toBe("system");
    expect(entry.target.resourceType).toBe("function");
    expect(entry.operator).toBe("tester");
  });

  it("5. deploySnapshot 包含 before/after/added/removed/changed", async () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "ok", stderr: "" } as any);
    await writeDeployAudit({
      action: "deploy",
      mode: "merge",
      before: FAKE_BEFORE,
      after: FAKE_AFTER,
      drift: FAKE_DRIFT,
      secretsCount: 6,
      operator: "tester",
    });
    const [, args] = mockSpawnSync.mock.calls[0] as [string, string[]];
    const entry = JSON.parse(args[args.indexOf("--direct") + 1]);
    expect(entry.deploySnapshot).toEqual({
      before: { A: "1", B: "2" },
      after: { A: "1", B: "2", C: "3" },
      added: ["C"],
      removed: [],
      changed: [],
    });
  });
});