// @ts-nocheck wx 全局类型 mock-first 缺失（miniprogram-api-typings 未安装）
//
// CP-6 测试页：验证 wx.cloud.callFunction 调 api-router
// 走 CloudBase 私有协议，不依赖 HTTP 网关（个人版 HTTP 网关有功能缺失）
// 参考：https://weibo.com/ttarticle/p/show?id=2309405283201403977919

interface TestResult {
  ok: boolean;
  httpStatus: number;
  body: string;
  latencyMs: number;
  error?: string;
}

interface PageData {
  results: TestResult[];
  running: boolean;
  envId: string;
}

const TESTS: Array<{ label: string; httpMethod: string; path: string; body: string | null }> = [
  { label: "GET /api-health", httpMethod: "GET", path: "/api-health", body: null },
  { label: "GET /", httpMethod: "GET", path: "/", body: null },
  { label: "POST /api-search", httpMethod: "POST", path: "/api-search", body: JSON.stringify({ query: "test", topK: 3 }) },
];

Page({
  data: {
    results: [],
    running: false,
    envId: "unequal-d8g4fjk0x5ea36822",
  } as PageData,

  onLoad() {
    // @ts-expect-error wx 全局类型 mock-first 缺失
    const app = getApp();
    if (app?.globalData?.cloudEnvId) {
      this.setData({ envId: app.globalData.cloudEnvId });
    }
  },

  async onRunAll() {
    if (this.data.running) return;
    this.setData({ running: true, results: [] });
    const out: TestResult[] = [];
    for (const t of TESTS) {
      out.push(await this.runOne(t.label, t.httpMethod, t.path, t.body));
      this.setData({ results: [...out] });
    }
    this.setData({ running: false });
  },

  runOne(label: string, httpMethod: string, path: string, body: string | null): Promise<TestResult> {
    return new Promise((resolve) => {
      const start = Date.now();
      // @ts-expect-error wx 全局类型 mock-first 缺失
      wx.cloud.callFunction({
        name: "api-router",
        data: {
          httpMethod,
          path,
          headers: body ? { "content-type": "application/json" } : {},
          queryString: {},
          body,
          isBase64Encoded: false,
        },
        success: (res: { result?: { statusCode?: number; body?: string } }) => {
          const r = res.result ?? {};
          resolve({
            ok: (r.statusCode ?? 0) >= 200 && (r.statusCode ?? 0) < 300,
            httpStatus: r.statusCode ?? 0,
            body: (r.body ?? "").slice(0, 200),
            latencyMs: Date.now() - start,
          });
        },
        fail: (err: { errMsg?: string }) => {
          resolve({
            ok: false,
            httpStatus: 0,
            body: "",
            latencyMs: Date.now() - start,
            error: err.errMsg ?? "callFunction failed",
          });
        },
      });
    });
  },

  onClear() {
    this.setData({ results: [] });
  },
});
