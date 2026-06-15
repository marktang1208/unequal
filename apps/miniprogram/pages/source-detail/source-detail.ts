// @ts-nocheck wx 全局类型 mock-first 缺失（miniprogram-api-typings 未安装，按 CP-1 决策容忍）

interface SourceDetailData {
  chunkId: string;
  title: string;
  trustLevel: 0 | 1 | 2 | 3;
  rawUrl: string;
  loading: boolean;
}

Page({
  data: {
    chunkId: "",
    title: "",
    trustLevel: 0,
    rawUrl: "",
    loading: false,
  } as SourceDetailData,

  onLoad(query: Record<string, string | undefined>): void {
    const trustRaw = Number(query.trustLevel ?? "0");
    const trustLevel = (
      trustRaw === 1 || trustRaw === 2 || trustRaw === 3 ? trustRaw : 0
    ) as 0 | 1 | 2 | 3;
    this.setData({
      chunkId: query.chunkId ?? "",
      title: query.title ?? "引用详情",
      trustLevel,
      rawUrl: query.rawUrl ?? "",
    });
  },

  onOpenRaw(): void {
    if (!this.data.rawUrl) {
      // @ts-expect-error wx 全局类型 mock-first 缺失
      wx.showToast({ title: "无原文链接", icon: "none" });
      return;
    }
    // @ts-expect-error wx 全局类型 mock-first 缺失
    wx.setClipboardData({
      data: this.data.rawUrl,
      success: () => {
        // @ts-expect-error wx 全局类型 mock-first 缺失
        wx.showToast({ title: "链接已复制", icon: "success" });
      },
    });
  },
});
