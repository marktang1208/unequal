import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types.js";
import { healthRoute } from "./routes/health.js";
import { seedUserRoute } from "./routes/seed-user.js";
import { uploadRoute } from "./routes/upload.js";
import { ingestRoute } from "./routes/ingest.js";
import { searchRoute } from "./routes/search.js";
import { askRoute } from "./routes/ask.js";
import { chatRoute } from "./routes/chat.js";
import { sessionsRoute } from "./routes/sessions.js";
import { authRoute } from "./routes/auth.js";
import { userRoute } from "./routes/user.js";
import { cronRoute } from "./routes/cron.js";
import { statsRoute } from "./routes/stats.js";
import { scheduled } from "./scheduled.js";

const app = new Hono<{ Bindings: Env }>();

// CORS：admin 前端在生产部署（Cloudflare Pages）跨域访问 api Worker。
// MVP 阶段允许 *；生产应改为具体 origin（通过 wrangler var 注入 ALLOWED_ORIGIN）。
app.use("*", cors({
  origin: (origin, c) => {
    const allowed = c.env.ALLOWED_ORIGIN;
    if (!allowed || allowed === "*") return "*";
    return allowed;
  },
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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
app.post("/ask", (c) => askRoute.POST(c.req.raw, c.env));

// M6.1: 多轮会话 + Durable Objects
app.post("/chat", (c) => chatRoute.POST(c.req.raw, c.env));
app.get("/sessions", (c) => sessionsRoute.LIST(c.req.raw, c.env));
app.get("/sessions/:id", (c) => sessionsRoute.GET(c.req.raw, c.env, c.req.param("id")!));
app.patch("/sessions/:id", (c) => sessionsRoute.PATCH(c.req.raw, c.env, c.req.param("id")!));
app.delete("/sessions/:id", (c) => sessionsRoute.DELETE(c.req.raw, c.env, c.req.param("id")!));

// M6.2: 鉴权 + JWT 签发（spec §3.3 + §3.4）
app.post("/auth/wx-login", (c) => authRoute.WX_LOGIN(c.req.raw, c.env));
app.post("/auth/admin-login", (c) => authRoute.ADMIN_LOGIN(c.req.raw, c.env));

// M6.3c: miniprogram nickname-input 组件触发的 nickname 写入（spec §5）
app.patch("/user/nickname", (c) => userRoute.UPDATE_NICKNAME(c.req.raw, c.env));

// M6.4: cron 清理 login_attempt（M6.5 起 scheduled handler 主路径，HTTP 备用）
app.post("/cron/cleanup-login-attempts", (c) => cronRoute.CLEANUP_LOGIN_ATTEMPTS(c.req.raw, c.env));

// M6.5: login_attempt 可视化（admin JWT 鉴权）
app.get("/stats/login-attempts", (c) => statsRoute.GET_LOGIN_ATTEMPTS(c.req.raw, c.env));

app.notFound((c) => c.text("Not found", 404));

// M6.5: Cloudflare Workers scheduled handler（CF Cron Triggers 触发）。
// HTTP /cron/cleanup-login-attempts 端点保留作为外部 cron 兼容入口。
export default {
  fetch: app.fetch.bind(app),
  scheduled,
};
