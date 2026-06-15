export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

export function verifyAdminToken(header: string | null | undefined, expected: string): AuthResult {
  if (!header) {
    return { ok: false, status: 401, message: "Missing Authorization header" };
  }
  if (header !== `Bearer ${expected}`) {
    return { ok: false, status: 401, message: "Invalid token" };
  }
  return { ok: true };
}
