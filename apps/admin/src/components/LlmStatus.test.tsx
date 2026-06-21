/**
 * LlmStatus 单元测试（T12）
 *
 * mock fetch 返不同状态 → 验 chip 颜色 / 文本
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { LlmStatus } from "./LlmStatus.js";

function mockFetchReturn(data: unknown, status = 200): void {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("LlmStatus (CP-7-C T12)", () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  it("OMLX 在线 + 0 失败 → 两个绿 chip '本地 ✓'", async () => {
    mockFetchReturn({
      omlx: { available: true, url: "http://localhost:11434/v1", models: ["bge-m3"] },
      fallback: {
        embed: { consecutiveFailures: 0, totalFailures: 0, disabled: false },
        llm: { consecutiveFailures: 0, totalFailures: 0, disabled: false },
      },
    });
    render(<LlmStatus />);
    await waitFor(() => {
      expect(screen.getByTestId("chip-llm").textContent).toMatch(/LLM: 本地/);
      expect(screen.getByTestId("chip-embed").textContent).toMatch(/Embed: 本地/);
    });
  });

  it("OMLX 离线 → 两个灰 chip '离线'", async () => {
    mockFetchReturn({
      omlx: { available: false, url: "http://localhost:11434/v1", models: [], error: "ECONNREFUSED" },
      fallback: {
        embed: { consecutiveFailures: 0, totalFailures: 0, disabled: false },
        llm: { consecutiveFailures: 0, totalFailures: 0, disabled: false },
      },
    });
    render(<LlmStatus />);
    await waitFor(() => {
      expect(screen.getByTestId("chip-llm").textContent).toMatch(/LLM: 离线/);
    });
  });

  it("embed 连续 3 次失败 → embed 红 chip 'Fallback 云端'", async () => {
    mockFetchReturn({
      omlx: { available: true, url: "http://localhost:11434/v1", models: ["bge-m3"] },
      fallback: {
        embed: { consecutiveFailures: 3, totalFailures: 5, disabled: false },
        llm: { consecutiveFailures: 0, totalFailures: 0, disabled: false },
      },
    });
    render(<LlmStatus />);
    await waitFor(() => {
      expect(screen.getByTestId("chip-embed").textContent).toMatch(/Embed: Fallback 云端/);
    });
  });

  it("embed 累计 5 次 + disabled → embed 黄 chip '已禁用'", async () => {
    mockFetchReturn({
      omlx: { available: true, url: "http://localhost:11434/v1", models: ["bge-m3"] },
      fallback: {
        embed: { consecutiveFailures: 0, totalFailures: 7, disabled: true },
        llm: { consecutiveFailures: 0, totalFailures: 0, disabled: false },
      },
    });
    render(<LlmStatus />);
    await waitFor(() => {
      expect(screen.getByTestId("chip-embed").textContent).toMatch(/Embed: 已禁用/);
    });
  });

  it("fetch 失败 → 显示 'LLM 状态查询失败'", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network"));
    render(<LlmStatus />);
    await waitFor(() => {
      expect(screen.getByText(/LLM 状态查询失败/)).toBeDefined();
    });
  });

  it("OMLX 在线 + 有 models → 显示模型名", async () => {
    mockFetchReturn({
      omlx: {
        available: true,
        url: "http://localhost:11434/v1",
        models: ["bge-m3", "Qwen3.6-35B-A3B-4bit", "foo"],
      },
      fallback: {
        embed: { consecutiveFailures: 0, totalFailures: 0, disabled: false },
        llm: { consecutiveFailures: 0, totalFailures: 0, disabled: false },
      },
    });
    render(<LlmStatus />);
    await waitFor(() => {
      expect(screen.getByText(/模型: bge-m3/)).toBeDefined();
    });
  });
});