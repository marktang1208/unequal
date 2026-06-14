import { ulid } from "ulid";

export interface ChunkOptions {
  maxTokens: number;       // 每块最大 token 数（粗略按字符数估算：中文 1 字 ≈ 1.5 token）
  overlapTokens: number;   // 块间重叠 token 数
}

export interface ChunkResult {
  id: string;
  idx: number;
  content: string;
  tokenCount: number;
}

// 粗略的 token 估算：英文按空格分词 ×1.3，中文按字符 ×1
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[一-龥]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars * 1 + otherChars * 0.3);
}

// 按段落 + 句末标点切分
function splitBySentences(text: string): string[] {
  // 按换行或句末标点切，保留分隔符
  const parts = text.split(/(?<=[。！？!?\n])/g);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

export function chunkText(text: string, opts: ChunkOptions): ChunkResult[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences = splitBySentences(trimmed);
  if (sentences.length === 0) return [];

  const maxChars = Math.floor(opts.maxTokens * 1.5);  // token → 字符 粗略换算
  const overlapChars = Math.floor(opts.overlapTokens * 1.5);

  const chunks: ChunkResult[] = [];
  let current = "";
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);
    const wouldExceed = currentTokens + sentenceTokens > opts.maxTokens;

    if (wouldExceed && current.length > 0) {
      // 收尾当前 chunk
      chunks.push({
        id: ulid(),
        idx: chunks.length,
        content: current.trim(),
        tokenCount: estimateTokens(current),
      });
      // 算 overlap：从 current 末尾往前截 overlapChars
      if (overlapChars > 0 && current.length > overlapChars) {
        current = current.slice(-overlapChars);
        currentTokens = estimateTokens(current);
      } else {
        current = "";
        currentTokens = 0;
      }
    }

    current += sentence;
    currentTokens += sentenceTokens;

    // 单句本身就超长时强制切
    if (current.length > maxChars) {
      chunks.push({
        id: ulid(),
        idx: chunks.length,
        content: current.trim(),
        tokenCount: estimateTokens(current),
      });
      current = "";
      currentTokens = 0;
    }
  }

  if (current.trim().length > 0) {
    chunks.push({
      id: ulid(),
      idx: chunks.length,
      content: current.trim(),
      tokenCount: estimateTokens(current),
    });
  }

  return chunks;
}
