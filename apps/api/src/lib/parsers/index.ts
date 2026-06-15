import { parseText } from "./text.js";
import { parsePdf } from "./pdf.js";
import { parseWord } from "./word.js";

export type FileType = "pdf" | "docx" | "txt" | "md";

export function detectFileType(filename: string): FileType | null {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "txt") return "txt";
  if (ext === "md" || ext === "markdown") return "md";
  return null;
}

export async function parseFile(type: FileType, bytes: ArrayBuffer): Promise<string> {
  switch (type) {
    case "pdf":
      return parsePdf(bytes);
    case "docx":
      return parseWord(bytes);
    case "txt":
    case "md":
      return parseText(bytes);
  }
}
