import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发端口 5173；`/api/*` 通过 Vite 代理转发到本地 Workers（8787）
// 转发时去掉 `/api` 前缀，所以 React 调用 `/api/upload` 实际命中 `/upload`
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});