/**
 * api-auth-wx-login handler（CP-6 Phase 3 完整实现）
 *
 * wx.cloud.callFunction 调用 → CloudBase 自动注入 WX_CONTEXT
 * event.userInfo.openId 拿微信 openid（spec §5.4）
 *
 * 流程：
 * 1. 提取 openid
 * 2. user collection 查找/创建
 * 3. sign JWT (user scope)
 * 4. 返 { jwt, user_id }
 */

import {
  errorResponse,
  jsonResponse,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";
import { getEnv } from "../lib/env.js";
import { signJwt } from "../lib/jwt.js";
import { add, getById, whereQuery, COLLECTIONS } from "../lib/db.js";
import type { User } from "@unequal/shared/types";

interface WXLoginEvent {
  userInfo?: { openId?: string };
  // 兼容 CloudBase 多种字段命名（spec §10.2 风险）
  openid?: string;
  OPENID?: string;
}

interface WXLoginResponse {
  jwt: string;
  user_id: string;
  is_new_user: boolean;
}

export async function main(event: unknown): Promise<HttpTriggerResponse> {
  const env = getEnv();

  // 1. 提取 openid（兼容多种字段名；spec §10.2 风险）
  const e = event as WXLoginEvent;
  const openid = e.userInfo?.openId ?? e.openid ?? e.OPENID;
  if (!openid) {
    return errorResponse(
      "INVALID_REQUEST",
      "Missing openid in WX_CONTEXT (tried userInfo.openId, openid, OPENID)",
      400,
    );
  }

  // 2. 查找用户（按 wxOpenid）
  const existing = await whereQuery<User>(COLLECTIONS.user, { wxOpenid: openid }, { limit: 1 });
  let user = existing[0];
  let isNewUser = false;

  if (!user) {
    // 注：db.add() 生成 CloudBase _id（ULID）；schema id 字段不用，永远空
    // 用 _id 作 user 身份（JWT.sub）
    const newUser: User = {
      id: "",
      wxOpenid: openid,
      createdAt: Date.now(),
    };
    const userId = await add<User>(COLLECTIONS.user, newUser);
    user = (await getById<User>(COLLECTIONS.user, userId)) ?? undefined;
    isNewUser = true;
  }
  if (!user) {
    return errorResponse("INTERNAL_ERROR", "user upsert failed", 500);
  }

  // 3. sign JWT — sub = CloudBase _id（user 身份），nickname handler 用 _id 查
  const jwt = await signJwt({
    userId: user._id,
    scope: "user",
    secret: env.JWT_SECRET,
  });

  // 4. 返
  const resp: WXLoginResponse = {
    jwt,
    user_id: user._id,
    is_new_user: isNewUser,
  };
  return jsonResponse(resp);
}