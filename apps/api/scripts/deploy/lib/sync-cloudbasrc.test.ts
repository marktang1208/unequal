/**
 * sync-cloudbasrc.test.ts — TDD for sync-cloudbasrc.ts
 *
 * 覆盖 5 cases:
 *   1. 默认: 读 template + 9 Keychain secrets → merge → 写到 target (14 + 9 = 23 vars)
 *   2. 写入: 顶层字段 (version / envId / functionRoot / functions[0].name) 完整保留
 *   3. env vars 数量 + 内容: 14 template + 9 secrets 都在
 *   4. 写入 idempotent: 再跑一次内容一致 (覆盖式写入, 内容相同)
 *   5. 错误: templatePath 不存在 → 抛错
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { syncCloudbasrcFromTemplate, SECRETS } from "./sync-cloudbasrc.js";

let tmpDir: string;
const mockKeychainGet = vi.fn();

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sync-cb-test-"));
  mockKeychainGet.mockReset();
  // 默认 9 secrets 都有值
  mockKeychainGet.mockImplementation((key: string) => `kc-value-for-${key}`);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

import { afterEach } from "vitest";

describe("syncCloudbasrcFromTemplate", () => {
  it("默认: 读 template + 9 Keychain secrets → merge → 写 target (23 vars)", async () => {
    const templatePath = join(tmpDir, "template.json");
    const targetPath = join(tmpDir, "minipgm", "cloudfunctions", "api-router", "cloudbaserc.json");

    // 写 template (14 vars, P6 当前 cloudbaserc.json 结构)
    const template = {
      version: "2.0",
      envId: "test-env",
      functionRoot: ".",
      functions: [
        {
          name: "api-router",
          type: "Event",
          runtime: "Nodejs20.19",
          handler: "index.main",
          timeout: 30,
          memorySize: 256,
          installDependency: true,
          envVariables: {
            ENVIRONMENT: "production",
            NLI_PROVIDER: "onnx",
            NLI_MODEL_LOCAL_PATH: "/tmp/nli-model.onnx",
            NLI_MODEL_COS_KEY: "nli-model/test.onnx",
            NLI_LOCAL_TMP_DIR: "/tmp",
            NLI_TIMEOUT_MS: "5000",
            NLI_RETRY_COUNT: "1",
            NLI_MIN_ANSWER_LEN: "100",
            MINIMAX_BASE_URL: "https://api.minimax.chat/v1",
            DEFAULT_USER_ID: "01H0000000000000000000000",
            LOGIN_MAX_ATTEMPTS: "5",
            LOGIN_WINDOW_MS: "900000",
            KEK_CURRENT_VERSION: "1",
            ALLOWED_ORIGIN: "*",
          },
        },
      ],
    };
    writeFileSync(templatePath, JSON.stringify(template, null, 2));

    await syncCloudbasrcFromTemplate({
      templatePath,
      targetPath,
      keychainGet: mockKeychainGet,
    });

    // target 写出来了
    expect(existsSync(targetPath)).toBe(true);
    const written = JSON.parse(readFileSync(targetPath, "utf-8"));

    // 顶层字段保留
    expect(written.version).toBe("2.0");
    expect(written.envId).toBe("test-env");
    expect(written.functionRoot).toBe(".");
    expect(written.functions[0].name).toBe("api-router");

    // env vars = 14 template + 9 secrets = 23
    const ev = written.functions[0].envVariables;
    expect(Object.keys(ev).length).toBe(14 + SECRETS.length);

    // template 的 14 vars 都在
    expect(ev.NLI_PROVIDER).toBe("onnx");
    expect(ev.NLI_MODEL_LOCAL_PATH).toBe("/tmp/nli-model.onnx");
    expect(ev.KEK_CURRENT_VERSION).toBe("1");

    // 9 Keychain secrets 都被写入
    for (const secret of SECRETS) {
      expect(ev[secret]).toBe(`kc-value-for-${secret}`);
    }

    // mockKeychainGet 被调用 9 次 (每个 secret 一次)
    expect(mockKeychainGet).toHaveBeenCalledTimes(SECRETS.length);
    for (const secret of SECRETS) {
      expect(mockKeychainGet).toHaveBeenCalledWith(secret);
    }
  });

  it("顶层字段 (version / envId / functionRoot / functions[0] 非 envVariables) 完整保留", async () => {
    const templatePath = join(tmpDir, "template.json");
    const targetPath = join(tmpDir, "out.json");

    const template = {
      version: "2.0",
      envId: "test-env-2",
      functionRoot: "./custom-root",
      functions: [
        {
          name: "api-router",
          type: "Event",
          runtime: "Nodejs20.19",
          handler: "index.main",
          timeout: 60, // 改 timeout 验证保留
          memorySize: 512, // 改 memorySize 验证保留
          installDependency: true,
          envVariables: {
            NLI_PROVIDER: "noop",
          },
        },
      ],
    };
    writeFileSync(templatePath, JSON.stringify(template, null, 2));

    await syncCloudbasrcFromTemplate({
      templatePath,
      targetPath,
      keychainGet: mockKeychainGet,
    });

    const written = JSON.parse(readFileSync(targetPath, "utf-8"));
    expect(written.version).toBe("2.0");
    expect(written.envId).toBe("test-env-2");
    expect(written.functionRoot).toBe("./custom-root");
    expect(written.functions[0].type).toBe("Event");
    expect(written.functions[0].runtime).toBe("Nodejs20.19");
    expect(written.functions[0].handler).toBe("index.main");
    expect(written.functions[0].timeout).toBe(60); // 保留
    expect(written.functions[0].memorySize).toBe(512); // 保留
    expect(written.functions[0].installDependency).toBe(true);
  });

  it("env vars 数量: 14 template + 9 secrets = 23 (SECRETS 数组硬编码 9 项)", async () => {
    // SECRETS 数组应该跟 push.ts SECRETS 保持一致 (P6 Phase 5)
    // 防止以后误删 (e.g. 漏掉 CLOUDBASE_SECRET_*), 触发 runtime 缺失
    expect(SECRETS.length).toBe(9);
    expect(SECRETS).toContain("ADMIN_TOKEN");
    expect(SECRETS).toContain("JWT_SECRET");
    expect(SECRETS).toContain("MINIMAX_API_KEY");
    expect(SECRETS).toContain("KEK_SECRET_V1");
    expect(SECRETS).toContain("INGEST_PROXY_SECRET");
    expect(SECRETS).toContain("ADMIN_IP_ALLOWLIST");
    expect(SECRETS).toContain("SILICONFLOW_API_KEY");
    expect(SECRETS).toContain("CLOUDBASE_SECRET_ID");
    expect(SECRETS).toContain("CLOUDBASE_SECRET_KEY");
  });

  it("写入 idempotent: 跑两次 target 内容一致 (覆盖式)", async () => {
    const templatePath = join(tmpDir, "template.json");
    const targetPath = join(tmpDir, "out.json");

    const template = {
      version: "2.0",
      envId: "test",
      functionRoot: ".",
      functions: [
        {
          name: "api-router",
          type: "Event",
          runtime: "Nodejs20.19",
          handler: "index.main",
          timeout: 30,
          memorySize: 256,
          installDependency: true,
          envVariables: { NLI_PROVIDER: "onnx" },
        },
      ],
    };
    writeFileSync(templatePath, JSON.stringify(template, null, 2));

    // 第一次
    await syncCloudbasrcFromTemplate({
      templatePath,
      targetPath,
      keychainGet: mockKeychainGet,
    });
    const firstContent = readFileSync(targetPath, "utf-8");

    // 第二次 (mockKeychainGet 仍返相同值)
    await syncCloudbasrcFromTemplate({
      templatePath,
      targetPath,
      keychainGet: mockKeychainGet,
    });
    const secondContent = readFileSync(targetPath, "utf-8");

    expect(secondContent).toBe(firstContent);
  });

  it("错误: templatePath 不存在 → 抛错", async () => {
    const targetPath = join(tmpDir, "out.json");
    const fakeTemplatePath = join(tmpDir, "nonexistent.json");

    await expect(
      syncCloudbasrcFromTemplate({
        templatePath: fakeTemplatePath,
        targetPath,
        keychainGet: mockKeychainGet,
      }),
    ).rejects.toThrow(/template not found/);
  });
});