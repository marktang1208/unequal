// 小程序全局逻辑
// @ts-expect-error mock-first wx 类型缺失（miniprogram-api-typings 未安装，按 CP-1 决策容忍）
App({
  globalData: {
    apiBaseUrl: "http://localhost:8787",  // CP-5 后改 https://unequal.xxx.workers.dev
    // 真机调试时必须在微信开发者工具勾选「不校验合法域名」
  },
  onLaunch() {
    // 启动时拉历史问答（chat 页 onShow 时也拉一次）
    console.log("unequal miniprogram launched");
  },
});
