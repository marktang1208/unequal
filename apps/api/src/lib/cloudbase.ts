/**
 * CP-6: CloudBase SDK 单例初始化
 *
 * CloudBase 云函数运行时：SDK 自动从函数上下文获取凭据（无需 init 显式传 secretId/secretKey）。
 * 本地开发 / 单元测试：可通过 process.env.TCB_ENV 显式指定环境，配合 .dev.vars 里的 secretId/secretKey。
 */

import cloudbase from "@cloudbase/node-sdk";

type CloudBaseApp = ReturnType<typeof cloudbase.init>;

let _app: CloudBaseApp | null = null;

export function getCloudBaseApp(): CloudBaseApp {
  if (_app) return _app;

  const env = process.env.TCB_ENV || cloudbase.SYMBOL_CURRENT_ENV;
  _app = cloudbase.init({ env });
  return _app;
}

/** 测试用：重置单例（让测试注入不同 env） */
export function resetCloudBaseApp(): void {
  _app = null;
}

/** 取 DB helper */
export function getDB() {
  return getCloudBaseApp().database();
}

/** 取 Storage helper（云存储） */
export function getStorage() {
  return getCloudBaseApp();
}