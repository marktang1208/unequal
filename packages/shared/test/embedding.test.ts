import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMiniMaxEmbedder } from "../src/embedding.js";

describe("MiniMaxEmbedder", () => {
  const fakeFetch = vi.fn();

  beforeEach(() => {
    fakeFetch.mockReset();
  });

  it("calls MiniMax /embeddings with batched input", async () => {
    fakeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { embedding: [0.1, 0.2, 0.3] },
            { embedding: [0.4, 0.5, 0.6] },
          ],
          usage: { total_tokens: 10 },
        }),
        { headers: { "content-type": "application/json" } }
      )
    );

    const embed = createMiniMaxEmbedder({
      apiKey: "sk-test",
      baseUrl: "https://api.MiniMax.test/v1",
      model: "MiniMax-embedding",
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
      model: "MiniMax-embedding",
      input: ["hello", "world"],
    });
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
      model: "MiniMax-embedding",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    await expect(embed.embed(["x"])).rejects.toThrow(/401/);
  });

  it("returns empty array for empty input", async () => {
    const embed = createMiniMaxEmbedder({
      apiKey: "sk-test",
      baseUrl: "https://api.MiniMax.test/v1",
      model: "MiniMax-embedding",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    expect(await embed.embed([])).toEqual([]);
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});