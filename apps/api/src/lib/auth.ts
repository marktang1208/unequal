export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

/** 自定义错误类型 — M6.1+ /chat /sessions 路由用，区分鉴权失败和业务错误 */
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function verifyAdminToken(header: string | null | undefined, expected: string): AuthResult {
  if (!header) {
    return { ok: false, status: 401, message: "Missing Authorization header" };
  }
  if (header !== `Bearer ${expected}`) {
    return { ok: false, status: 401, message: "Invalid token" };
  }
  return { ok: true };
}

/** 鉴权后的用户身份（M6.1 只有 admin，M6.2 会有家长） */
export interface AuthIdentity {
  userId: string;
  isAdmin: boolean;
}

/**
 * M6.1 鉴权统一入口（spec §7.1）。
 *
 * - `admin_token` 模式：复用 M2 verifyAdminToken（userId = DEFAULT_ADMIN_USER_ID 常量，isAdmin = true）
 * - `jwt` 模式：M6.2 实现；M6.1 阶段抛 501 NOT_IMPLEMENTED
 * - 其他 mode：抛 400 BAD_AUTH_MODE
 *
 * 为什么用 throw HttpError：M6.1 路由层统一用 try/catch 包，调 verifyAuth 失败直接映射到 status/code。
 * M6.2 切换 jwt 模式时只动这一个函数，路由不动。
 */
export async function verifyAuth(req: Request, env: EnvLike): Promise<AuthIdentity> {
  const mode = env.AUTH_MODE || "admin_token";
  if (mode === "admin_token") {
    const header = req.headers.get("Authorization");
    const result = verifyAdminToken(header, env.ADMIN_TOKEN);
    if (!result.ok) {
      // 统一抛 401，前端显示的错误码
      throw new HttpError(401, "UNAUTHORIZED", result.message);
    }
    return { userId: DEFAULT_ADMIN_USER_ID, isAdmin: true };
  }
  if (mode === "jwt") {
    throw new HttpError(501, "NOT_IMPLEMENTED", "JWT auth available in M6.2");
  }
  throw new HttpError(400, "BAD_AUTH_MODE", `Unsupported AUTH_MODE: ${mode}`);
}

/** 最小 env 形状（避免循环 import 整个 types.ts） */
export interface EnvLike {
  AUTH_MODE?: string;
  ADMIN_TOKEN: string;
}

/** M6.1 阶段 admin token 模式下的固定 userId —— 与 upload.ts / search.ts DEFAULT_USER_ID 对齐 */
export const DEFAULT_ADMIN_USER_ID = "01H0000000000000000000000";
