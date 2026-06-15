/**
 * MiniMax chat completion 的 4 种 canned response，覆盖 spec §4.2 的 4 种输出形态。
 * 集成测试通过 globalThis.fetch mock 注入，参见 apps/api/test/ask.test.ts。
 */

export const LLM_FIXTURES = {
  /** happy: 文本引 1,3 + JSON 引 1,3 → 验证通过 */
  happy: {
    content:
      '5个月宝宝腋温 38.5°C 建议先 [来源 1] [来源 3]\n\n{"citations":[1,3]}',
  },
  /** no_citation: 文本无 [来源 N] + JSON [] → 降级 */
  no_citation: {
    content: "5个月宝宝发烧应该多喝水，注意休息。\n\n{\"citations\":[]}",
  },
  /** cite_mismatch: 文本引 1 但 JSON 引 2 → 降级 */
  cite_mismatch: {
    content: "5个月宝宝发烧 [来源 1] ...\n\n{\"citations\":[2]}",
  },
  /** malformed_json: 有 citations 关键字但 JSON 坏 → 降级 + malformed=true */
  malformed_json: {
    content: "5个月宝宝发烧 [来源 1] ...\n\n{\"citations\": not valid json}",
  },
} as const;

export type FixtureName = keyof typeof LLM_FIXTURES;

/** 模拟 OpenAI 兼容的 chat completion response 包装 */
export function fixtureResponse(name: FixtureName): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: LLM_FIXTURES[name].content,
          },
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
}
