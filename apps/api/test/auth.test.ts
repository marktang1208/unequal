import { describe, it, expect } from "vitest";
import { verifyAdminToken } from "../src/lib/auth.js";

describe("verifyAdminToken", () => {
  it("returns ok when token matches", () => {
    expect(verifyAdminToken("Bearer secret", "secret")).toEqual({ ok: true });
  });

  it("returns error on missing header", () => {
    expect(verifyAdminToken(undefined, "secret")).toEqual({
      ok: false,
      status: 401,
      message: "Missing Authorization header",
    });
  });

  it("returns error on wrong token", () => {
    expect(verifyAdminToken("Bearer wrong", "secret")).toEqual({
      ok: false,
      status: 401,
      message: "Invalid token",
    });
  });

  it("returns error on non-Bearer scheme", () => {
    expect(verifyAdminToken("Basic secret", "secret")).toEqual({
      ok: false,
      status: 401,
      message: "Invalid token",
    });
  });
});
