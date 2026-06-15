// @ts-nocheck wx 全局类型 mock-first 缺失（miniprogram-api-typings 未安装，按 CP-1 决策容忍）
import type { Citation } from "../../lib/types.js";

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
  },
  methods: {
    noop(): void {
      // 防止模板无方法时报警告
    },
  },
});
