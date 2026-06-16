/**
 * api-cron-cleanup handler（CP-6 Phase 2 stub → Phase 6 完整实现）
 * 定时触发器调用，每日 03:00 UTC 清理超期 login_attempt
 */
import {
  errorResponse,
  type HttpTriggerResponse,
} from "../lib/handler-utils.js";

export async function main(_event: unknown): Promise<HttpTriggerResponse> {
  // TODO Phase 6: loginAttempt.where(createdAt < now - window).remove()
  return errorResponse("NOT_IMPLEMENTED", "api-cron-cleanup stub (CP-6 Phase 2)", 501);
}