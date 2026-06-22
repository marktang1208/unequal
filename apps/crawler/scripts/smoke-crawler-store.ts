/**
 * 真接 1: CLI 跑爬 + 写 SQLite 暂存
 *
 * 用 mock fetch + mock embedder（避免 OMLX 不可达 + China 网络限制）
 * 调 runCrawler({url, dbPath, fetchImpl, embedderOverride}) → 写 .tmp/unequal.db
 * 然后读 SQLite 验证 source=crawler + status=pending
 */

import { runCrawler } from "../src/trigger.js";
import { StatusStore } from "@unequal/local-llm";
import { resolve } from "node:path";

const HTML = `
<html><head><title>婴儿发烧处理</title></head><body>
  <article>
    <h1>婴儿发烧 38.5℃ 怎么办</h1>
    <p>婴儿发烧时先观察精神状态比体温数字更重要。</p>
    <p>对乙酰氨基酚（泰诺林）是 3 个月以上婴儿首选退烧药。</p>
    <p>布洛芬（美林）适合 6 个月以上婴儿，需按体重计算剂量。</p>
  </article>
</body></html>
`;

const mockFetch: typeof fetch = (async () => new Response(HTML, { status: 200 })) as typeof fetch;

const mockEmbedder = {
  embed: async (texts: string[]) => texts.map((_, i) => new Array(1536).fill(0.1 * (i + 1))),
};

const DB_PATH = resolve(__dirname, "../../admin/.tmp/unequal.db");

async function main(): Promise<void> {
  const r = await runCrawler({
    url: "https://example.com/articles/baby-fever-38.5",
    source: "webpage",
    trustLevel: 1,
    dbPath: DB_PATH,
    fetchImpl: mockFetch,
    embedderOverride: mockEmbedder,
  });

  console.log(`[真接 1] runCrawler result: total=${r.total} succeeded=${r.succeeded} failed=${r.failed} file_ids=${JSON.stringify(r.file_ids)}`);

  // 读 SQLite 验证
  const store = new StatusStore(DB_PATH);
  const records = store.listBySource("crawler", "pending");
  console.log(`[真接 1] SQLite 验证：listBySource('crawler', 'pending') → ${records.length} 条`);
  for (const r of records) {
    console.log(`  - file_id=${r.file_id} filename=${r.filename} status=${r.status} source=${r.source} markdown_chars=${r.markdown_chars} chunks_count=${r.chunks_count}`);
    console.log(`    markdown preview: ${(r.markdown ?? "").slice(0, 100)}...`);
  }
  store.close();

  if (r.succeeded !== 1 || records.length !== 1) {
    console.error("❌ 真接 1 FAIL");
    process.exit(1);
  }
  console.log("✅ 真接 1 PASS");
}

main().catch((err) => {
  console.error("[真接 1] fatal:", err);
  process.exit(1);
});
