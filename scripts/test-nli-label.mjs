// scripts/test-nli-label.mjs — 测 Qwen 真实 label 分布
import { readFileSync } from "node:fs";

const apiKey = process.env.SILICONFLOW_API_KEY;
if (!apiKey) {
  console.error("❌ SILICONFLOW_API_KEY not set");
  process.exit(1);
}

// 用最简 label+score 格式 prompt(对齐 Qwen 真实倾向)
const LABEL_PROMPT = `判断 hypothesis 是否被 premise 蕴含。返回 strict JSON:
{"label":"entailment|neutral|contradiction","score":0-1}

entailment: premise 所有事实细节都被 hypothesis 支持
neutral: hypothesis 加了 premise 没说的细节(可能是幻觉)
contradiction: hypothesis 与 premise 冲突

示例:
premise: "发烧 38.5 吃 0.4ml/kg 美林"
hypothesis: "美林剂量 0.4ml/kg"
→ {"label":"entailment","score":0.9}

premise: "发烧 38.5 吃 0.4ml/kg 美林"
hypothesis: "美林剂量 1.0ml/kg"
→ {"label":"contradiction","score":0.9}`;

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
  {
    name: "部分支持(挑一种 dosage)",
    premise: "美林剂量 0.4ml/kg",
    hypothesis: "美林剂量 0.4ml/kg 或 0.5ml/kg 都行。",
  },
];

async function callNli(premise, hypothesis) {
  const userPrompt = `Premise:\n${premise}\n\nHypothesis:\n${hypothesis}`;
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
        { role: "system", content: LABEL_PROMPT },
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
  return { content, finish, elapsed };
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
    console.log(`label: ${parsed.label}, score: ${parsed.score}`);
  } catch (e) {
    console.log(`❌ JSON parse err: ${e.message}`);
  }
}
