import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { adminLogin } from "../lib/api.js";

/**
 * 从 adminLogin 抛出的 Error message 中抽取 retry_after（秒）。
 * adminLogin 失败时 message 格式：`/auth/admin-login 429: {"error":"RATE_LIMITED","retry_after":723,"message":"..."}`
 * JSON 解析失败 → null（让外层显示原始错误，不卡住 UI）。
 */
function parseRetryAfter(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = err.message.match(/\{.*\}/);
  if (!match) return null;
  try {
    const body = JSON.parse(match[0]) as { retry_after?: number };
    return typeof body.retry_after === "number" && body.retry_after > 0
      ? body.retry_after
      : null;
  } catch {
    return null;
  }
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [adminToken, setAdminToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // M6.3a: rate limit 锁定倒计时（unix ms；null 表示未锁定）
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [countdown, setCountdown] = useState(0);

  // 锁定倒计时 effect：lockedUntil > 0 时每秒 -1，归零时清状态
  useEffect(() => {
    if (lockedUntil == null) return;
    const remaining = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
    setCountdown(remaining);
    if (remaining <= 0) {
      setLockedUntil(null);
      return;
    }
    const id = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(id);
          setLockedUntil(null);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (countdown > 0) return; // M6.3a: 锁定中不提交
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
      // M6.3a: 429 RATE_LIMITED → 设锁定
      const is429 =
        err instanceof Error &&
        (err.message.includes("RATE_LIMITED") || err.message.includes("429"));
      const retryAfter = is429 ? parseRetryAfter(err) : null;
      if (is429 && retryAfter != null) {
        setLockedUntil(Date.now() + retryAfter * 1000);
      }
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  const isLocked = countdown > 0;

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
          disabled={submitting || isLocked}
          autoFocus
        />
        <button
          type="submit"
          disabled={submitting || isLocked}
          className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "登录中…" : isLocked ? `${countdown}s 后可重试` : "登录"}
        </button>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        {isLocked && (
          <p className="mt-3 text-sm text-orange-600">
            登录失败次数过多，{countdown}s 后可重试
          </p>
        )}
        <p className="mt-3 text-xs text-gray-500">
          dev 环境默认 token = &quot;test-token-please-change&quot;
        </p>
      </form>
    </section>
  );
}