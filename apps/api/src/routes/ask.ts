import { verifyAdminToken } from "../lib/auth.js";
import { runAsk } from "../lib/ask.js";
import type { Env } from "../types.js";

export const askRoute = {
  async POST(request: Request, env: Env): Promise<Response> {
    const auth = verifyAdminToken(request.headers.get("Authorization"), env.ADMIN_TOKEN);
    if (!auth.ok) {
      return Response.json({ error: auth.message }, { status: auth.status });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const q = typeof (body as { q?: unknown })?.q === "string"
      ? (body as { q: string }).q.trim()
      : "";
    if (!q) {
      return Response.json({ error: "Missing or empty 'q' field" }, { status: 400 });
    }

    try {
      const result = await runAsk({ q, env });
      return Response.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("LLM chat failed")) {
        return Response.json({ error: "upstream_unavailable" }, { status: 502 });
      }
      return Response.json({ error: "internal", detail: msg }, { status: 500 });
    }
  },
};