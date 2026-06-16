/**
 * 多轮对话 context 拼接工具（spec §4）。
 *
 * 把一串 ChatMessage[] 拼成喂给 RAG pipeline 的 prefix：取最近 N 轮（user + assistant），
 * 每轮 assistant 用 summary 字段（如果有），否则降级到 content 前 50 字。
 * 输出格式：
 *   [第 1 轮]
 *   用户: ...
 *   助手: ...
 *
 *   [第 2 轮]
 *   ...
 *
 * 拼接后喂 RAG：
 *   `${contextPrefix}\n\n[当前问题]\n${q}`  // contextPrefix 为空时直接用 q
 */

export const DEFAULT_WINDOW_SIZE = 3;
export const DEFAULT_SUMMARY_FALLBACK_CHARS = 50;

export interface MultiturnMessage {
  role: "user" | "assistant";
  content: string;
  summary?: string;
  created_at: number;
}

/**
 * 把 messages 切成 round（每 round = 一对 user + assistant；末尾的不完整 round 丢弃）。
 * 单 round 缺 user 或缺 assistant → 跳过该 round（不完整的 round 不进 prefix）。
 */
export function groupIntoRounds(messages: MultiturnMessage[]): MultiturnMessage[][] {
  const rounds: MultiturnMessage[][] = [];
  let current: MultiturnMessage[] = [];
  for (const m of messages) {
    current.push(m);
    if (m.role === "assistant") {
      // 当前 round 必须同时含 user + assistant 才算完成
      const hasUser = current.some((x) => x.role === "user");
      if (hasUser) {
        rounds.push(current);
      }
      current = [];
    }
  }
  return rounds;
}

/**
 * 收集「未配对 user」（最后一个 assistant 之后的所有 user）— 不形成 round 但仍
 * 进 prefix，标记 "（无答）"，让 LLM 知道这条历史没有回答。
 */
function trailingUsers(messages: MultiturnMessage[]): string[] {
  let lastAsstIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAsstIdx = i;
      break;
    }
  }
  const tail = lastAsstIdx >= 0 ? messages.slice(lastAsstIdx + 1) : messages;
  return tail.filter((m) => m.role === "user").map((m) => m.content);
}

/**
 * 拼 context prefix。windowSize 默认 3（spec §4.1）；传 0 时返空串。
 *
 * 末尾未配对 user（无 assistant 跟上的）也进 prefix，标记 "（无答）"，
 * 让 LLM 知道这是历史里未回答的问题，避免重复追问。
 */
export function buildMultiturnPrefix(
  messages: MultiturnMessage[],
  windowSize: number = DEFAULT_WINDOW_SIZE,
): string {
  if (windowSize <= 0) return "";
  const rounds = groupIntoRounds(messages).slice(-windowSize);
  const trailing = trailingUsers(messages);
  if (rounds.length === 0 && trailing.length === 0) return "";

  const parts: string[] = [];
  rounds.forEach((round, i) => {
    const user = round.find((m) => m.role === "user")?.content ?? "";
    const asst = round.find((m) => m.role === "assistant");
    const summary =
      asst?.summary ??
      (asst?.content ? asst.content.slice(0, DEFAULT_SUMMARY_FALLBACK_CHARS) : "");
    parts.push(`[第 ${i + 1} 轮]\n用户: ${user}\n助手: ${summary}`);
  });
  for (const u of trailing) {
    parts.push(`用户: ${u}（无答）`);
  }
  return parts.join("\n\n");
}
