/**
 * CP-6: 文件解析 helpers
 *
 * 支持 PDF / Word / TXT / Markdown，按文件扩展名自动选择。
 *
 * pdf-parse 1.1.1 默认入口（`pdf-parse`）会触发 debug 模式读 `./test/data/05-versions-space.pdf`
 * 在 ESM + 不在仓库根目录运行时直接 ENOENT 报错。我们用深路径 `pdf-parse/lib/pdf-parse.js`
 * 跳过默认入口的副作用（实际逻辑相同）。
 *
 * pdf-parse / mammoth 都是 CJS；用 esbuild 静态 import 即可，bundle 时会 inline。
 * 不用 createRequire 动态 require —— 那样 esbuild 不会 bundle，runtime
 * resolve 时 CloudBase 上找不到模块（npm install 后路径不同）。
 */

// @ts-expect-error - pdf-parse 无 types
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";

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
