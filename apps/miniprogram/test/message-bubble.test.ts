/**
 * message-bubble 单测（CP-7-B 富文本化）
 *
 * 5 用例：
 * - segments prop 默认 []
 * - onCiteTap: n=1 → 调 wx.showToast(citations[0].title)
 * - onCiteTap: n=2 → 调 wx.showToast(citations[1].title)
 * - onCiteTap: 越界 n=99 → toast "未知引用"
 * - onCiteTap: 空 citations → toast "未知引用"
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { Segment } from "../lib/citation-parser.js";

interface Citation {
  n: number;
  title: string;
  snippet?: string;
  trustLevel?: number;
  chunkId: string;
}

interface BubbleProperties {
  role: { value: string };
  text: { value: string };
  cached: { value: boolean };
  citations: { value: Citation[] };
  segments: { value: Segment[] };
}

interface BubbleInstance {
  data: {
    role: string;
    text: string;
    cached: boolean;
    citations: Citation[];
    segments: Segment[];
  };
  onCiteTap: (e: { currentTarget?: { dataset?: { citeN?: string } } }) => void;
}

interface ComponentOpts {
  properties: BubbleProperties;
  methods: { noop: () => void; onCiteTap: (this: BubbleInstance, e: { currentTarget?: { dataset?: { citeN?: string } } }) => void };
}

describe("message-bubble (CP-7-B 富文本)", () => {
  let mockWx: { showToast: ReturnType<typeof vi.fn> };
  let mockComponent: ReturnType<typeof vi.fn>;
  let opts: ComponentOpts;

  beforeAll(async () => {
    // Mock wx + Component + import bubble module
    mockWx = { showToast: vi.fn() };
    mockComponent = vi.fn();
    (globalThis as unknown as { wx: typeof mockWx }).wx = mockWx;
    const globalAny = globalThis as unknown as { Component: (opts: ComponentOpts) => void };
    globalAny.Component = mockComponent as unknown as (opts: ComponentOpts) => void;
    // Import triggers Component({...}) call
    await import("../components/message-bubble/message-bubble.js");
    opts = mockComponent.mock.calls[0]![0] as ComponentOpts;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("segments prop 默认 [] (向后兼容 user 消息)", () => {
    expect(opts.properties.segments.value).toEqual([]);
  });

  it("text + cached + citations + role 默认值存在", () => {
    expect(opts.properties.text.value).toBe("");
    expect(opts.properties.cached.value).toBe(false);
    expect(opts.properties.citations.value).toEqual([]);
    expect(opts.properties.role.value).toBe("user");
  });

  it("onCiteTap: n=1 → 调 wx.showToast(citations[0].title)", () => {
    const instance: BubbleInstance = {
      data: {
        role: "assistant",
        text: "",
        cached: false,
        citations: [{ n: 1, title: "《疫苗指南》", chunkId: "01H" }, { n: 2, title: "《儿科手册》", chunkId: "01H2" }],
        segments: [{ type: "cite", n: 1 }],
      },
      onCiteTap: opts.methods.onCiteTap as BubbleInstance["onCiteTap"],
    };
    instance.onCiteTap({ currentTarget: { dataset: { citeN: "1" } } });
    expect(mockWx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: "《疫苗指南》" }));
  });

  it("onCiteTap: n=2 → 调 wx.showToast(citations[1].title)", () => {
    const instance: BubbleInstance = {
      data: {
        role: "assistant",
        text: "",
        cached: false,
        citations: [{ n: 1, title: "《疫苗指南》", chunkId: "01H" }, { n: 2, title: "《儿科手册》", chunkId: "01H2" }],
        segments: [],
      },
      onCiteTap: opts.methods.onCiteTap as BubbleInstance["onCiteTap"],
    };
    instance.onCiteTap({ currentTarget: { dataset: { citeN: "2" } } });
    expect(mockWx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: "《儿科手册》" }));
  });

  it("onCiteTap: 越界 n=99 → toast '未知引用'", () => {
    const instance: BubbleInstance = {
      data: {
        role: "assistant",
        text: "",
        cached: false,
        citations: [{ n: 1, title: "《疫苗指南》", chunkId: "01H" }],
        segments: [],
      },
      onCiteTap: opts.methods.onCiteTap as BubbleInstance["onCiteTap"],
    };
    instance.onCiteTap({ currentTarget: { dataset: { citeN: "99" } } });
    expect(mockWx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: "未知引用" }));
  });

  it("onCiteTap: 空 citations → toast '未知引用'", () => {
    const instance: BubbleInstance = {
      data: {
        role: "assistant",
        text: "",
        cached: false,
        citations: [],
        segments: [],
      },
      onCiteTap: opts.methods.onCiteTap as BubbleInstance["onCiteTap"],
    };
    instance.onCiteTap({ currentTarget: { dataset: { citeN: "1" } } });
    expect(mockWx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: "未知引用" }));
  });
});