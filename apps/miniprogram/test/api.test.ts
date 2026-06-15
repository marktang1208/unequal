import { describe, it, expect } from "vitest";
import { ask } from "../lib/api.js";
import type { AskResponse } from "../lib/types.js";

describe("ask()", () => {
  const happy: AskResponse = {
    answer: "5个月宝宝发烧 38.5 [来源 1] [来源 3]\n\n以上信息...不构成医疗建议。",
    disclaimer: "以上信息...不构成医疗建议。具体情况请咨询专业儿科医生。",
    citations: [
      { n: 1, title: "美国儿科学会育儿百科", snippet: "三个月以下...", url: "raw/.../aap.pdf", trustLevel: 3, sourceId: "01H...", chunkId: "01H..." },
      { n: 3, title: "崔玉涛", snippet: "婴儿发烧...", url: "raw/.../cui.html", trustLevel: 2, sourceId: "01H...", chunkId: "01H..." },
    ],
    cached: false,
  };

  it("happy: 200 + JSON → 返回 AskResponse", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      expect(input).toBe("http://localhost:8787/ask");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ q: "test" });
      return new Response(JSON.stringify(happy), { status: 200, headers: { "content-type": "application/json" } });
    };

    const res = await ask("test", { fetchImpl: fetchMock });
    expect(res.citations.length).toBe(2);
    expect(res.citations[0]?.n).toBe(1);
    expect(res.cached).toBe(false);
  });

  it("带 token: Authorization header 设置正确", async () => {
    let capturedAuth: string | null = null;
    const fetchMock: typeof fetch = async (input, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
      return new Response(JSON.stringify(happy), { status: 200 });
    };

    await ask("test", { token: "abc123", fetchImpl: fetchMock });
    expect(capturedAuth).toBe("Bearer abc123");
  });

  it("400: 抛 Error 含状态码 + error 字段", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "Missing or empty 'q' field" }), { status: 400 });

    await expect(ask("", { fetchImpl: fetchMock })).rejects.toThrow(/400.*Missing or empty/);
  });

  it("500: 抛 Error 含 'internal' 字段", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "internal", detail: "boom" }), { status: 500 });

    await expect(ask("test", { fetchImpl: fetchMock })).rejects.toThrow(/500.*internal/);
  });
});
