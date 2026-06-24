/**
 * tcb-scf.test.ts — Unit tests for lib/tcb-scf.ts
 *
 * Mock tencentcloud-sdk-nodejs-scf Client 覆盖 6 cases:
 * 1. initScfClient: TCB_SECRET_ID/KEY 缺 → throw ScfAuthError
 * 2. getFunctionEnv: SDK 返 Environment.Variables[] → 解析为 Record<string,string>
 * 3. getFunctionEnv: SDK 抛错 → 透传
 * 4. setFunctionEnv: SDK 调 UpdateFunctionConfiguration (FunctionName/Namespace/Variables 验证)
 * 5. setFunctionEnv: SDK 抛错 → throw DeployError
 * 6. ScfAuthError 继承 DeployError (instanceof 检查)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted 让 mock 在 vi.mock factory 中可用（避免 TDZ）
const { mockClientCtor, mockGetFunctionConfiguration, mockUpdateFunctionConfiguration } = vi.hoisted(() => {
  const mockGetFunctionConfiguration = vi.fn();
  const mockUpdateFunctionConfiguration = vi.fn();
  const mockClientInstance = {
    GetFunctionConfiguration: mockGetFunctionConfiguration,
    UpdateFunctionConfiguration: mockUpdateFunctionConfiguration,
  };
  const mockClientCtor = vi.fn().mockImplementation(() => mockClientInstance);
  return {
    mockClientCtor,
    mockGetFunctionConfiguration,
    mockUpdateFunctionConfiguration,
  };
});

vi.mock("tencentcloud-sdk-nodejs-scf", () => ({
  Client: mockClientCtor,
}));

vi.mock("tencentcloud-sdk-nodejs-common", () => ({
  Credential: vi.fn().mockImplementation((id, key) => ({ id, key })),
}));

const { keychainGet: mockKeychainGet } = vi.hoisted(() => ({
  keychainGet: vi.fn(),
}));

vi.mock("./keychain.js", () => ({
  keychainGet: mockKeychainGet,
}));

import { initScfClient, getFunctionEnv, setFunctionEnv, ScfAuthError } from "./tcb-scf.js";
import { DeployError } from "./errors.js";

describe("tcb-scf", () => {
  beforeEach(() => {
    mockClientCtor.mockClear();
    mockGetFunctionConfiguration.mockReset();
    mockUpdateFunctionConfiguration.mockReset();
    mockKeychainGet.mockReset();
  });

  describe("initScfClient", () => {
    it("1. TCB_SECRET_ID 缺 → throw ScfAuthError", () => {
      mockKeychainGet.mockImplementation((k) => (k === "TCB_SECRET_ID" ? "" : "some-key"));
      expect(() => initScfClient()).toThrow(ScfAuthError);
      expect(() => initScfClient()).toThrow(/TCB_SECRET_ID.*not found/);
    });

    it("2. TCB_SECRET_KEY 缺 → throw ScfAuthError", () => {
      mockKeychainGet.mockImplementation((k) => (k === "TCB_SECRET_KEY" ? "" : "some-id"));
      expect(() => initScfClient()).toThrow(ScfAuthError);
      expect(() => initScfClient()).toThrow(/TCB_SECRET_KEY.*not found/);
    });

    it("3. 凭证齐 → 返回 Client 实例, Credential(id, key) 注入", () => {
      mockKeychainGet.mockImplementation((k) => (k === "TCB_SECRET_ID" ? "AKID-test" : "secret-test"));
      const client = initScfClient();
      expect(client).toBeDefined();
      expect(mockClientCtor).toHaveBeenCalledTimes(1);
      const credArg = mockClientCtor.mock.calls[0]?.[0];
      expect(credArg).toMatchObject({ id: "AKID-test", key: "secret-test" });
    });
  });

  describe("getFunctionEnv", () => {
    it("4. SDK 返 Environment.Variables[] → 解析为 Record<string,string>", async () => {
      mockKeychainGet.mockImplementation((k) => (k === "TCB_SECRET_ID" ? "id" : "key"));
      mockGetFunctionConfiguration.mockResolvedValueOnce({
        Environment: {
          Variables: [
            { Key: "ADMIN_TOKEN", Value: "tok-123" },
            { Key: "JWT_SECRET", Value: "jwt-456" },
            { Key: "NLI_PROVIDER", Value: "http" },
          ],
        },
      });
      const result = await getFunctionEnv("api-router");
      expect(result).toEqual({
        ADMIN_TOKEN: "tok-123",
        JWT_SECRET: "jwt-456",
        NLI_PROVIDER: "http",
      });
      expect(mockGetFunctionConfiguration).toHaveBeenCalledWith({
        FunctionName: "api-router",
        Namespace: "default",
      });
    });

    it("5. SDK 抛错 → 透传 (不 wrap)", async () => {
      mockKeychainGet.mockImplementation((k) => (k === "TCB_SECRET_ID" ? "id" : "key"));
      const sdkError = new Error("SDK network error");
      mockGetFunctionConfiguration.mockRejectedValueOnce(sdkError);
      await expect(getFunctionEnv("api-router")).rejects.toThrow("SDK network error");
    });

    it("6. Environment.Variables 缺 → 返空对象 (不抛)", async () => {
      mockKeychainGet.mockImplementation((k) => (k === "TCB_SECRET_ID" ? "id" : "key"));
      mockGetFunctionConfiguration.mockResolvedValueOnce({ Environment: undefined });
      const result = await getFunctionEnv("api-router");
      expect(result).toEqual({});
    });

    it("7. Variable.Value 缺 → 视为空字符串", async () => {
      mockKeychainGet.mockImplementation((k) => (k === "TCB_SECRET_ID" ? "id" : "key"));
      mockGetFunctionConfiguration.mockResolvedValueOnce({
        Environment: { Variables: [{ Key: "FOO" }] },
      });
      const result = await getFunctionEnv("api-router");
      expect(result).toEqual({ FOO: "" });
    });
  });

  describe("setFunctionEnv", () => {
    it("8. SDK 调 UpdateFunctionConfiguration + Variables[] 转换", async () => {
      mockKeychainGet.mockImplementation((k) => (k === "TCB_SECRET_ID" ? "id" : "key"));
      mockUpdateFunctionConfiguration.mockResolvedValueOnce({ RequestId: "req-abc-123" });
      const envVars = { ADMIN_TOKEN: "tok", JWT_SECRET: "jwt" };
      const result = await setFunctionEnv("api-router", envVars);
      expect(result.requestId).toBe("req-abc-123");
      expect(mockUpdateFunctionConfiguration).toHaveBeenCalledWith({
        FunctionName: "api-router",
        Namespace: "default",
        Environment: {
          Variables: [
            { Key: "ADMIN_TOKEN", Value: "tok" },
            { Key: "JWT_SECRET", Value: "jwt" },
          ],
        },
      });
    });

    it("9. SDK 抛错 → 抛 DeployError (wrap with message)", async () => {
      mockKeychainGet.mockImplementation((k) => (k === "TCB_SECRET_ID" ? "id" : "key"));
      // 用 mockImplementation (而非 mockRejectedValueOnce) 让每次调用都抛错
      mockUpdateFunctionConfiguration.mockImplementation(async () => {
        throw new Error("SCF API 5xx");
      });
      await expect(setFunctionEnv("api-router", { FOO: "bar" })).rejects.toThrow(DeployError);
      await expect(setFunctionEnv("api-router", { FOO: "bar" })).rejects.toThrow(/SCF API 5xx/);
    });

    it("10. RequestId 缺 → 用 'unknown' 占位", async () => {
      mockKeychainGet.mockImplementation((k) => (k === "TCB_SECRET_ID" ? "id" : "key"));
      mockUpdateFunctionConfiguration.mockResolvedValueOnce({});
      const result = await setFunctionEnv("api-router", { FOO: "bar" });
      expect(result.requestId).toBe("unknown");
    });
  });

  describe("ScfAuthError 继承 DeployError", () => {
    it("11. ScfAuthError instanceof DeployError → true (callers 用 DeployError catch)", () => {
      const err = new ScfAuthError("test");
      expect(err).toBeInstanceOf(DeployError);
      expect(err.name).toBe("ScfAuthError");
    });
  });
});
