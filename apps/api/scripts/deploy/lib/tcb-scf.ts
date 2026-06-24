/**
 * lib/tcb-scf.ts — Tencent Cloud SCF SDK wrapper
 *
 * 替换旧的 lib/tcb.ts (expect + tcb CLI)。绕开 tcb CLI 3.5.7 的 Merge/Override prompt
 * 不确定行为（P0-#1 副发现）。
 *
 * 流程：
 * 1. initScfClient: 读 Keychain TCB_SECRET_ID/TCB_SECRET_KEY, 缺抛 ScfAuthError
 * 2. getFunctionEnv(functionName): SDK GetFunctionConfiguration → 真云端 env vars
 * 3. setFunctionEnv(functionName, envVars): SDK UpdateFunctionConfiguration → 推云端
 *
 * 鉴权：TCB_SECRET_ID/TCB_SECRET_KEY 是腾讯云 API 3.0 凭证 (与 ADMIN_TOKEN 等 7 secrets 不同的 Keychain entries)
 * atomic: Tencent API 保证全 set 或全不 set (不会出现部分成功)
 */

import { Client } from "tencentcloud-sdk-nodejs-scf";
// @ts-expect-error - @types/tencentcloud-sdk-nodejs-common 缺失, 但 SDK 自带类型
import { Credential } from "tencentcloud-sdk-nodejs-common";
import { keychainGet } from "./keychain.js";
import { DeployError } from "./errors.js";

const TCB_REGION = "ap-shanghai";
const TCB_NAMESPACE = "default";

export class ScfAuthError extends DeployError {
  constructor(msg: string) {
    super(msg);
    this.name = "ScfAuthError";
  }
}

export interface EnvVars {
  [key: string]: string;
}

interface ScfVariable {
  Key?: string;
  Value?: string;
}

/** 初始化 SCF 客户端（读 Keychain 凭证） */
export function initScfClient(): Client {
  const secretId = keychainGet("TCB_SECRET_ID");
  const secretKey = keychainGet("TCB_SECRET_KEY");
  if (!secretId || !secretId.trim()) {
    throw new ScfAuthError("TCB_SECRET_ID not found in keychain; run `tcb login` and add via `security add-generic-password -s unequal:api-router:KEY -a TCB_SECRET_ID -w <id>`");
  }
  if (!secretKey || !secretKey.trim()) {
    throw new ScfAuthError("TCB_SECRET_KEY not found in keychain; run `tcb login` and add via `security add-generic-password -s unequal:api-router:KEY -a TCB_SECRET_KEY -w <key>`");
  }
  const cred = new Credential(secretId, secretKey);
  return new Client(cred, TCB_REGION);
}

/** 真云端 fetch（替换 tcb config pull fn 解析） */
export async function getFunctionEnv(functionName: string): Promise<EnvVars> {
  const client = initScfClient();
  const resp = await client.GetFunctionConfiguration({
    FunctionName: functionName,
    Namespace: TCB_NAMESPACE,
  });
  const variables: ScfVariable[] = resp.Environment?.Variables ?? [];
  const result: EnvVars = {};
  for (const v of variables) {
    if (v.Key) {
      result[v.Key] = v.Value ?? "";
    }
  }
  return result;
}

/** 写云端 env（替换 tcb config update fn + expect） */
export async function setFunctionEnv(
  functionName: string,
  envVars: EnvVars,
): Promise<{ requestId: string }> {
  const client = initScfClient();
  const variables: ScfVariable[] = Object.entries(envVars).map(([k, v]) => ({
    Key: k,
    Value: v,
  }));
  try {
    const resp = await client.UpdateFunctionConfiguration({
      FunctionName: functionName,
      Namespace: TCB_NAMESPACE,
      Environment: { Variables: variables },
    });
    return { requestId: resp.RequestId ?? "unknown" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DeployError(`SCF UpdateFunctionConfiguration failed: ${message}`);
  }
}
