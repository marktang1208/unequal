import mammoth from "mammoth";
import { Buffer } from "node:buffer";

export async function parseWord(bytes: ArrayBuffer): Promise<string> {
  const buffer = Buffer.from(bytes);
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}
