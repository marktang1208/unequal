// @ts-nocheck wx 全局类型 mock-first 缺失（miniprogram-api-typings 未安装，按 CP-1 决策容忍）
import type { Citation } from "../../lib/types.js";

Component({
  properties: {
    citation: {
      type: Object,
      required: true,
    },
  },
  methods: {
    onTap(): void {
      const c = (this.data as { citation: Citation }).citation;
      // @ts-expect-error wx 全局类型 mock-first 缺失
      wx.navigateTo({
        url: `/pages/source-detail/source-detail?chunkId=${encodeURIComponent(c.chunkId)}&title=${encodeURIComponent(c.title)}&trustLevel=${c.trustLevel}&rawUrl=${encodeURIComponent(c.url)}`,
      });
      this.triggerEvent("tap", { citation: c });
    },
  },
});
