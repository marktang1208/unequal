/**
 * UploadPage UI smoke test (T10)
 *
 * 测渲染基本结构 + file input change + 错误显示
 * 完整 upload 流程靠 server tests + 浏览器手测覆盖
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import Upload from "./Upload.js";

function makeFile(name: string, content: string): File {
  return new File([content], name, { type: "text/markdown" });
}

function setFiles(input: HTMLInputElement, files: File[]): void {
  // React 只看 input.files (DataTransfer 后的产物)；直接赋值 + fire change
  Object.defineProperty(input, "files", {
    value: files,
    writable: false,
    configurable: true,
  });
  fireEvent.change(input);
}

describe("Upload (CP-7-C T10)", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("初始渲染: 标题 + dropzone + file input", () => {
    render(<Upload />);
    expect(screen.getByText("本地上传文件")).toBeDefined();
    expect(screen.getByTestId("dropzone")).toBeDefined();
    expect(screen.getByTestId("file-input")).toBeDefined();
  });

  it("P3-7: 初始渲染含启动爬虫按钮 + 待推送列表 section", () => {
    render(<Upload />);
    expect(screen.getByTestId("crawler-start-toggle")).toBeDefined();
    expect(screen.getByText("待推送列表")).toBeDefined();
  });

  it("选 1 个文件: 显示文件列表 + 上传按钮", () => {
    render(<Upload />);
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    setFiles(input, [makeFile("a.md", "# hello")]);

    expect(screen.getByText(/a\.md/)).toBeDefined();
    const btn = screen.getByTestId("upload-btn");
    expect(btn.textContent).toMatch(/上传 1 个文件/);
  });

  it("选 3 个文件: 按钮显示 '上传 3 个文件'", () => {
    render(<Upload />);
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    setFiles(input, [
      makeFile("a.md", "1"),
      makeFile("b.md", "2"),
      makeFile("c.md", "3"),
    ]);
    const btn = screen.getByTestId("upload-btn");
    expect(btn.textContent).toMatch(/上传 3 个文件/);
  });

  it("点移除按钮: 文件从列表消失", () => {
    render(<Upload />);
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    setFiles(input, [makeFile("a.md", "1")]);
    expect(screen.getByText(/a\.md/)).toBeDefined();
    fireEvent.click(screen.getByText("移除"));
    expect(screen.queryByText(/a\.md/)).toBeNull();
  });
});