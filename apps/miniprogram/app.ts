// @ts-nocheck wx 全局类型 mock-first 缺失（CP-1 / M3 / M6.1 / M6.2 决策容忍）
import { ensureJwt } from "./lib/auth.js";

// @ts-expect-error mock-first wx 类型缺失（miniprogram-api-typings 未安装）
App({
  globalData: {
    apiBaseUrl: "https://unequal-api.<appid>.<region>.app.tcloudbase.com",  // CP-6 CloudBase 真接后 (was CF workers.dev)
    // 真机调试时必须在微信开发者工具勾选「不校验合法域名」
  },
  async onLaunch() {
    // M6.2: 冷启动拿 jwt（不阻塞启动；失败仅 warn）
    try {
      await ensureJwt();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[unequal] ensureJwt failed:", err instanceof Error ? err.message : err);
    }
  },
});
