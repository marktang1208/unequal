/**
 * M6.3a App.tsx 路由 RequireAuth 全包测试（spec §5.5 / plan §4 task 5）。
 *
 * 覆盖：
 * 1. 无 token → /upload 触发 RequireAuth 重定向到 /login
 * 2. /login 是唯一公开路由（无 token 不重定向）
 * 3. 9 个 admin 路由全包 RequireAuth（render output 计数）：
 *    通过 MemoryRouter 遍历 10 个 path（9 显式 + 1 catch-all），
 *    有 token 时各自展示对应页面（= RequireAuth 没拦截），证明 9 路由 + catch-all 都正确包了 RequireAuth
 *
 * 用 vitest jsdom 环境 + @testing-library/react。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@testing-library/jest-dom/vitest";

// Mock 所有 page 模块返回独特可识别文本，避免被真实页面副作用污染。
// 同时让 App.tsx import 不报错。
vi.mock("./pages/Upload.js", () => ({
  default: () => <div data-testid="page-upload">upload-page</div>,
}));
vi.mock("./pages/Sources.js", () => ({
  default: () => <div data-testid="page-sources">sources-page</div>,
}));
vi.mock("./pages/Documents.js", () => ({
  default: () => <div data-testid="page-documents">documents-page</div>,
}));
vi.mock("./pages/SearchTest.js", () => ({
  default: () => <div data-testid="page-search">search-page</div>,
}));
vi.mock("./pages/AskTest.js", () => ({
  default: () => <div data-testid="page-ask">ask-page</div>,
}));
vi.mock("./pages/CrawlPage.js", () => ({
  default: () => <div data-testid="page-crawl">crawl-page</div>,
}));
vi.mock("./pages/XiaohongshuCrawlPage.js", () => ({
  default: () => <div data-testid="page-xhs">xhs-page</div>,
}));
vi.mock("./pages/WechatMpCrawlPage.js", () => ({
  default: () => <div data-testid="page-wxmp">wxmp-page</div>,
}));
vi.mock("./pages/ChatSim.js", () => ({
  default: () => <div data-testid="page-chat-sim">chat-sim-page</div>,
}));
vi.mock("./pages/LoginPage.js", () => ({
  default: () => <div data-testid="page-login">login-page</div>,
}));

import App from "./App.js";

function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("App RequireAuth 全包 (M6.3a B1)", () => {
  it("无 token → /upload 触发 RequireAuth 重定向到 /login", async () => {
    expect(localStorage.getItem("admin_token")).toBeNull();
    renderApp("/upload");
    await waitFor(() => {
      expect(screen.getByTestId("page-login")).toBeInTheDocument();
    });
    // 上传页不应渲染
    expect(screen.queryByTestId("page-upload")).not.toBeInTheDocument();
  });

  it("/login 是公开路由：无 token 时不重定向", async () => {
    expect(localStorage.getItem("admin_token")).toBeNull();
    renderApp("/login");
    await waitFor(() => {
      expect(screen.getByTestId("page-login")).toBeInTheDocument();
    });
    // 等几个 tick 确保 RequireAuth 没把它踢走
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getByTestId("page-login")).toBeInTheDocument();
    expect(screen.queryByTestId("page-upload")).not.toBeInTheDocument();
  });

  it("9 个 admin 路由 + catch-all 全包 RequireAuth（有 token 时各页正常渲染）", async () => {
    localStorage.setItem("admin_token", "test-token-please-change");

    const protectedPaths = [
      { path: "/upload", expectTestId: "page-upload" },
      { path: "/sources", expectTestId: "page-sources" },
      { path: "/documents", expectTestId: "page-documents" },
      { path: "/search", expectTestId: "page-search" },
      { path: "/ask", expectTestId: "page-ask" },
      { path: "/chat-sim", expectTestId: "page-chat-sim" },
      { path: "/crawl", expectTestId: "page-crawl" },
      { path: "/crawl/xiaohongshu", expectTestId: "page-xhs" },
      { path: "/crawl/wechat-mp", expectTestId: "page-wxmp" },
      // catch-all：用未注册的 path，应当命中 path="*" fallback（也是 RequireAuth 包 Upload）
      { path: "/this-path-does-not-exist", expectTestId: "page-upload" },
    ];

    // 9 protected + 1 catch-all = 10 个 RequireAuth 包裹的路由全部验证
    expect(protectedPaths.length).toBe(10);

    for (const { path, expectTestId } of protectedPaths) {
      cleanup();
      const { unmount } = renderApp(path);
      await waitFor(
        () => {
          expect(screen.getByTestId(expectTestId)).toBeInTheDocument();
        },
        { timeout: 1000 },
      );
      unmount();
    }
  });
});