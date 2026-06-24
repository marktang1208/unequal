// scripts/test-nli-prompt.mjs — 测改 prompt 后 Qwen 是否能返 3 score
import { readFileSync } from "node:fs";

const apiKey = process.env.SILICONFLOW_API_KEY;
if (!apiKey) {
  console.error("❌ SILICONFLOW_API_KEY not set");
  process.exit(1);
}

const NEW_PROMPT = `你是自然语言推理 (NLI) 专家。任务：判断 hypothesis 是否被 premise 蕴含/中性/矛盾。

请严格按以下 JSON object 格式返回(仅含此 object,无其他文字):
{"entailment": 0.85, "neutral": 0.10, "contradiction": 0.05}

三个分数和必须为 1.0(允许 ±0.01 浮点误差)。
- entailment: premise 所有事实细节都被 hypothesis 支持 → 接近 1
- neutral: premise 含 hypothesis 未提及的细节(可能是常识幻觉) → 接近 1
- contradiction: premise 与 hypothesis 冲突 → 接近 1

示例:
premise: "发烧 38.5 吃 0.4ml/kg 美林"
hypothesis: "美林剂量标准 0.4ml/kg"
→ {"entailment": 0.95, "neutral": 0.03, "contradiction": 0.02}`;

const CASES = [
  {
    name: "完全蕴含",
    premise: "5个月宝宝发烧38.5要观察精神状态，多喝水，超过39度就医",
    hypothesis: "5个月宝宝发烧38.5度时，需要观察宝宝的精神状态，并确保宝宝多喝水。",
  },
  {
    name: "桥接(超知识库)",
    premise: "5个月宝宝发烧38.5要观察精神状态，多喝水，超过39度就医",
    hypothesis: "5个月宝宝发烧38.5度时，需要观察宝宝的精神状态，并确保宝宝多喝水。另外可以用温水擦拭物理降温。",
  },
  {
    name: "无关",
    premise: "5个月宝宝发烧38.5要观察精神状态，多喝水，超过39度就医",
    hypothesis: "X 星人住在仙女座星系。",
  },
  {
    name: "矛盾",
    premise: "5个月宝宝发烧38.5要观察精神状态，多喝水，超过39度就医",
    hypothesis: "5个月宝宝发烧38.5度是正常生理反应,不需要处理。",
  },
];

async function callNli(premise, hypothesis) {
  const userPrompt = `Premise(待验证陈述):\n${premise}\n\nHypothesis(证据):\n${hypothesis}`;
  const start = Date.now();
  const res = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "Qwen/Qwen2.5-7B-Instruct",
      messages: [
        { role: "system", content: NEW_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });
  const elapsed = Date.now() - start;
  if (!res.ok) {
    return { error: `HTTP ${res.status}: ${await res.text()}`, elapsed };
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? "";
  const finish = json.choices?.[0]?.finish_reason ?? "";
  return { content, finish, elapsed, usage: json.usage };
}

for (const c of CASES) {
  console.log(`\n=== ${c.name} ===`);
  const r = await callNli(c.premise, c.hypothesis);
  if (r.error) {
    console.log(`❌ ${r.error} (${r.elapsed}ms)`);
    continue;
  }
  console.log(`elapsed: ${r.elapsed}ms, finish: ${r.finish}`);
  console.log(`content: ${r.content}`);
  try {
    const parsed = JSON.parse(r.content);
    const hasAll =
      "entailment" in parsed && "neutral" in parsed && "contradiction" in parsed;
    if (hasAll) {
      const sum =
        parsed.entailment + parsed.neutral + parsed.contradiction;
      const max = Math.max(
        parsed.entailment,
        parsed.neutral,
        parsed.contradiction,
      );
      const verdict =
        max === parsed.entailment
          ? "entailed"
          : max === parsed.neutral
            ? "neutral"
            : "contradiction";
      console.log(
        `✅ schema OK | sum=${sum.toFixed(3)} verdict=${verdict} score=${max.toFixed(3)}`,
      );
    } else {
      console.log(`❌ schema 不全: keys=${Object.keys(parsed)}`);
    }
  } catch (e) {
    console.log(`❌ JSON parse err: ${e.message}`);
  }
}
