/**
 * M6.5 admin StatsPage 测试套件（spec §6.4 + plan §4 Task 3b）。
 *
 * 3 用例：
 * 1. 初始渲染 + 加载 + 数据填充：mock getLoginAttemptStats 返 stub → 数字卡 + by_type + bars
 * 2. 切换 hours 触发重新 fetch：mock spy → 改 select 值 → 验证 spy 二次被调 + 新 hours
 * 3. 错误态：mock reject Error → 错误红字
 *
 * 测试策略：vitest + jsdom + RTL + MemoryRouter + mock lib/api.js
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@testing-library/jest-dom/vitest";

vi.mock("../lib/api.js", () => ({
  getLoginAttemptStats: vi.fn(),
}));

import StatsPage from "./StatsPage.js";
import { getLoginAttemptStats } from "../lib/api.js";
import type { LoginAttemptStats } from "../lib/api.js";

const mockedGetStats = vi.mocked(getLoginAttemptStats);

function makeStubStats(hours = 24): LoginAttemptStats {
  const currentHourTs = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const byHour = [];
  for (let i = hours - 1; i >= 0; i--) {
    byHour.push({
      hour_ts: currentHourTs - i * 3_600_000,
      failed: i % 3 === 0 ? 1 : 0,
      succeeded: i % 5 === 0 ? 2 : 0,
    });
  }
  const total_failed = byHour.reduce((s, h) => s + h.failed, 0);
  const total_succeeded = byHour.reduce((s, h) => s + h.succeeded, 0);
  return {
    window_hours: hours,
    cutoff: Date.now() - hours * 3_600_000,
    total_failed,
    total_succeeded,
    by_type: {
      admin: { failed: Math.floor(total_failed / 2), succeeded: Math.floor(total_succeeded / 2) },
      wx_code: { failed: total_failed - Math.floor(total_failed / 2), succeeded: total_succeeded - Math.floor(total_succeeded / 2) },
    },
    by_hour: byHour,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <StatsPage />
    </MemoryRouter>,
  );
}

describe("StatsPage (M6.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("初始渲染: 加载中 → 数字卡 + by_type + bars (mock 数据填充)", async () => {
    mockedGetStats.mockResolvedValue(makeStubStats(24));

    renderPage();

    // 初始加载
    expect(screen.getByText("加载中…")).toBeInTheDocument();

    // 等 mock resolve + render
    await waitFor(() => {
      expect(screen.queryByText("加载中…")).not.toBeInTheDocument();
    });

    // 数字卡：失败 / 成功 / 失败率 / 总尝试
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getByText("成功")).toBeInTheDocument();
    expect(screen.getByText("失败率")).toBeInTheDocument();
    expect(screen.getByText("总尝试")).toBeInTheDocument();

    // 类型分布表格
    expect(screen.getByText("Admin login")).toBeInTheDocument();
    expect(screen.getByText("Wx code")).toBeInTheDocument();

    // hours select 选项
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("24");

    // 验证 getLoginAttemptStats 被调一次 + 参数 24
    expect(mockedGetStats).toHaveBeenCalledTimes(1);
    expect(mockedGetStats).toHaveBeenCalledWith(24);
  });

  it("切换 hours: 改 select 值 → 重新 fetch + 新 hours", async () => {
    mockedGetStats.mockResolvedValue(makeStubStats(24));

    renderPage();

    await waitFor(() => {
      expect(screen.queryByText("加载中…")).not.toBeInTheDocument();
    });

    // 切到 72h
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "72" } });

    // 验证 spy 第二次被调 + 参数 72
    await waitFor(() => {
      expect(mockedGetStats).toHaveBeenCalledTimes(2);
    });
    expect(mockedGetStats).toHaveBeenNthCalledWith(2, 72);

    // 切到 168h
    fireEvent.change(select, { target: { value: "168" } });
    await waitFor(() => {
      expect(mockedGetStats).toHaveBeenCalledTimes(3);
    });
    expect(mockedGetStats).toHaveBeenNthCalledWith(3, 168);
  });

  it("错误态: fetch reject → 显示红字错误信息", async () => {
    mockedGetStats.mockRejectedValue(new Error("500 Internal Server Error"));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/stats failed: 500 Internal Server Error/)).toBeInTheDocument();
    });

    // 数字卡不应渲染
    expect(screen.queryByText("总尝试")).not.toBeInTheDocument();
  });
});
