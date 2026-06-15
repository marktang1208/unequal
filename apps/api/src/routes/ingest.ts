import type { Env } from "../types.js";
import { verifyAdminToken } from "../lib/auth.js";

export const ingestRoute = {
  async POST(request: Request, env: Env): Promise<Response> {
    const auth = verifyAdminToken(request.headers.get("Authorization"), env.ADMIN_TOKEN);
    if (!auth.ok) {
      return Response.json({ error: auth.message }, { status: auth.status });
    }

    let body: unknown = null;
    const text = await request.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text; // 保留原始字符串，方便调试
      }
    }

    return Response.json(
      { message: "ingest endpoint reserved for crawler (M4+)", body },
      { status: 501 }
    );
  },
};
