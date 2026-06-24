// scripts/test-nli-latency.mjs — 连测 Qwen 真实耗时
const apiKey = process.env.SILICONFLOW_API_KEY;
if (!apiKey) {
  console.error("❌ SILICONFLOW_API_KEY not set");
  process.exit(1);
}

const LABEL_PROMPT = `判断 hypothesis 是否被 premise 蕴含。返回 strict JSON:
{"label":"entailment|neutral|contradiction","score":0-1}`;

const CASES = [
  {
    name: "桥接(超知识库)",
    premise: "5个月宝宝发烧38.5要观察精神状态，多喝水，超过39度就医",
    hypothesis:
      "5个月宝宝发烧38.5度时，需要观察宝宝的精神状态，并确保宝宝多喝水。如果体温超过39度，建议及时就医。另外可以用温水擦拭物理降温。",
  },
  {
    name: "完全蕴含",
    premise: "5个月宝宝发烧38.5要观察精神状态，多喝水，超过39度就医",
    hypothesis:
      "5个月宝宝发烧38.5度时，需要观察宝宝的精神状态，并确保宝宝多喝水。",
  },
  {
    name: "完全无关",
    premise: "5个月宝宝发烧38.5要观察精神状态，多喝水，超过39度就医",
    hypothesis: "X 星人住在仙女座星系",
  },
];

async function callNli(premise, hypothesis) {
  const userPrompt = `Premise:\n${premise}\n\nHypothesis:\n${hypothesis}`;
  const start = Date.now();
  try {
    const res = await fetch(
      "https://api.siliconflow.cn/v1/chat/completions",
      {
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
      },
    );
    const elapsed = Date.now() - start;
    if (!res.ok) return { error: `HTTP ${res.status}`, elapsed };
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content ?? "";
    return { content, elapsed };
  } catch (e) {
    return { error: e.message, elapsed: Date.now() - start };
  }
}

for (const c of CASES) {
  console.log(`\n=== ${c.name} ===`);
  for (let i = 1; i <= 5; i++) {
    const r = await callNli(c.premise, c.hypothesis);
    if (r.error) {
      console.log(`  run ${i}: ❌ ${r.error} (${r.elapsed}ms)`);
    } else {
      console.log(`  run ${i}: ${r.elapsed}ms content=${r.content}`);
    }
  }
}
