import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { adminLogin } from "../lib/api.js";

export default function LoginPage() {
  const navigate = useNavigate();
  const [adminToken, setAdminToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const trimmed = adminToken.trim();
    if (!trimmed) {
      setError("请输入 admin_token");
      return;
    }
    setSubmitting(true);
    try {
      const { token } = await adminLogin(trimmed);
      localStorage.setItem("admin_token", token);
      // 登录成功 → 跳到 M6.1 ChatSim（受 RequireAuth 保护）
      navigate("/chat-sim");
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex min-h-screen items-center justify-center bg-gray-50">
      <form
        onSubmit={onSubmit}
        className="w-96 rounded border border-gray-200 bg-white p-6 shadow-sm"
      >
        <h1 className="mb-4 text-xl font-semibold">Unequal Admin 登录</h1>
        <label className="mb-2 block text-sm font-medium text-gray-700">
          Admin Token
        </label>
        <input
          type="password"
          value={adminToken}
          onChange={(e) => setAdminToken(e.target.value)}
          placeholder="从 .dev.vars 或生产 secret 拿"
          className="mb-4 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          disabled={submitting}
          autoFocus
        />
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "登录中…" : "登录"}
        </button>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <p className="mt-3 text-xs text-gray-500">
          dev 环境默认 token = &quot;test-token-please-change&quot;
        </p>
      </form>
    </section>
  );
}
