import { Link, Route, Routes } from "react-router-dom";
import Upload from "./pages/Upload.js";
import Sources from "./pages/Sources.js";
import Documents from "./pages/Documents.js";
import SearchTest from "./pages/SearchTest.js";
import AskTest from "./pages/AskTest.js";

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
          <Route path="*" element={<Upload />} />
        </Routes>
      </main>
    </div>
  );
}