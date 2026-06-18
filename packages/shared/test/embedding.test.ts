import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMiniMaxEmbedder } from "../src/embedding.js";

describe("MiniMaxEmbedder", () => {
  const fakeFetch = vi.fn();

  beforeEach(() => {
    fakeFetch.mockReset();
  });

  it("calls MiniMax /embeddings with batched input (MiniMax protocol: texts+type+vectors)", async () => {
    fakeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          vectors: [
            [0.1, 0.2, 0.3],
            [0.4, 0.5, 0.6],
          ],
          base_resp: { status_code: 0, status_msg: "success" },
        }),
        { headers: { "content-type": "application/json" } }
      )
    );

    const embed = createMiniMaxEmbedder({
      apiKey: "sk-test",
      baseUrl: "https://api.MiniMax.test/v1",
      model: "embo-01",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    const result = await embed.embed(["hello", "world"]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([0.1, 0.2, 0.3]);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe("https://api.MiniMax.test/v1/embeddings");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "embo-01",
      texts: ["hello", "world"],
      type: "db",
    });
  });

  it("sends type=query when configured", async () => {
    fakeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ vectors: [[0.1]], base_resp: { status_code: 0, status_msg: "success" } }),
        { headers: { "content-type": "application/json" } }
      )
    );

    const embed = createMiniMaxEmbedder({
      apiKey: "sk-test",
      baseUrl: "https://api.MiniMax.test/v1",
      model: "embo-01",
      type: "query",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    await embed.embed(["x"]);

    const body = JSON.parse(fakeFetch.mock.calls[0]![1]!.body as string);
    expect(body.type).toBe("query");
  });

  it("throws on API error with status", async () => {
    // 401 is a permanent auth error; server returns it on every retry.
    // Use mockImplementation to return a fresh Response each call (a single
    // Response body can only be read once; reusing it would mask the real
    // 401 error on retry attempts 2 and 3).
    fakeFetch.mockImplementation(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
        )
    );

    const embed = createMiniMaxEmbedder({
      apiKey: "sk-bad",
      baseUrl: "https://api.MiniMax.test/v1",
      model: "embo-01",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    await expect(embed.embed(["x"])).rejects.toThrow(/401/);
  });

  it("throws when vectors count mismatches input count", async () => {
    // mockImplementation (not Once/ResolvedValue): each retry needs a fresh Response,
    // since a Response body can only be read once.
    fakeFetch.mockImplementation(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ vectors: [[0.1]], base_resp: { status_code: 0, status_msg: "ok" } }),
            { headers: { "content-type": "application/json" } }
          )
        )
    );

    const embed = createMiniMaxEmbedder({
      apiKey: "sk-test",
      baseUrl: "https://api.MiniMax.test/v1",
      model: "embo-01",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    // 2 inputs but only 1 vector returned
    await expect(embed.embed(["a", "b"])).rejects.toThrow(/returned 1 vectors for 2 inputs/);
  });

  it("returns empty array for empty input", async () => {
    const embed = createMiniMaxEmbedder({
      apiKey: "sk-test",
      baseUrl: "https://api.MiniMax.test/v1",
      model: "embo-01",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    expect(await embed.embed([])).toEqual([]);
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});