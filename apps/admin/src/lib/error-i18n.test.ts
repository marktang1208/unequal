/**
 * error-i18n 单元测试（T13）
 */

import { describe, it, expect } from "vitest";
import { translateError, translateErrorMessage } from "./error-i18n.js";

describe("error-i18n (CP-7-C T13)", () => {
  describe("translateError", () => {
    it("已知 code: ParseFailed → 中文 + 不建议重试", () => {
      const r = translateError("ParseFailed", "PDF 损坏");
      expect(r.message).toContain("解析失败");
      expect(r.retryable).toBe(false);
      expect(r.action).toBeDefined();
    });

    it("已知 code: RateLimit → 中文 + 建议重试", () => {
      const r = translateError("RateLimit");
      expect(r.message).toContain("繁忙");
      expect(r.retryable).toBe(true);
    });

    it("已知 code: OMLX_Unavailable → 提到 OMLX", () => {
      const r = translateError("OMLX_Unavailable");
      expect(r.message).toContain("OMLX");
      expect(r.retryable).toBe(true);
    });

    it("未知 code → fallback 含 rawMessage", () => {
      const r = translateError("SomeNewError", "some raw message");
      expect(r.message).toContain("some raw message");
      expect(r.retryable).toBe(true);
    });

    it("code=null + rawMessage=null → 默认 '未知错误'", () => {
      const r = translateError(null, null);
      expect(r.message).toBe("未知错误");
    });

    it("code=undefined → fallback 处理", () => {
      const r = translateError(undefined);
      expect(r.message).toBe("未知错误");
    });
  });

  describe("translateErrorMessage", () => {
    it("纯字符串版本：ParseFailed → 中文", () => {
      expect(translateErrorMessage("ParseFailed")).toContain("解析失败");
    });

    it("纯字符串版本：未知 code + 有 rawMessage → 含 rawMessage", () => {
      expect(translateErrorMessage("Foo", "bar baz")).toContain("bar baz");
    });

    it("纯字符串版本：code=null + rawMessage=null → '未知错误'", () => {
      expect(translateErrorMessage(null, null)).toBe("未知错误");
    });
  });

  describe("完整性：所有已知 code 都有映射", () => {
    it("orchestrator 6 个分类全部覆盖（UnknownError 是 canonical '未知错误'）", () => {
      const codes = ["ParseFailed", "EmbedFailed", "PushFailed", "PushAuthError", "InternalError", "UnknownError"];
      for (const code of codes) {
        const r = translateError(code);
        // 不应该是 rawMessage-fallback（fallback 包含 "错误：" 前缀）
        expect(r.message, `code ${code} should have i18n`).not.toMatch(/^错误：/);
      }
    });

    it("CloudPusher 4 个分类全部覆盖", () => {
      const codes = ["AuthError", "RateLimit", "ServerError", "NetworkError"];
      for (const code of codes) {
        expect(translateError(code).message).not.toBe("未知错误");
      }
    });

    it("LocalEmbedder 4 个分类全部覆盖", () => {
      const codes = ["OMLX_Unavailable", "OOM", "DimensionMismatch", "Unknown"];
      for (const code of codes) {
        expect(translateError(code).message).not.toMatch(/^错误：/);
      }
    });
  });
});