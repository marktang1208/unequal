/**
 * lib/tcb-fetch.ts — 读 CloudBase 云端 env vars (SCF API)
 *
 * P4 #3: 改走 SCF SDK GetFunctionConfiguration (替换旧 tcb db nosql execute 路径)
 *
 * 旧实现 (P4 #2): 读 audit_log collection 最新 deploy snapshot 的 deploySnapshot.after
 *  - 问题: 间接、依赖 audit_log 已写、首次 deploy 无 audit 兜底
 * 新实现 (P4 #3): 直接调 SCF API GetFunctionConfiguration 拿真云端 env
 *  - 优势: 确定性、直接、不依赖 audit_log
 *  - 失败: 抛 TcbFetchError, 调用方 fallback 到本地模板 (push 兼容)
 */

import { getFunctionEnv } from "./tcb-scf.js";
import { TcbFetchError } from "./errors.js";
import type { EnvSnapshot } from "./diff.js";

const TCB_ENV = "unequal-d4ggf7rwg82e0900b";
const FUNCTION_NAME = "api-router";

/**
 * 读云端 env vars (真云端, SCF API)
 * @param _envId 保留兼容参数 (老签名), 实际用 FUNCTION_NAME
 * @param functionName 可选, 默认 "api-router"
 */
export async function getRemoteEnvSnapshot(
  _envId: string = TCB_ENV,
  functionName: string = FUNCTION_NAME,
): Promise<EnvSnapshot> {
  try {
    const envVars = await getFunctionEnv(functionName);
    return {
      source: "remote",
      capturedAt: Date.now(),
      envVariables: envVars,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TcbFetchError(`GetFunctionConfiguration failed: ${message}`);
  }
}
