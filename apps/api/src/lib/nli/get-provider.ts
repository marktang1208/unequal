/**
 * lib/nli/get-provider.ts — 单例 factory: env 路由 + 5min cache + 10-timeout 永久降级
 *
 * 状态机 (spec §5.4 + §7):
 *   1. NLI_PROVIDER=noop → 永返 NoopNliProvider
 *   2. NLI_PROVIDER=http + SILICONFLOW_API_KEY 缺失 → throw NliConfigError（启动期 fail fast，getEnv 校验）
 *   3. NLI_PROVIDER=http + key 存在 → try init HttpNliProvider
 *      - 成功 → 用之
 *      - 失败 (Runtime) → NoopNliProvider + 5 分钟内 retry
 *      - 失败 (Timeout) → NoopNliProvider + 累计 > 10 → 永久降级（直到函数实例重启）
 *
 * 单例：进程内只 1 个 NliProvider 实例，per-process state。
 */

import { NliConfigError, NliRuntimeError, NliTimeoutError } from "./errors.js";
import { NoopNliProvider } from "./noop-provider.js";
import { HttpNliProvider } from "./http-provider.js";
import type { NliProvider } from "./types.js";

const FIVE_MIN_MS = 5 * 60 * 1000;
const TIMEOUT_PERMANENT_THRESHOLD = 10;

interface ProviderState {
  provider: NliProvider;
  failCount: number;
  timeoutCount: number;
  lastFailAt: number;
  permanentFallback: boolean;
}

function createInitialState(): ProviderState {
  return {
    provider: new NoopNliProvider(),
    failCount: 0,
    timeoutCount: 0,
    lastFailAt: 0,
    permanentFallback: false,
  };
}

let state: ProviderState = createInitialState();

export interface GetProviderOptions {
  /** 显式覆盖 provider 类型（测试用） */
  nliProvider?: "http" | "noop";
  /** 显式提供 provider（测试用） */
  providerOverride?: NliProvider;
  /** 显式控制是否抛错（启动期 vs 运行时） */
  throwOnConfigError?: boolean;
  /** HttpNliProvider 的 API key override */
  apiKey?: string;
  /** HttpNliProvider 的 base URL override */
  baseUrl?: string;
  /** HttpNliProvider 的 model override */
  model?: string;
  /** HttpNliProvider 的 timeout override */
  timeoutMs?: number;
}

/**
 * 拿当前 NliProvider 实例
 * - 失败 cache 5 分钟
 * - 失败计数累计 timeout > 10 → 永久降级
 * - 5 分钟后下次调用重新尝试 init HttpNliProvider
 */
export async function getProvider(opts: GetProviderOptions = {}): Promise<NliProvider> {
  // 测试用 override
  if (opts.providerOverride) {
    return opts.providerOverride;
  }

  // 显式 noop
  if (opts.nliProvider === "noop") {
    return new NoopNliProvider();
  }

  // 永久降级（timeout > 10）→ 永返 Noop，函数实例重启清零
  if (state.permanentFallback) {
    return state.provider;
  }

  // 5 分钟内已有失败 → 复用 NoopNliProvider，等 retry window
  if (state.failCount > 0 && Date.now() - state.lastFailAt < FIVE_MIN_MS) {
    return state.provider;
  }

  // 复用成功的 provider（避免每次 new 触发 init）
  if (state.provider && state.provider.name !== "noop" && state.failCount === 0) {
    return state.provider;
  }

  // 显式 http → 走 HttpNliProvider
  if (opts.nliProvider === "http" || (opts.nliProvider === undefined && getNliProviderFromEnv() === "http")) {
    const apiKey = opts.apiKey ?? getSiliconflowApiKeyFromEnv();
    if (!apiKey) {
      if (opts.throwOnConfigError) {
        throw new NliConfigError(
          "NLI_PROVIDER=http requires SILICONFLOW_API_KEY. Set NLI_PROVIDER=noop to disable.",
        );
      }
      console.warn("[nli] SILICONFLOW_API_KEY not set, falling back to noop");
      state.provider = new NoopNliProvider();
      return state.provider;
    }

    try {
      state.provider = new HttpNliProvider(
        apiKey,
        opts.baseUrl,
        opts.model,
        opts.timeoutMs,
      );
      return state.provider;
    } catch (err) {
      // constructor 失败（缺 key 等）— 应被上面的 apiKey 校验挡住，但保险起见 catch
      state.failCount++;
      state.lastFailAt = Date.now();
      if (err instanceof NliConfigError) {
        if (opts.throwOnConfigError) throw err;
        console.warn(`[nli] config error: ${err.message}`);
      } else {
        console.warn(`[nli] provider init error: ${err instanceof Error ? err.message : String(err)}`);
      }
      state.provider = new NoopNliProvider();
      return state.provider;
    }
  }

  // env 显式 noop
  if (getNliProviderFromEnv() === "noop") {
    state.provider = new NoopNliProvider();
    return state.provider;
  }

  // env = http + key 缺失
  if (getNliProviderFromEnv() === "http" && !getSiliconflowApiKeyFromEnv()) {
    if (opts.throwOnConfigError) {
      throw new NliConfigError(
        "NLI_PROVIDER=http requires SILICONFLOW_API_KEY. Set NLI_PROVIDER=noop to disable.",
      );
    }
    console.warn("[nli] SILICONFLOW_API_KEY not set, falling back to noop");
    state.provider = new NoopNliProvider();
    return state.provider;
  }

  // 默认 (env NLI_PROVIDER 未设或异常) → 走 noop
  state.provider = new NoopNliProvider();
  return state.provider;
}

/**
 * 记录一次 NLI verify 失败（外部 catch 后调用）
 * 触发 5min cache / 10-timeout 永久降级状态机
 */
export function recordNliFailure(err: Error): void {
  state.failCount++;
  state.lastFailAt = Date.now();
  if (err instanceof NliTimeoutError) {
    state.timeoutCount++;
    if (state.timeoutCount > TIMEOUT_PERMANENT_THRESHOLD) {
      state.permanentFallback = true;
      console.warn(`[nli] timeout count > ${TIMEOUT_PERMANENT_THRESHOLD}, permanent fallback to noop`);
    } else {
      console.warn(`[nli] verify timeout (count=${state.timeoutCount})`);
    }
  } else if (err instanceof NliRuntimeError) {
    console.warn(`[nli] verify runtime error: ${err.message}`);
  } else {
    console.warn(`[nli] verify unknown error: ${err.message}`);
  }
  state.provider = new NoopNliProvider();
}

/**
 * 记录一次 NLI verify 成功
 * 重置 failCount，让 5min 缓存逻辑正常工作
 */
export function recordNliSuccess(): void {
  if (state.failCount > 0) {
    state.failCount = 0;
    state.timeoutCount = 0;
  }
}

/** 测试用：reset 单例 state */
export function __resetProviderStateForTest(): void {
  state = createInitialState();
}

function getNliProviderFromEnv(): "http" | "noop" {
  const v = process.env.NLI_PROVIDER;
  if (v === undefined || v === "") return "http"; // 默认启用 http
  return v.toLowerCase() === "noop" ? "noop" : "http";
}

function getSiliconflowApiKeyFromEnv(): string | undefined {
  return process.env.SILICONFLOW_API_KEY || undefined;
}
