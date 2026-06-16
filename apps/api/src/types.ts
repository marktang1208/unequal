export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  R2: R2Bucket;
  ADMIN_TOKEN: string;
  MINIMAX_API_KEY: string;
  MINIMAX_BASE_URL: string;
  ENVIRONMENT: string;
  ALLOWED_ORIGIN: string;
  // M6.1: Durable Object binding + 鉴权模式
  SESSION_DO?: DurableObjectNamespace;
  AUTH_MODE?: string;
  // M6.2: JWT 签发 + 微信小程序登录
  JWT_SECRET?: string;
  WX_APP_ID?: string;
  WX_APP_SECRET?: string;
  // M6.2 测试依赖注入：/auth/wx-login 通过 env.fetchImpl 注入 mock fetch（spec §3.5）。
  // 生产路径不传，自动 fallback 到全局 fetch。
  fetchImpl?: typeof fetch;
  // M6.4: rate limit 配置（可选；缺省走 lib/rate-limit.ts DEFAULT_RATE_LIMIT_CONFIG）
  LOGIN_MAX_ATTEMPTS?: string;
  LOGIN_WINDOW_MS?: string;
  // M6.4: cron cleanup endpoint 鉴权（M6.4 放 vars；CP-5 真接时改 wrangler secret put）
  CRON_SECRET?: string;
  // M6.7 + M6.8: envelope encryption KEK
  // M6.8: 多 env 变量（KEK_SECRET_V1, V2, V3...）支持 KEK 轮换 + fallback 恢复
  // M6.7 单 KEK_SECRET 改名为 KEK_SECRET_V1（保持兼容老 user data version=1）
  // KEK 丢失 = 老 user 密文全废，必须备份到密码管理器
  KEK_SECRET_V1?: string;
  KEK_SECRET_V2?: string;
  KEK_SECRET_V3?: string;
  KEK_CURRENT_VERSION?: string; // M6.8: current KEK version（默认 "1"）
}
