import type { Env } from "../types.js";
import { verifyAuth, HttpError } from "../lib/auth.js";

export const ingestRoute = {
  async POST(request: Request, env: Env): Promise<Response> {
    try {
      await verifyAuth(request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json({ error: err.code, message: err.message }, { status: err.status });
      }
      throw err;
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
