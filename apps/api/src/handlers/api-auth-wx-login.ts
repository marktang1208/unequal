/**
 * api-auth-wx-login handler（CP-6 Phase 2 stub → Phase 3 完整实现）
 * wx.cloud.callFunction 调用此 handler → CloudBase WX_CONTEXT 注入 openid
 */
import {
  errorResponse,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";

export async function main(event: unknown): Promise<HttpTriggerResponse> {
  // TODO Phase 3: extract event.openid (WX_CONTEXT) + user.findOrCreate + JWT
  return errorResponse("NOT_IMPLEMENTED", "api-auth-wx-login stub (CP-6 Phase 2)", 501);
  void event;
}