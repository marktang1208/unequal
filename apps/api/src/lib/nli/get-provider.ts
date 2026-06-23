/**
 * lib/nli/get-provider.ts — 单例 factory: env 路由 + 5min cache + 10-timeout 永久降级
 *
 * 状态机 (spec §5.4 + §7):
 *   1. NLI_ENABLED=false → 永返 NoopNliProvider
 *   2. NLI_ENABLED=true + 模型文件不存在 → throw NliConfigError（启动期 fail fast，getEnv 校验）
 *   3. NLI_ENABLED=true + 模型文件存在 → try init TransformersNliProvider
 *      - 成功 → 用之
 *      - 失败 (Runtime) → NoopNliProvider + 5 分钟内 retry
 *      - 失败 (Timeout) → NoopNliProvider + 累计 > 10 → 永久降级（直到函数实例重启）
 *
 * 单例：进程内只 1 个 NliProvider 实例，per-process state。
 */

import { NliConfigError, NliRuntimeError, NliTimeoutError } from "./errors.js";
import { NoopNliProvider } from "./noop-provider.js";
import { TransformersNliProvider } from "./transformers-provider.js";
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
  /** 显式覆盖 env（测试用） */
  nliEnabled?: boolean;
  /** 显式提供 provider（测试用） */
  providerOverride?: NliProvider;
  /** 显式控制是否抛错（启动期 vs 运行时） */
  throwOnConfigError?: boolean;
  /** TransformersNliProvider 的 model name override */
  modelName?: string;
  /** TransformersNliProvider 的 timeout override */
  timeoutMs?: number;
}

/**
 * 拿当前 NliProvider 实例
 * - 失败 cache 5 分钟
 * - 失败计数累计 timeout > 10 → 永久降级
 * - 5 分钟后下次调用重新尝试 init TransformersNliProvider
 */
export async function getProvider(opts: GetProviderOptions = {}): Promise<NliProvider> {
  // 测试用 override
  if (opts.providerOverride) {
    return opts.providerOverride;
  }

  // 显式禁用
  if (opts.nliEnabled === false) {
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

  // 5 分钟后或首次 → 重新尝试
  const envEnabled = opts.nliEnabled ?? getNliEnabledFromEnv();
  if (!envEnabled) {
    // 显式禁用的 cache（避免每次调 getNliEnabledFromEnv）
    state.provider = new NoopNliProvider();
    return state.provider;
  }

  // 检查模型文件存在性
  const modelPath = getNliModelPathFromEnv();
  if (!modelPath) {
    if (opts.throwOnConfigError) {
      throw new NliConfigError(
        "NLI_MODEL_PATH env not set. Set NLI_ENABLED=false or configure NLI_MODEL_PATH.",
      );
    }
    console.warn("[nli] NLI_MODEL_PATH not set, falling back to noop");
    state.provider = new NoopNliProvider();
    return state.provider;
  }

  // 尝试创建 TransformersNliProvider
  try {
    state.provider = new TransformersNliProvider(
      opts.modelName,
      true,
      opts.timeoutMs,
    );
    // 触发 init（warm-up）以验证模型可加载
    await warmupPipeline(state.provider);
    state.failCount = 0;
    state.timeoutCount = 0;
    return state.provider;
  } catch (err) {
    state.failCount++;
    state.lastFailAt = Date.now();
    if (err instanceof NliTimeoutError) {
      state.timeoutCount++;
      if (state.timeoutCount > TIMEOUT_PERMANENT_THRESHOLD) {
        state.permanentFallback = true;
        console.warn(`[nli] timeout count > ${TIMEOUT_PERMANENT_THRESHOLD}, permanent fallback to noop`);
      } else {
        console.warn(`[nli] provider init timeout (count=${state.timeoutCount})`);
      }
    } else if (err instanceof NliRuntimeError) {
      console.warn(`[nli] provider init failed: ${err.message}`);
    } else if (err instanceof NliConfigError) {
      if (opts.throwOnConfigError) {
        throw err;
      }
      console.warn(`[nli] config error: ${err.message}`);
    } else {
      console.warn(`[nli] provider init unknown error: ${err instanceof Error ? err.message : String(err)}`);
    }
    state.provider = new NoopNliProvider();
    return state.provider;
  }
}

/**
 * 触发一次 verify 让 TransformersNliProvider 完成 init（避免首次 ask 时 +1-2s init 开销）
 * 用 trivial 输入（empty 会抛错，用两个非空短字符串）
 */
async function warmupPipeline(provider: NliProvider): Promise<void> {
  await provider.verify("warmup", "warmup");
}

/** 测试用：reset 单例 state */
export function __resetProviderStateForTest(): void {
  state = createInitialState();
}

function getNliEnabledFromEnv(): boolean {
  const v = process.env.NLI_ENABLED;
  if (v === undefined || v === "") return true; // 默认启用
  return v.toLowerCase() === "true" || v === "1";
}

function getNliModelPathFromEnv(): string | undefined {
  return process.env.NLI_MODEL_PATH || undefined;
}
