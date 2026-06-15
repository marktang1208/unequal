import { Hono } from "hono";
import type { Env } from "./types.js";
import { healthRoute } from "./routes/health.js";
import { seedUserRoute } from "./routes/seed-user.js";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => healthRoute.GET(c.req.raw, c.env));

// seed-user 不强制鉴权（MVP 阶段给本地种子脚本用）
app.post("/seed-user", (c) => seedUserRoute.POST(c.req.raw, c.env));

app.notFound((c) => c.text("Not found", 404));

export default app;
