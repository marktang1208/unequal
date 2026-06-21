/**
 * FallbackDetector 单元测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FallbackDetector } from "../../server/fallback-detector.js";

describe("FallbackDetector (CP-7-C T7)", () => {
  let det: FallbackDetector;

  beforeEach(() => {
    det = new FallbackDetector();
  });

  describe("recordSuccess / recordFailure 计数", () => {
    it("初始: 0 失败 → shouldUseCloud = false", () => {
      expect(det.shouldUseCloud("embed")).toBe(false);
      expect(det.getState("embed").consecutiveFailures).toBe(0);
    });

    it("1 失败 → 还不用云端", () => {
      det.recordFailure("embed");
      expect(det.shouldUseCloud("embed")).toBe(false);
      expect(det.getState("embed").consecutiveFailures).toBe(1);
    });

    it("2 失败 → 还不用云端", () => {
      det.recordFailure("embed");
      det.recordFailure("embed");
      expect(det.shouldUseCloud("embed")).toBe(false);
      expect(det.getState("embed").consecutiveFailures).toBe(2);
    });

    it("3 连续失败 → shouldUseCloud = true（临时切云端）", () => {
      det.recordFailure("embed");
      det.recordFailure("embed");
      const r = det.recordFailure("embed");
      expect(r.shouldDisable).toBe(true);
      expect(r.isPermanent).toBe(false);
      expect(det.shouldUseCloud("embed")).toBe(true);
    });
  });

  describe("成功重置", () => {
    it("2 失败 + 1 成功 → 计数重置", () => {
      det.recordFailure("embed");
      det.recordFailure("embed");
      det.recordSuccess("embed");
      expect(det.getState("embed").consecutiveFailures).toBe(0);
      expect(det.getState("embed").totalFailures).toBe(2);  // 累计不清零
    });

    it("2 失败 + 1 成功 + 1 失败 → consecutive = 1（不是 3）", () => {
      det.recordFailure("embed");
      det.recordFailure("embed");
      det.recordSuccess("embed");
      det.recordFailure("embed");
      expect(det.shouldUseCloud("embed")).toBe(false);
    });
  });

  describe("累计 5 次 → 永久禁用", () => {
    it("5 次累计失败（中间有成功）→ disabled = true", () => {
      det.recordFailure("embed");
      det.recordSuccess("embed");
      det.recordFailure("embed");
      det.recordSuccess("embed");
      det.recordFailure("embed");
      det.recordSuccess("embed");
      det.recordFailure("embed");
      det.recordSuccess("embed");
      const r = det.recordFailure("embed");  // 第 5 次累计
      expect(r.isPermanent).toBe(true);
      expect(det.getState("embed").disabled).toBe(true);
      expect(det.shouldUseCloud("embed")).toBe(true);  // 永久用云端
    });
  });

  describe("多 component 独立", () => {
    it("embed 失败 3 次 + llm 失败 0 次 → 各自独立", () => {
      det.recordFailure("embed");
      det.recordFailure("embed");
      det.recordFailure("embed");
      expect(det.shouldUseCloud("embed")).toBe(true);
      expect(det.shouldUseCloud("llm")).toBe(false);
    });
  });

  describe("reset", () => {
    it("reset(component): 只清该 component", () => {
      det.recordFailure("embed");
      det.recordFailure("embed");
      det.recordFailure("embed");
      det.reset("embed");
      expect(det.getState("embed").consecutiveFailures).toBe(0);
    });

    it("reset(): 清所有", () => {
      det.recordFailure("embed");
      det.recordFailure("llm");
      det.reset();
      expect(det.getState("embed").consecutiveFailures).toBe(0);
      expect(det.getState("llm").consecutiveFailures).toBe(0);
    });
  });
});
