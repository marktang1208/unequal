/**
 * Vite config — admin dev server
 *
 * CP-6 迁移到 CloudBase 后，旧的 `/api` → localhost:8787 proxy (CF Workers dev) 已失效。
 * CP-7-C: admin 上传走本地 Vite middleware（apps/admin/server/local-ingest.ts），
 *   - /api/upload: 接收 multipart → 本地解析 → 本地 embed → 推 CloudBase
 *   - /api/ingest-status: 查本地 SQLite 状态
 *   - /api/retry: 失败重推
 *
 * 旧的 proxy 配置彻底删除（避免误导）。
 */
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { join } from "node:path";
import { localIngestMiddleware, initProductionDeps } from "./server/local-ingest.js";
import { seedsMiddleware } from "./server/seeds-middleware.js";

// P3-7: monorepo root 路径（vite dev server cwd = apps/admin，需从 monorepo root 算 seeds 路径）
const MONOREPO_ROOT = join(process.cwd(), "..", "..");
const DEFAULT_SEEDS_DIR = join(MONOREPO_ROOT, "apps", "crawler", "seeds");

export default defineConfig(({ mode }) => {
  // 加载 .env.local 到 process.env（server middleware 的 process.env.XXX 才能读到）
  // Vite loadEnv 默认只暴露 VITE_ 前缀变量给 client；这里用 '' 前缀全量加载，
  // 注入 process.env（server-side 代码用 process.env.XXX 读取，不用 import.meta.env）
  const envDir = process.cwd();
  const env = loadEnv(mode, envDir, "");
  for (const [key, val] of Object.entries(env)) {
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = val;
    }
  }

  return {
    plugins: [
      react(),
      {
        name: "local-ingest-middleware",
        configureServer(server) {
          // 启动时异步注入真实 Parser/Embedder/Pusher/Chunker
          // 不能 await：configureServer 是 sync；middleware 在第一次请求时已经初始化
          void initProductionDeps();
          server.middlewares.use(localIngestMiddleware);
          // P3-7: 种子 URL 库（绝对路径 seedsDir 避免 dev cwd 漂移）
          server.middlewares.use((req, res, next) => {
            const url = new URL(req.url ?? "/", "http://localhost");
            if (url.pathname === "/api/seeds" || url.pathname.startsWith("/api/seeds?")) {
              if (!url.searchParams.has("seedsDir")) {
                url.searchParams.set("seedsDir", DEFAULT_SEEDS_DIR);
              }
              req.url = url.pathname + url.search;
            }
            next();
          });
          server.middlewares.use(seedsMiddleware);
        },
      },
    ],
    server: {
      port: 5173,
    },
  };
});
