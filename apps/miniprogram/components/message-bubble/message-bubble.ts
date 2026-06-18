// @ts-nocheck wx 全局类型 mock-first 缺失（miniprogram-api-typings 未安装，按 CP-1 决策容忍）
import type { Citation } from "../../lib/types.js";
import type { Segment } from "../../lib/citation-parser.js";

Component({
  properties: {
    role: {
      type: String,
      value: "user",
    },
    text: {
      type: String,
      value: "",
    },
    cached: {
      type: Boolean,
      value: false,
    },
    citations: {
      type: Array,
      value: [] as Citation[],
    },
    /** CP-7-B 新增：富文本 segments（解析 [N] 后的 text/cite 数组） */
    segments: {
      type: Array,
      value: [] as Segment[],
    },
  },
  methods: {
    noop(): void {
      // 防止模板无方法时报警告
    },
    /**
     * CP-7-B 新增：点击 [N] cite → 找 citations[n-1] → wx.showToast(title)
     * 越界或空 citations → toast "未知引用"
     */
    onCiteTap(e: { currentTarget?: { dataset?: { citeN?: string } } }): void {
      const nStr = e.currentTarget?.dataset?.citeN;
      const n = parseInt(nStr ?? "", 10);
      const citations = (this.data as { citations: Citation[] }).citations;
      const citation = Number.isFinite(n) && n >= 1 ? citations[n - 1] : undefined;
      // @ts-expect-error wx 全局类型 mock-first 缺失
      wx.showToast({
        title: citation?.title ?? "未知引用",
        icon: "none",
        duration: 1500,
      });
    },
  },
});