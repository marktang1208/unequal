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

/** CP-7-D #1: LLM model 集中管理（之前硬编码在 ask/chat handler） */
const LLM_MODEL_DEFAULT = "MiniMax-Text-01";
const EMBED_MODEL_DEFAULT = "embo-01";

export interface AppEnv {
  // Secrets
  ADMIN_TOKEN: string;
  JWT_SECRET: string;
  MINIMAX_API_KEY: string;
  KEK_SECRET_V1: string;
  /** CP-7-C #2: 可空 — 未配时 ingest proxy 路径自动 401；admin 路径仍可用 */
  INGEST_PROXY_SECRET?: string;

  // Vars
  ENVIRONMENT: string;
  ALLOWED_ORIGIN: string;
  ADMIN_IP_ALLOWLIST: string;
  MINIMAX_BASE_URL: string;
  DEFAULT_USER_ID: string;
  LOGIN_MAX_ATTEMPTS: number;
  LOGIN_WINDOW_MS: number;
  KEK_CURRENT_VERSION: string;
  /** CP-7-D #1: 抽到 env；未来切换 model 不用改代码 */
  LLM_MODEL: string;
  EMBED_MODEL: string;
  /** P7 #5: LLM max_tokens safety net (默认 2048) */
  LLM_MAX_TOKENS: number;

  // CloudBase specific (auto-injected by runtime)
  TCB_ENV?: string;

  // P5 NLI configuration (spec §8)
  NLI_PROVIDER: "http" | "noop" | "onnx";
  SILICONFLOW_API_KEY?: string;
  SILICONFLOW_BASE_URL: string;
  NLI_MODEL: string;
  NLI_TIMEOUT_MS: number;
  NLI_RETRY_COUNT: number;

  // P6 Phase 1: 本地 ONNX NLI 配置（NLI_PROVIDER=onnx 时用）
  /** 本地模型绝对路径 (CloudBase: /tmp/nli-model.onnx) */
  NLI_MODEL_LOCAL_PATH?: string;
  /** COS 上模型 key (默认 nli-model/model.onnx) */
  NLI_MODEL_COS_KEY?: string;
  /** 本地临时目录 (默认 /tmp) */
  NLI_LOCAL_TMP_DIR?: string;

  // P8: vector DB 选型
  /** "pg" = pgvector (HNSW), "nosql" = 暴力 cosine fallback (P7 现状) */
  VECTOR_STORE: "pg" | "nosql";
  /** P8: pgvector connection string (Keychain, secret 类别) */
  PG_CONNECTION_STRING?: string;
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
    INGEST_PROXY_SECRET: source.INGEST_PROXY_SECRET, // 可空（dev 不配）

    ENVIRONMENT: source.ENVIRONMENT!,
    ALLOWED_ORIGIN: source.ALLOWED_ORIGIN!,
    ADMIN_IP_ALLOWLIST: source.ADMIN_IP_ALLOWLIST!,
    MINIMAX_BASE_URL: source.MINIMAX_BASE_URL ?? "https://api.minimax.chat/v1",
    DEFAULT_USER_ID: source.DEFAULT_USER_ID!,
    LOGIN_MAX_ATTEMPTS: parseInt(source.LOGIN_MAX_ATTEMPTS ?? "5", 10),
    LOGIN_WINDOW_MS: parseInt(source.LOGIN_WINDOW_MS ?? "900000", 10),
    KEK_CURRENT_VERSION: source.KEK_CURRENT_VERSION!,

    // CP-7-D #1: defaults 防 drift；user 改 LLM_MODEL / EMBED_MODEL env 不需改代码
    LLM_MODEL: source.LLM_MODEL ?? LLM_MODEL_DEFAULT,
    EMBED_MODEL: source.EMBED_MODEL ?? EMBED_MODEL_DEFAULT,

    // P7 #5: chat 加速 — LLM max_tokens safety net (防 LLM 跑飞 4K+ 答)
    // 默认 2048 覆盖绝大多数 chat 长答, 极端长答可由 handler 显式 maxTokens override
    LLM_MAX_TOKENS: parseInt(source.LLM_MAX_TOKENS ?? "2048", 10),

    TCB_ENV: source.TCB_ENV,

    // P5 NLI: 默认 http（硅基流动），可通过 NLI_PROVIDER=noop 禁用
    // P6: 新增 onnx 路由（本地 ONNX 模型，无外网依赖）
    NLI_PROVIDER: parseNliProvider(source.NLI_PROVIDER),
    SILICONFLOW_API_KEY: source.SILICONFLOW_API_KEY || undefined,
    SILICONFLOW_BASE_URL: source.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1",
    NLI_MODEL: source.NLI_MODEL ?? "Qwen/Qwen2.5-7B-Instruct",
    NLI_TIMEOUT_MS: parseInt(source.NLI_TIMEOUT_MS ?? "5000", 10),
    NLI_RETRY_COUNT: parseInt(source.NLI_RETRY_COUNT ?? "1", 10),

