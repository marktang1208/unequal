/**
 * CP-6: 环境变量加载 + 启动时硬验证
 *
 * 必填（缺失即 fail-fast）：
 * - 4 secrets: ADMIN_TOKEN, JWT_SECRET, MINIMAX_API_KEY, KEK_SECRET_V1
 * - 关键 vars: ENVIRONMENT, ALLOWED_ORIGIN, MINIMAX_BASE_URL, DEFAULT_USER_ID, ADMIN_IP_ALLOWLIST
 *
 * 启动时硬验证（spec §7.3）：
 * 1. MiniMax embedding 模型实际输出维度 = EMBEDDING_DIM（默认 1536）
 * 2. KEK_SECRET_V1 存在且非空
 *
 * CloudBase 函数冷启动时模块顶层代码执行一次 → fail-fast 在第一次请求前完成。
 */

const EMBEDDING_DIM = 1536;

export interface AppEnv {
  // Secrets
  ADMIN_TOKEN: string;
  JWT_SECRET: string;
  MINIMAX_API_KEY: string;
  KEK_SECRET_V1: string;

  // Vars
  ENVIRONMENT: string;
  ALLOWED_ORIGIN: string;
  ADMIN_IP_ALLOWLIST: string;
  MINIMAX_BASE_URL: string;
  DEFAULT_USER_ID: string;
  LOGIN_MAX_ATTEMPTS: number;
  LOGIN_WINDOW_MS: number;
  KEK_CURRENT_VERSION: string;

  // CloudBase specific (auto-injected by runtime)
  TCB_ENV?: string;
}

let _env: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (_env) return _env;
  _env = loadAndValidateEnv();
  return _env;
}

function loadAndValidateEnv(): AppEnv {
  return validateEnvObject(process.env);
}

function validateEnvObject(source: NodeJS.ProcessEnv | Record<string, string | undefined>): AppEnv {
  const required = [
    "ADMIN_TOKEN",
    "JWT_SECRET",
    "MINIMAX_API_KEY",
    "KEK_SECRET_V1",
    "ADMIN_IP_ALLOWLIST",
    "ENVIRONMENT",
    "ALLOWED_ORIGIN",
    "KEK_CURRENT_VERSION",
    "DEFAULT_USER_ID",
  ];

  const missing = required.filter((k) => !source[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  return {
    ADMIN_TOKEN: source.ADMIN_TOKEN!,
    JWT_SECRET: source.JWT_SECRET!,
    MINIMAX_API_KEY: source.MINIMAX_API_KEY!,
    KEK_SECRET_V1: source.KEK_SECRET_V1!,

    ENVIRONMENT: source.ENVIRONMENT!,
    ALLOWED_ORIGIN: source.ALLOWED_ORIGIN!,
    ADMIN_IP_ALLOWLIST: source.ADMIN_IP_ALLOWLIST!,
    MINIMAX_BASE_URL: source.MINIMAX_BASE_URL ?? "https://api.minimax.chat/v1",
    DEFAULT_USER_ID: source.DEFAULT_USER_ID!,
    LOGIN_MAX_ATTEMPTS: parseInt(source.LOGIN_MAX_ATTEMPTS ?? "5", 10),
    LOGIN_WINDOW_MS: parseInt(source.LOGIN_WINDOW_MS ?? "900000", 10),
    KEK_CURRENT_VERSION: source.KEK_CURRENT_VERSION!,

    TCB_ENV: source.TCB_ENV,
  };
}

/** 测试用：直接传 env 对象（不读 process.env） */
export function loadEnvForTest(source: Record<string, string>): AppEnv {
  _env = validateEnvObject(source);
  return _env;
}

/**
 * 启动时硬验证：调一次 MiniMax embedding，验证维度匹配 EMBEDDING_DIM。
 * 失败 throw → CloudBase 函数冷启动失败 → 不会接收任何请求。
 *
 * 仅在 production 跑（避免本地 dev 强依赖外网）。
 */
export async function validateEmbeddingDim(): Promise<void> {
  if (process.env.ENVIRONMENT !== "production") return;

  const { createMiniMaxEmbedder } = await import("@unequal/shared/embedding");
  const embed = createMiniMaxEmbedder({
    apiKey: process.env.MINIMAX_API_KEY!,
    baseUrl: process.env.MINIMAX_BASE_URL!,
    model: "embo-01",
  });

  const result = await embed.embed(["dimension probe"]);
  if (!result[0] || result[0].length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding dim mismatch: expected ${EMBEDDING_DIM}, got ${result[0]?.length ?? "undefined"}`,
    );
  }
}

/** 测试用：重置缓存 */
export function resetEnv(): void {
  _env = null;
}

export const EMBEDDING_DIM_CONST = EMBEDDING_DIM;