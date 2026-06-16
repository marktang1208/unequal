/**
 * M6.3c user 路由（spec §5）。
 *
 * PATCH /user/nickname — 写 user.nickname（miniprogram 端 nickname-input 组件触发）。
 *
 * 鉴权：verifyAuth (jwt)。admin 模式拒（spec §7 ADMIN_CANNOT_SET_NICKNAME 400）。
 * 错误：401 鉴权失败（走 verifyAuth）/ 400 缺/空/过长 nickname。
 * 0 migration 改动：M0-M1 0001_init.sql 已留 user.nickname TEXT 字段。
 */
import { verifyAuth, HttpError } from "../lib/auth.js";
import type { Env } from "../types.js";

interface UpdateNicknameRequestBody {
  nickname?: unknown;
}

const NICKNAME_MAX_LENGTH = 20;

export const userRoute = {
  async UPDATE_NICKNAME(request: Request, env: Env): Promise<Response> {
    try {
      // 1. 鉴权（verifyAuth 内部 throw HttpError 401）
      const identity = await verifyAuth(request, env);

      // 2. admin 模式不允许改 nickname
      if (identity.isAdmin) {
        return Response.json(
          { error: "ADMIN_CANNOT_SET_NICKNAME", message: "Admin cannot set nickname" },
          { status: 400 },
        );
      }

      // 3. body 解析
      let body: UpdateNicknameRequestBody;
      try {
        body = (await request.json()) as UpdateNicknameRequestBody;
      } catch {
        return Response.json(
          { error: "INVALID_JSON", message: "Body must be JSON" },
          { status: 400 },
        );
      }

      // 4. nickname 验证
      if (body.nickname === undefined || body.nickname === null) {
        return Response.json(
          { error: "MISSING_NICKNAME", message: "Missing 'nickname' field" },
          { status: 400 },
        );
      }
      const nickname = typeof body.nickname === "string" ? body.nickname.trim() : "";
      if (!nickname) {
        return Response.json(
          { error: "NICKNAME_EMPTY", message: "Nickname cannot be empty" },
          { status: 400 },
        );
      }
      if (nickname.length > NICKNAME_MAX_LENGTH) {
        return Response.json(
          {
            error: "NICKNAME_TOO_LONG",
            message: `Nickname exceeds ${NICKNAME_MAX_LENGTH} characters`,
          },
          { status: 400 },
        );
      }

      // 5. 写 D1（userId 不存在 → 0 row 静默，idempotent）
      await env.DB
        .prepare("UPDATE user SET nickname = ? WHERE id = ?")
        .bind(nickname, identity.userId)
        .run();

      return Response.json({ nickname });
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.code, message: err.message },
          { status: err.status },
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: "internal", detail: msg }, { status: 500 });
    }
  },
};
