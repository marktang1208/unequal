// @ts-nocheck wx 全局类型 mock-first 缺失（miniprogram-api-typings 未安装，按 CP-1 决策容忍）
// P11.2: webview 页面 — 接 query.url + 动态改 navigationBarTitleText
// 微信小程序的 <web-view> 自动调用微信内置浏览器打开 URL, 需在 onLoad 解析 query
// 注意: web-view 页面需要在「微信公众平台 → 开发管理 → 服务器域名」配置业务域名
// (开发/体验版可临时关校验, 正式版必须配置)

interface PageQuery {
  url?: string;
  title?: string;
}

Page({
  data: {
    url: "" as string,
  },

  onLoad(query: PageQuery): void {
    const url = query.url ?? "";
    const title = query.title ?? "加载中…";
    if (url) {
      // @ts-expect-error wx 全局类型 mock-first 缺失
      wx.setNavigationBarTitle({ title });
      this.setData({ url });
    } else {
      // @ts-expect-error wx 全局类型 mock-first 缺失
      wx.setNavigationBarTitle({ title: "参数错误" });
    }
  },
});
