import type { Env } from "../types.js";

export const seedUserRoute = {
  async POST(request: Request, env: Env): Promise<Response> {
    const body = (await request.json()) as { id?: string; nickname?: string };
    if (!body.id) {
      return new Response("Missing id", { status: 400 });
    }

    // 幂等：已存在则跳过
    const existing = await env.DB.prepare("SELECT id FROM user WHERE id = ?")
      .bind(body.id)
      .first();

    if (existing) {
      return Response.json({ id: body.id, created: false });
    }

    await env.DB.prepare(
      "INSERT INTO user (id, nickname, created_at) VALUES (?, ?, ?)"
    )
      .bind(body.id, body.nickname ?? "default", Date.now())
      .run();

    return Response.json({ id: body.id, created: true });
  },
};
