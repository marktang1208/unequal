/**
 * cross-turn-hypothesis.ts — 跨轮 NLI hypothesis 构造 (P5 v1.4)
 *
 * 背景 (P5 v1.3 限制):
 *   - chat 多轮场景: 用户先问 "0-3 岁宝宝睡眠需求", 后问 "那 1 岁呢?"
 *   - 第 2 轮 LLM answer 可能引用前轮 chunks (A, B)
 *   - 但 v1.3 NLI 只 verify 当前轮 retrieve 的 chunks (D, E, F)
 *   - → hypothesis 跟 answer 不 match → NLI 误判 neutral/contradiction
 *
 * v1.4 解法:
 *   - ChatMessage.retrievedChunkIds (schema 加 optional 字段)
 *   - 写 chat 时把当前轮 retrieve 的 top-K chunkIds 写进 assistant message
 *   - 读 chat 时: union 当前轮 top chunks + session 历史所有 messages 的 retrievedChunkIds (去重)
 *   - cap: 最多 +5 历史 chunks (防止 hypothesis 过大)
 *
 * 函数:
 *   - getCrossTurnHypothesis({ currentChunkIds, sessionMessages, findChunkById, options })
 *     → 返回 { chunkIds: string[], hypothesis: string, currentCount, historicalCount, cappedAt }
 *   - 纯函数, 不依赖 db, 易测
 */

import type { ChatMessage } from "@unequal/shared/types";

export interface CrossTurnHypothesisOptions {
  /** 当前轮 retrieve 的 top chunk IDs (顺序敏感, top-5) */
  currentChunkIds: string[];
  /** session 所有历史 messages (assistant messages 含 retrievedChunkIds) */
  sessionMessages: ChatMessage[];
  /** 按 ID 查 chunk content (handler 提供, 避免 helper 依赖 db) */
  findChunkById: (chunkId: string) => string | null;
  /** 历史 chunks 上限, 默认 5 (防止 hypothesis 过大) */
  maxHistoricalChunks?: number;
}

export interface CrossTurnHypothesisResult {
  /** 跨轮 union + 去重后的 chunk IDs (顺序: current 优先, 然后 historical) */
  chunkIds: string[];
  /** hypothesis 文本 (chunk contents 用 "\n\n" join) */
  hypothesis: string;
  /** 当前轮 chunks 数 */
  currentCount: number;
  /** 跨轮 chunks 数 (含当前) */
  historicalCount: number;
  /** 实际取的历史 chunks 数 (cap 后) */
  cappedHistoricalCount: number;
  /** 是否触发了 cap (历史 chunks 超 maxHistoricalChunks) */
  cappedAt: boolean;
}

const DEFAULT_MAX_HISTORICAL_CHUNKS = 5;

export function getCrossTurnHypothesis(
  opts: CrossTurnHypothesisOptions,
): CrossTurnHypothesisResult {
  const maxHistorical = opts.maxHistoricalChunks ?? DEFAULT_MAX_HISTORICAL_CHUNKS;

  // 1. 收集历史 messages 所有 retrievedChunkIds (去重)
  const historicalIds = new Set<string>();
  for (const msg of opts.sessionMessages) {
    if (msg.role !== "assistant") continue;
    // v1.4 schema: msg.retrievedChunkIds optional; 旧 session 无此字段 → 跳过
    const ids = msg.retrievedChunkIds ?? [];
    for (const cid of ids) {
      historicalIds.add(cid);
    }
  }

  // 2. 排除当前轮 chunk ids (避免重复算入)
  const currentIdSet = new Set(opts.currentChunkIds);
  const filteredHistoricalIds: string[] = [];
  for (const cid of historicalIds) {
    if (!currentIdSet.has(cid)) {
      filteredHistoricalIds.push(cid);
    }
  }

  // 3. cap
  const cappedHistorical = filteredHistoricalIds.slice(0, maxHistorical);
  const cappedAt = filteredHistoricalIds.length > maxHistorical;

  // 4. 合并: 当前优先 (按 currentChunkIds 顺序), 然后历史 (按 filtered order)
  const mergedIds = [...opts.currentChunkIds, ...cappedHistorical];

  // 5. 拉 content 构造 hypothesis
  const contents: string[] = [];
  for (const cid of mergedIds) {
    const content = opts.findChunkById(cid);
    if (content && content.length > 0) {
      contents.push(content);
    }
  }

  return {
    chunkIds: mergedIds,
    hypothesis: contents.join("\n\n"),
    currentCount: opts.currentChunkIds.length,
    historicalCount: mergedIds.length,
    cappedHistoricalCount: cappedHistorical.length,
    cappedAt,
  };
}