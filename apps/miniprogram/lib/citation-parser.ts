/**
 * apps/miniprogram/lib/citation-parser.ts — CP-7-B 新增
 *
 * 共享 helper：解析 LLM 答案中的 `[N]` 内联引用标记。
 * 行为与后端 api-chat.ts `parseAnswerSegments` 对称（前端后端一致）。
 *
 * 输出：
 * - citedNums: 去重保 first 顺序的数字数组
 * - segments: 富文本渲染用的片段数组（chat.ts 传给 message-bubble）
 *
 * YAGNI：不做 HTML 转义；不做 XSS sanitization（LLM 输出 trusted）
 */

export type Segment =
  | { type: "text"; text: string }
  | { type: "cite"; n: number };

/**
 * 解析 answer → segments 数组。
 * 规则：
 * - 按 `[N]` 切分，奇数段为 text，偶数段为 cite
 * - 多个 [N] 紧邻时不合并空格（text 段保留原空格）
 *
 * 例：
 *   "宝宝发烧 [1] 可能 [2] [3] 严重" →
 *   [
 *     { type: "text", text: "宝宝发烧 " },
 *     { type: "cite", n: 1 },
 *     { type: "text", text: " 可能 " },
 *     { type: "cite", n: 2 },
 *     { type: "text", text: " " },
 *     { type: "cite", n: 3 },
 *     { type: "text", text: " 严重" },
 *   ]
 */
export function parseAnswerSegments(answer: string): Segment[] {
  if (!answer) return [];
  const re = /(\[\d+\])/g;
  const parts = answer.split(re);
  const segments: Segment[] = [];
  for (const part of parts) {
    if (!part) continue;
    const m = part.match(/^\[(\d+)\]$/);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (Number.isFinite(n) && n >= 1) {
        segments.push({ type: "cite", n });
      } else {
        // 非数字 [abc] → 当 text 渲染（不该出现但兜底）
        segments.push({ type: "text", text: part });
      }
    } else {
      segments.push({ type: "text", text: part });
    }
  }
  return segments;
}

/**
 * 提取 citedNums（去重保 first 顺序）。
 */
export function extractCitedNums(answer: string): number[] {
  const segments = parseAnswerSegments(answer);
  const seen = new Set<number>();
  const citedNums: number[] = [];
  for (const seg of segments) {
    if (seg.type === "cite" && !seen.has(seg.n)) {
      seen.add(seg.n);
      citedNums.push(seg.n);
    }
  }
  return citedNums;
}