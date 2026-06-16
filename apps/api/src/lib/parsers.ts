/**
 * CP-6: 文件解析 helpers
 *
 * 支持 PDF / Word / TXT / Markdown，按文件扩展名自动选择。
 * 全部 async（pdf-parse / mammoth 内部 callback 包成 promise）。
 *
 * 限制（spec §6.7）：
 * - HTTP trigger body 4MB 上限（Phase 4 不支持更大）
 * - PDF / Word 解析失败 → 抛错，handler 层 catch 后返 400
 */

import mammoth from "mammoth";
import { createRequire } from "node:module";

// pdf-parse 是 CommonJS，用 require 包一层
const require = createRequire(import.meta.url);
const pdfParse: (buf: Buffer) => Promise<{ text: string }> = require("pdf-parse");

export type SupportedExt = "pdf" | "docx" | "txt" | "md";

export function detectExt(filename: string): SupportedExt | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".md")) return "md";
  return null;
}

export async function parsePdf(buf: Buffer): Promise<string> {
  const result = await pdfParse(buf);
  return result.text;
}

export async function parseDocx(buf: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value;
}

export function parseText(buf: Buffer): string {
  return buf.toString("utf-8");
}

export async function parseAuto(filename: string, buf: Buffer): Promise<string> {
  const ext = detectExt(filename);
  if (!ext) throw new Error(`Unsupported file extension: ${filename}`);
  switch (ext) {
    case "pdf":
      return parsePdf(buf);
    case "docx":
      return parseDocx(buf);
    case "txt":
    case "md":
      return parseText(buf);
  }
}