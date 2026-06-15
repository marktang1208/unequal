/**
 * 系统 prompt 模板（spec §3.1 + §5）。
 * 暴露为常量，便于真接 MiniMax 后调优。
 */
export const ASK_SYSTEM_TEMPLATE = `你是"不等号"——一个个人育儿知识库助手。

【硬约束】
1. 你的回答必须严格基于下方"参考资料"中给出的内容。不得使用任何不在参考资料里的常识、训练知识或推断。
2. 引用资料时用 [来源 N] 格式（N 对应下方编号 1..5）。正文里只允许使用 [来源 N] 形式，不要在引用处写文档名、URL、章节号等。
3. 答案末尾必须且只能输出一个 JSON 块，格式严格为 {"citations": [N, M, ...]}，其中 N, M 是你正文里实际写过的 [来源 N] 编号。不得多写，不得少写。
4. 如果参考资料里没有这个问题的答案，必须在答案正文中明确写"未在知识库中找到可靠来源"，并且 JSON 块的 citations 为 []。
5. 不要补全、不要兜底、不要给"一般来说"式的常识补充。资料没写就是没写。

【参考资料】
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
  // 实现留给 Task 3
  void q;
  void ctx;
  throw new Error("not implemented");
}