    // P6 Phase 1: 本地 ONNX 模型配置
    NLI_MODEL_LOCAL_PATH: source.NLI_MODEL_LOCAL_PATH || undefined,
    NLI_MODEL_COS_KEY: source.NLI_MODEL_COS_KEY || "nli-model/nli-MiniLM2-L6-H768-quint8_avx2.onnx",
    NLI_LOCAL_TMP_DIR: source.NLI_LOCAL_TMP_DIR || "/tmp",

    // P8: vector DB 选型 — 默认 nosql 保 P7 现状, Phase 4 灰度改 pg
    VECTOR_STORE: parseVectorStore(source.VECTOR_STORE),
    PG_CONNECTION_STRING: source.PG_CONNECTION_STRING || undefined,
  };
}

/** 解析 VECTOR_STORE env — 支持 pg / nosql */
function parseVectorStore(raw: string | undefined): "pg" | "nosql" {
  if (!raw) return "nosql"; // 默认 nosql (P7 现状)
  const v = raw.toLowerCase();
  if (v === "pg") return "pg";
  return "nosql";
}

/** 解析 NLI_PROVIDER env — 支持 http / noop / onnx，大小写不敏感 */
function parseNliProvider(raw: string | undefined): "http" | "noop" | "onnx" {
  if (!raw) return "http"; // 默认 http
  const v = raw.toLowerCase();
  if (v === "noop") return "noop";
  if (v === "onnx") return "onnx";
  return "http";
}

/** 测试用：直接传 env 对象（不读 process.env） */
export function loadEnvForTest(source: Record<string, string>): AppEnv {
  _env = validateEnvObject(source);
  return _env;
}

/**
 * 启动时硬验证：调一次 embedding，验证维度匹配 EMBEDDING_DIM。
 * 失败 throw → CloudBase 函数冷启动失败 → 不会接收任何请求。
 *
 * 仅在 production 跑（避免本地 dev 强依赖外网）。
 */
export async function validateEmbeddingDim(): Promise<void> {
  if (process.env.ENVIRONMENT !== "production") return;

  // CP-7-D #2: 走 factory（handler 解耦后，dim 验证也走同一路径）
  const { getEmbedder } = await import("./llm-provider.js");
  const embed = getEmbedder();
  const result = await embed.embed(["dimension probe"]);
  if (!result[0] || result[0].length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding dim mismatch: expected ${EMBEDDING_DIM}, got ${result[0]?.length ?? "undefined"}`,
    );
  }
}

/**
 * P5 NLI 启动期校验：NLI_ENABLED=true 时，模型文件必须存在
 * 否则 throw NliConfigError → CloudBase 函数冷启动失败
 *
 * 仅在 production 跑（避免本地 dev 强依赖外网 + 模型文件）
 *
 * P6 扩展：
 *   - NLI_PROVIDER=http  需要 SILICONFLOW_API_KEY
 *   - NLI_PROVIDER=onnx  需要 NLI_MODEL_LOCAL_PATH
 *   - NLI_PROVIDER=noop  无需校验
 */
export async function validateNliConfig(): Promise<void> {
  if (process.env.ENVIRONMENT !== "production") return;
  const env = getEnv();
  if (env.NLI_PROVIDER === "noop") return;

  if (env.NLI_PROVIDER === "http") {
    if (!env.SILICONFLOW_API_KEY) {
      const { NliConfigError } = await import("./nli/errors.js");
      throw new NliConfigError(
        `NLI_PROVIDER=http requires SILICONFLOW_API_KEY. ` +
        `Set NLI_PROVIDER=noop to disable, or export SILICONFLOW_API_KEY before deploy.`,
      );
    }
    return;
  }

  if (env.NLI_PROVIDER === "onnx") {
    if (!env.NLI_MODEL_LOCAL_PATH) {
      const { NliConfigError } = await import("./nli/errors.js");
      throw new NliConfigError(
        `NLI_PROVIDER=onnx requires NLI_MODEL_LOCAL_PATH. ` +
        `Set NLI_PROVIDER=noop to disable, or export NLI_MODEL_LOCAL_PATH=/path/to/model.onnx before deploy.`,
      );
    }
    return;
  }
}

/** 测试用：重置缓存 */
export function resetEnv(): void {
  _env = null;
}

export const EMBEDDING_DIM_CONST = EMBEDDING_DIM;