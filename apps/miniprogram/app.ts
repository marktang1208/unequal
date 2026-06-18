// @ts-nocheck wx 全局类型 mock-first 缺失（CP-1 / M3 / M6.1 / M6.2 决策容忍）
import { ensureJwt } from "./lib/auth.js";

// @ts-expect-error mock-first wx 类型缺失（miniprogram-api-typings 未安装）
App({
  globalData: {
    // CP-6: CloudBase HTTP 触发器（ap-shanghai, 个人版 env unequal-d4ggf7rwg82e0900b, AppID 1444590671）
    apiBaseUrl: "https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com",
    // 真机调试时必须在微信开发者工具勾选「不校验合法域名」（project.config.json urlCheck:false）
    cloudEnvId: "unequal-d4ggf7rwg82e0900b",
  },
  onLaunch() {
    // CP-6: 初始化微信云开发（小程序私有协议，绕过 request 合法域名限制）
    // 文章 https://weibo.com/ttarticle/p/show?id=2309405283201403977919 明确：
    // "云开发私有协议，不需要配置服务器域名" —— 这是 miniprogram 调云函数的标准路径
    try {
      // @ts-expect-error mock-first wx 类型缺失
      wx.cloud.init({ env: this.globalData.cloudEnvId, traceUser: true });
      // eslint-disable-next-line no-console
      console.log("[unequal] wx.cloud.init ok, env:", this.globalData.cloudEnvId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[unequal] wx.cloud.init failed:", err instanceof Error ? err.message : err);
    }

    // M6.2: 冷启动拿 jwt（不阻塞启动；失败仅 warn）
    void (async () => {
      try {
        await ensureJwt();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[unequal] ensureJwt failed:", err instanceof Error ? err.message : err);
      }
    })();
  },
});
