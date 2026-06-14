export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  R2: R2Bucket;
  ADMIN_TOKEN: string;
  MINIMAX_API_KEY: string;
  MINIMAX_BASE_URL: string;
  ENVIRONMENT: string;
}
