/**
 * diff.test.ts — Unit tests for lib/diff.ts
 *
 * 8 cases:
 * 1. 纯添加 (added)
 * 2. 纯删除 (removed) — Override 模式独有
 * 3. 单 var 改 (changed)
 * 4. KEK_CURRENT_VERSION +1 → warning (不报警)
 * 5. KEK_CURRENT_VERSION +5 → drift too large 报警
 * 6. force 跳过防漂移检查
 * 7. 空 diff (vars 一致)
 * 8. 阈值边界: Δ=2 不报警，Δ=3 报警
 */

import { describe, it, expect } from "vitest";
import { diffEnv, type EnvSnapshot } from "./diff.js";

const t = (env: Record<string, string>): EnvSnapshot => ({
  source: "local-template",
  capturedAt: 0,
  envVariables: env,
});

describe("diffEnv", () => {
  it("1. 纯添加 (added)", () => {
    const before = t({ A: "1", B: "2" });
    const after = t({ A: "1", B: "2", C: "3" });
    const r = diffEnv(before, after);
    expect(r.added).toEqual(["C"]);
    expect(r.removed).toEqual([]);
    expect(r.changed).toEqual([]);
  });

  it("2. 纯删除 (removed) — Override 模式独有", () => {
    const before = t({ A: "1", B: "2", C: "3" });
    const after = t({ A: "1", B: "2" });
    const r = diffEnv(before, after);
    expect(r.removed).toEqual(["C"]);
    expect(r.added).toEqual([]);
    expect(r.changed).toEqual([]);
  });

  it("3. 单 var 改 (changed)", () => {
    const before = t({ A: "1", B: "old" });
    const after = t({ A: "1", B: "new" });
    const r = diffEnv(before, after);
    expect(r.changed).toEqual([{ key: "B", before: "old", after: "new" }]);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it("4. KEK_CURRENT_VERSION +1 → warning (不报警，tcb 自增)", () => {
    const before = t({ KEK_CURRENT_VERSION: "1", OTHER: "x" });
    const after = t({ KEK_CURRENT_VERSION: "2", OTHER: "x" });
    const r = diffEnv(before, after);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/KEK_CURRENT_VERSION changed: 1 → 2/);
  });

  it("5. KEK_CURRENT_VERSION +5 → drift too large 报警", () => {
    const before = t({ KEK_CURRENT_VERSION: "1" });
    const after = t({ KEK_CURRENT_VERSION: "6" });
    const r = diffEnv(before, after);
    expect(r.warnings.some((w) => w.includes("drift too large"))).toBe(true);
  });

  it("6. force 跳过防漂移检查（仍记 changed）", () => {
    const before = t({ KEK_CURRENT_VERSION: "1" });
    const after = t({ KEK_CURRENT_VERSION: "6" });
    const r = diffEnv(before, after, { forceVersionDrift: true });
    expect(r.warnings).toHaveLength(0);
    expect(r.changed).toEqual([{ key: "KEK_CURRENT_VERSION", before: "1", after: "6" }]);
  });

  it("7. 空 diff (vars 一致)", () => {
    const before = t({ A: "1", B: "2" });
    const after = t({ A: "1", B: "2" });
    const r = diffEnv(before, after);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.changed).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("8. 阈值边界: Δ=2 不 abort，但 warn 'changed' (delta≠0)", () => {
    const before = t({ KEK_CURRENT_VERSION: "1" });
    const after = t({ KEK_CURRENT_VERSION: "3" }); // Δ=2
    const r = diffEnv(before, after);
    // abs(2) > 2 false → 不 abort
    expect(r.warnings.some((w) => w.includes("drift too large"))).toBe(false);
    // delta !== 0 → warn "changed"
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/KEK_CURRENT_VERSION changed: 1 → 3/);
  });

  it("8b. 阈值边界: Δ=3 abort + warn 'drift too large'", () => {
    const before = t({ KEK_CURRENT_VERSION: "1" });
    const after = t({ KEK_CURRENT_VERSION: "4" }); // Δ=3
    const r = diffEnv(before, after);
    expect(r.warnings.some((w) => w.includes("drift too large"))).toBe(true);
  });
});