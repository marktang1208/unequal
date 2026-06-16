/**
 * M6.9 in-process token-level mutex（spec §5）。
 *
 * 模式：Map<identifier, Promise> 串行化同 identifier 的代码块
 * （与 M6.4 inflightEnsureJwt 同模式）。
 *
 * 失败：fn throw 不影响 mutex 释放（finally 清理）。
 *
 * 限制：CF Workers 单 isolate 内有效（多 isolate 间不防 — YAGNI）。
 *
 * 用途：包裹 /auth/admin-login + /auth/wx-login 的 recordAttempt 调用，
 * 防御性解决同 token 5 并发 admin-login 小窗口。
 */

const inflight = new Map<string, Promise<unknown>>();

export async function withTokenMutex<T>(
  identifier: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = inflight.get(identifier);
  let resolveNext: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    resolveNext = resolve;
  });
  // 链：prev → next（避免 N 个 await 串成 N 层）
  const chained = prev ? prev.then(() => next) : next;
  inflight.set(identifier, chained);
  try {
    if (prev) await prev;
    return await fn();
  } finally {
    resolveNext();  // 释放下一个等待者
    if (inflight.get(identifier) === chained) {
      inflight.delete(identifier);
    }
  }
}
