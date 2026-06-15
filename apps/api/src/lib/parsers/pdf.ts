// pdf-parse 是 CommonJS 库，在 ESM 项目里要这样导入
// @ts-expect-error - no types for default export
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { Buffer } from "node:buffer";

export async function parsePdf(bytes: ArrayBuffer): Promise<string> {
  const buffer = Buffer.from(bytes);
  const result = await pdfParse(buffer);
  return result.text;
}
