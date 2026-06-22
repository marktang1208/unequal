/**
 * P3-7 种子 URL 库: SeedsPage UI 测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import SeedsPage from "./Seeds.js";

function makeFetchMock(seeds: unknown[] = []) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ urls: seeds }),
  });
}

describe("SeedsPage (P3-7)", () => {
  beforeEach(() => {
    globalThis.fetch = makeFetchMock();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("初始渲染: 标题 + 4 tab + 空提示", async () => {
    render(<SeedsPage />);
    expect(screen.getByText("种子 URL 库")).toBeInTheDocument();
    expect(screen.getByTestId("seeds-tab-all")).toBeInTheDocument();
    expect(screen.getByTestId("seeds-tab-xhs")).toBeInTheDocument();
    expect(screen.getByTestId("seeds-tab-wechat-mp")).toBeInTheDocument();
    expect(screen.getByTestId("seeds-tab-webpage")).toBeInTheDocument();
    // 空提示
    await waitFor(() => {
      expect(screen.getByTestId("seeds-empty")).toBeInTheDocument();
    });
  });

  it("切 tab: 过滤 source", async () => {
    const seeds = [
      { url: "https://xhs.com/1", source: "xhs", trust_level: 0, active: true, last_crawled_at: null, last_status: null, last_crawled_at_ms: null, last_error: null, retry_count: 0 },
      { url: "https://wx.com/1", source: "wechat-mp", trust_level: 2, active: true, last_crawled_at: null, last_status: null, last_crawled_at_ms: null, last_error: null, retry_count: 0 },
    ];
    globalThis.fetch = makeFetchMock(seeds);
    render(<SeedsPage />);
    await waitFor(() => {
      expect(screen.getByText(/xhs.com\/1/)).toBeInTheDocument();
    });
    // 切到 wechat-mp tab
    fireEvent.click(screen.getByTestId("seeds-tab-wechat-mp"));
    await waitFor(() => {
      expect(screen.queryByText(/xhs.com\/1/)).not.toBeInTheDocument();
      expect(screen.getByText(/wx.com\/1/)).toBeInTheDocument();
    });
  });

  it("点 '添加 URL' → 弹表单 → 单条提交", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url, opts) => {
      if (opts?.method === "POST") {
        return { ok: true, status: 201, json: async () => ({ added: 1, skipped: 0, errors: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ urls: [] }) };
    });
    globalThis.fetch = fetchMock;

    render(<SeedsPage />);
    fireEvent.click(screen.getByTestId("seeds-add-toggle"));

    expect(screen.getByTestId("seeds-add-form")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("seeds-add-url"), {
      target: { value: "https://www.xiaohongshu.com/explore/ui-test" },
    });
    fireEvent.click(screen.getByTestId("seeds-add-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("seeds-info")).toBeInTheDocument();
      expect(screen.getByTestId("seeds-info").textContent).toMatch(/已添加/);
    });
  });

  it("批量粘贴 3 条 → 调 POST with batch", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url, opts) => {
      if (opts?.method === "POST") {
        const body = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            added: body.batch.length,
            skipped: 0,
            errors: [],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ urls: [] }) };
    });
    globalThis.fetch = fetchMock;

    render(<SeedsPage />);
    fireEvent.click(screen.getByTestId("seeds-add-toggle"));

    // 切到批量粘贴
    const batchBtn = screen.getByText("批量粘贴");
    fireEvent.click(batchBtn);

    fireEvent.change(screen.getByTestId("seeds-add-batch"), {
      target: { value: "https://a.com/1\nhttps://a.com/2\nhttps://a.com/3" },
    });
    fireEvent.click(screen.getByTestId("seeds-add-submit"));

    await waitFor(() => {
      // 验证 fetch 被调过 POST + body.batch 3 条
      const postCall = fetchMock.mock.calls.find((c) => c[1]?.method === "POST");
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall![1]!.body);
      expect(body.batch).toHaveLength(3);
      // 验证 UI 反馈
      expect(screen.getByTestId("seeds-info").textContent).toMatch(/added=3/);
    });
  });
});