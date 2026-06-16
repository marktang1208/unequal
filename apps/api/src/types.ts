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
}
