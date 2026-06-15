import { Link, Route, Routes } from "react-router-dom";
import Upload from "./pages/Upload.js";
import Sources from "./pages/Sources.js";
import Documents from "./pages/Documents.js";
import SearchTest from "./pages/SearchTest.js";
import AskTest from "./pages/AskTest.js";
import CrawlPage from "./pages/CrawlPage.js";
import XiaohongshuCrawlPage from "./pages/XiaohongshuCrawlPage.js";
import WechatMpCrawlPage from "./pages/WechatMpCrawlPage.js";
import ChatSim from "./pages/ChatSim.js";

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
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <Routes>
          <Route path="/upload" element={<Upload />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/search" element={<SearchTest />} />
          <Route path="/ask" element={<AskTest />} />
          <Route path="/chat-sim" element={<ChatSim />} />
          <Route path="/crawl" element={<CrawlPage />} />
          <Route path="/crawl/xiaohongshu" element={<XiaohongshuCrawlPage />} />
          <Route path="/crawl/wechat-mp" element={<WechatMpCrawlPage />} />
          <Route path="*" element={<Upload />} />
        </Routes>
      </main>
    </div>
  );
}