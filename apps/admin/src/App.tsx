import { useEffect } from "react";
import type { ReactElement } from "react";
import { Link, Route, Routes, useNavigate } from "react-router-dom";
import Upload from "./pages/Upload.js";
import Sources from "./pages/Sources.js";
import Documents from "./pages/Documents.js";
import SearchTest from "./pages/SearchTest.js";
import AskTest from "./pages/AskTest.js";
import CrawlPage from "./pages/CrawlPage.js";
import XiaohongshuCrawlPage from "./pages/XiaohongshuCrawlPage.js";
import WechatMpCrawlPage from "./pages/WechatMpCrawlPage.js";
import ChatSim from "./pages/ChatSim.js";
import LoginPage from "./pages/LoginPage.js";
import StatsPage from "./pages/StatsPage.js";
import CloudBaseCallTest from "./pages/CloudBaseCallTest.js";

/**
 * 路由级 auth guard：缺 localStorage.admin_token → navigate("/login")。
 * M6.3a 起包 9 个 admin 路由 + catch-all，仅 /login 公开。
 */
function RequireAuth({ children }: { children: ReactElement }) {
  const navigate = useNavigate();
  useEffect(() => {
    const token = localStorage.getItem("admin_token");
    if (!token) {
      navigate("/login", { replace: true });
    }
  }, [navigate]);
  return children;
}

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
          <h1 className="text-lg font-semibold">unequal admin</h1>
          <nav className="flex gap-4 text-sm">
            <Link to="/upload" className="text-gray-600 hover:text-gray-900">
              上传
            </Link>
            <Link to="/sources" className="text-gray-600 hover:text-gray-900">
              源
            </Link>
            <Link to="/documents" className="text-gray-600 hover:text-gray-900">
              文档
            </Link>
            <Link to="/search" className="text-gray-600 hover:text-gray-900">
              检索测试
            </Link>
            <Link to="/ask" className="text-gray-600 hover:text-gray-900">
              问答测试
            </Link>
            <Link to="/chat-sim" className="text-gray-600 hover:text-gray-900">
              Chat Sim
            </Link>
            <Link to="/crawl" className="text-gray-600 hover:text-gray-900">
              网页抓取
            </Link>
            <Link to="/crawl/xiaohongshu" className="text-gray-600 hover:text-gray-900">
              小红书
            </Link>
            <Link to="/crawl/wechat-mp" className="text-gray-600 hover:text-gray-900">
              微信公众号
            </Link>
            <Link to="/stats" className="text-gray-600 hover:text-gray-900">
              统计
            </Link>
            <Link to="/cloudbase-test" className="text-gray-600 hover:text-gray-900">
              CB 测试
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <Routes>
          {/* 公开：仅 /login（M6.2）+ M6.3a 全包 RequireAuth 后的唯一例外 */}
          <Route path="/login" element={<LoginPage />} />

          {/* 9 protected routes（M6.2 仅包 /chat-sim，M6.3a 全包） */}
          <Route
            path="/upload"
            element={
              <RequireAuth>
                <Upload />
              </RequireAuth>
            }
          />
          <Route
            path="/sources"
            element={
              <RequireAuth>
                <Sources />
              </RequireAuth>
            }
          />
          <Route
            path="/documents"
            element={
              <RequireAuth>
                <Documents />
              </RequireAuth>
            }
          />
          <Route
            path="/search"
            element={
              <RequireAuth>
                <SearchTest />
              </RequireAuth>
            }
          />
          <Route
            path="/ask"
            element={
              <RequireAuth>
                <AskTest />
              </RequireAuth>
            }
          />
          <Route
            path="/chat-sim"
            element={
              <RequireAuth>
                <ChatSim />
              </RequireAuth>
            }
          />
          <Route
            path="/crawl"
            element={
              <RequireAuth>
                <CrawlPage />
              </RequireAuth>
            }
          />
          <Route
            path="/crawl/xiaohongshu"
            element={
              <RequireAuth>
                <XiaohongshuCrawlPage />
              </RequireAuth>
            }
          />
          <Route
            path="/crawl/wechat-mp"
            element={
              <RequireAuth>
                <WechatMpCrawlPage />
              </RequireAuth>
            }
          />

          {/* M6.5: login_attempt 可视化 */}
          <Route
            path="/stats"
            element={
              <RequireAuth>
                <StatsPage />
              </RequireAuth>
            }
          />

          {/* CP-6: CloudBase SDK 直接调函数测试（绕过个人版 HTTP 网关） */}
          <Route
            path="/cloudbase-test"
            element={
              <RequireAuth>
                <CloudBaseCallTest />
              </RequireAuth>
            }
          />

          {/* catch-all 也包（M6.2 是裸 Upload，M6.3a 加 RequireAuth 避免侧门） */}
          <Route
            path="*"
            element={
              <RequireAuth>
                <Upload />
              </RequireAuth>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
