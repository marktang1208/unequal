import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types.js";
import { healthRoute } from "./routes/health.js";
import { seedUserRoute } from "./routes/seed-user.js";
import { uploadRoute } from "./routes/upload.js";
import { ingestRoute } from "./routes/ingest.js";
import { searchRoute } from "./routes/search.js";

const app = new Hono<{ Bindings: Env }>();

// CORS：admin 前端在生产部署（Cloudflare Pages）跨域访问 api Worker。
// MVP 阶段允许 *；生产应改为具体 origin（通过 wrangler var 注入 ALLOWED_ORIGIN）。
app.use("*", cors({
  origin: (origin, c) => {
    const allowed = c.env.ALLOWED_ORIGIN;
    if (!allowed || allowed === "*") return "*";
    return allowed;
  },
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

app.get("/health", (c) => healthRoute.GET(c.req.raw, c.env));

// seed-user 不强制鉴权（MVP 阶段给本地种子脚本用）
app.post("/seed-user", (c) => seedUserRoute.POST(c.req.raw, c.env));

// 鉴权：admin token（Bearer）；在路由内部用 verifyAdminToken
app.post("/upload", (c) => uploadRoute.POST(c.req.raw, c.env));
app.post("/ingest", (c) => ingestRoute.POST(c.req.raw, c.env));
app.get("/search", (c) => searchRoute.GET(c.req.raw, c.env));

app.notFound((c) => c.text("Not found", 404));

export default app;
