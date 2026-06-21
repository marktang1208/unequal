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
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localIngestMiddleware, initProductionDeps } from "./server/local-ingest.js";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "local-ingest-middleware",
      configureServer(server) {
        // 启动时注入真实 Parser/Embedder/Pusher/Chunker
        initProductionDeps();
        server.middlewares.use(localIngestMiddleware);
      },
    },
  ],
  server: {
    port: 5173,
  },
});
