import type { Env } from "../types.js";

export const healthRoute = {
  async GET(_request: Request, env: Env): Promise<Response> {
    return Response.json({
      status: "ok",
      environment: env.ENVIRONMENT,
      timestamp: Date.now(),
    });
  },
};
