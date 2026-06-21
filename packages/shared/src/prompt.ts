/**
 * 系统 prompt 模板（spec §3.1 + §5）。
 * 暴露为常量，便于真接 MiniMax 后调优。
 *
 * CP-7-D #2-a: 统一用 [N] 内联引用（对齐 api-chat）。
 * 删"末尾输出 JSON 块"约束（api-chat 已用 [N] 解析）。
 */
export const ASK_SYSTEM_TEMPLATE = `你是"不等号"——一个个人育儿知识库助手。

# 回答规则
1. **仅基于下方参考资料**回答，不要兜底常识。
2. **引用格式**：在引用某条资料时，紧跟句尾标注 \`[1]\` \`[2]\` \`[3]\` \`[4]\` \`[5]\`（具体数字对应资料编号），**不要写字面的 [N]**。
   - 正确示例："新生儿每日睡眠 14-17 小时[1]，可以尝试规律作息[2]。"
   - 错误示例："新生儿每日睡眠 14-17 小时[N]。"  ← 禁止
3. 如果资料里没有相关信息，直接说"参考资料中未涉及此问题"，不要编造。

# 参考资料
{{CHUNKS}}`;

/**
 * 信源等级中文标签（spec §3.3）
 */
export const TRUST_LABELS: Record<0 | 1 | 2 | 3, string> = {
  0: "未评级",
  1: "一般",
  2: "可信",
  3: "权威",
};

export const DISCLAIMER_TEXT =
  "以上信息来源于知识库内容，不构成医疗建议。具体情况请咨询专业儿科医生。";

/**
 * 一次 ask 编排的输入（来自 retrieval 步骤 §5.2 ⑤）
 */
export interface AskContext {
  /** 1..5 编号对应的 chunk 全文 + 元数据 */
  chunks: AskContextChunk[];
}

export interface AskContextChunk {
  n: 1 | 2 | 3 | 4 | 5;
  title: string;
  snippet: string;
  trustLevel: 0 | 1 | 2 | 3;
}

export interface AskPrompt {
  system: string;
  user: string;
}

export function buildAskPrompt(q: string, ctx: AskContext): AskPrompt {
  const chunkLines = ctx.chunks
    .sort((a, b) => a.n - b.n)
    .map(
      (c) =>
        `[${c.n}] 《${c.title}》/ "${c.snippet}" (信源等级: ${TRUST_LABELS[c.trustLevel]})`,
    )
    .join("\n");

  const system = ASK_SYSTEM_TEMPLATE.replace("{{CHUNKS}}", chunkLines);
  return { system, user: q };
}
