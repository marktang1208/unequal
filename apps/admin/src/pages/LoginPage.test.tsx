/**
 * M6.2 LoginPage jsdom 测试（spec §3.7 / plan §4 task 7.3）。
 *
 * Mock admin api.ts 的 adminLogin；用 @testing-library/react + MemoryRouter
 * 覆盖 mount / 空 input 错误 / 错 admin_token 错误 / 成功提交写 localStorage。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
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
});
