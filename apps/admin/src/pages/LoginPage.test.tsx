/**
 * M6.2 LoginPage jsdom 测试（spec §3.7 / plan §4 task 7.3）+ M6.3a 429 倒计时（plan §4 task 6）。
 *
 * Mock admin api.ts 的 adminLogin；用 @testing-library/react + MemoryRouter
 * 覆盖 mount / 空 input 错误 / 错 admin_token 错误 / 成功提交写 localStorage / 429 倒计时。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@testing-library/jest-dom/vitest";

vi.mock("../lib/api.js", () => ({
  adminLogin: vi.fn(),
}));

import LoginPage from "./LoginPage.js";
import { adminLogin } from "../lib/api.js";

const mockedAdminLogin = vi.mocked(adminLogin);

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("LoginPage (admin_token 输入 form)", () => {
  it("mount: 显示标题 + input + submit button", () => {
    renderWithRouter();
    expect(screen.getByText("Unequal Admin 登录")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/从 .dev.vars/),
    ).toBeInTheDocument();
    expect(screen.getByText("登录")).toBeInTheDocument();
  });

  it("空 input 提交 → 显示 '请输入 admin_token' 错误（不调 adminLogin）", async () => {
    renderWithRouter();
    fireEvent.click(screen.getByText("登录"));
    await waitFor(() => {
      expect(screen.getByText("请输入 admin_token")).toBeInTheDocument();
    });
    expect(mockedAdminLogin).not.toHaveBeenCalled();
  });

  it("错 admin_token → adminLogin 抛错 → 显示错误信息", async () => {
    mockedAdminLogin.mockRejectedValue(
      new Error("/auth/admin-login 401: INVALID_ADMIN_TOKEN"),
    );
    renderWithRouter();
    const input = screen.getByPlaceholderText(
      /从 .dev.vars/,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "wrong-token" } });
    fireEvent.click(screen.getByText("登录"));
    await waitFor(() => {
      expect(screen.getByText(/INVALID_ADMIN_TOKEN/)).toBeInTheDocument();
    });
    expect(mockedAdminLogin).toHaveBeenCalledWith("wrong-token");
  });

  it("成功提交 → 写 localStorage.admin_token + 调 adminLogin 一次", async () => {
    mockedAdminLogin.mockResolvedValue({
      token: "eyJhbGciOiJIUzI1NiJ9.xxx",
      user_id: "01H0000000000000000000000",
      is_admin: true,
      expires_in: 86400,
    });
    renderWithRouter();
    const input = screen.getByPlaceholderText(
      /从 .dev.vars/,
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "test-token-please-change" },
    });
    fireEvent.click(screen.getByText("登录"));
    await waitFor(() => {
      expect(mockedAdminLogin).toHaveBeenCalledWith(
        "test-token-please-change",
      );
    });
    await waitFor(() => {
      expect(localStorage.getItem("admin_token")).toBe(
        "eyJhbGciOiJIUzI1NiJ9.xxx",
      );
    });
  });

  it("M6.3a: 429 + retry_after=10 → 显示 '10s' 倒计时 + 按钮 disabled", async () => {
    // 第一组测试不开 fake timer（避免 waitFor 的 setTimeout 轮询被卡住）：
    // 真实 Date.now() 在测试毫秒内几乎不动，初始 countdown ≈ 10。
    // adminLogin 抛 429 + retry_after=10（err.message 模拟 admin api.ts 的格式）
    mockedAdminLogin.mockRejectedValue(
      new Error(
        '/auth/admin-login 429: {"error":"RATE_LIMITED","retry_after":10,"message":"locked"}',
      ),
    );
    renderWithRouter();
    const input = screen.getByPlaceholderText(
      /从 .dev.vars/,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "wrong-token" } });
    fireEvent.click(screen.getByText("登录"));

    // 倒计时显示 10s（用 button accessible name 匹配）
    await waitFor(
      () => {
        expect(
          screen.getByRole("button", { name: /10s 后可重试/ }),
        ).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    // 按钮 disabled
    const button = screen.getByRole("button", { name: /10s 后可重试/ });
    expect(button).toBeDisabled();
  });

  it("M6.3a: vi.advanceTimersByTime(10000) 后倒计时归零 → 按钮可点", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-16T12:00:00Z"));
      mockedAdminLogin.mockRejectedValue(
        new Error(
          '/auth/admin-login 429: {"error":"RATE_LIMITED","retry_after":10,"message":"locked"}',
        ),
      );
      renderWithRouter();
      const input = screen.getByPlaceholderText(
        /从 .dev.vars/,
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "wrong-token" } });
      fireEvent.click(screen.getByText("登录"));

      // fake timer 下 waitFor 轮询会卡 — 先用 vi.advanceTimersByTimeAsync(0)
      // 触发一次 microtask flush，再手动调用一次 waitFor（轮询靠 act 推进）
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // 初始 10s 倒计时已渲染（waitFor 在 fake timer 下不轮询，靠同步 expect 验证）
      expect(
        screen.getByRole("button", { name: /10s 后可重试/ }),
      ).toBeInTheDocument();

      // 推进 10 秒（setInterval 每秒 -1，10 次后归零）
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      // 倒计时归零：按钮文字恢复 "登录" + 启用
      const button = screen.getByRole("button", { name: "登录" });
      expect(button).not.toBeDisabled();
      // 锁定提示消失
      expect(screen.queryByText(/后可重试/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
