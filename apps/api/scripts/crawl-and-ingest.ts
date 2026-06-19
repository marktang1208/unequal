/**
 * 临时脚本：从公众号 URL 拉文章 → 调 /api-ingest → chunks 绑给真 wx user
 * Usage: ADMIN_TOKEN=xx WX_USER_ID=xx tsx scripts/crawl-and-ingest.ts <url>
 */
import * as cheerio from "cheerio";

const URL = process.argv[2];
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const WX_USER_ID = process.env.WX_USER_ID;
const GATEWAY = "https://unequal-d4ggf7rwg82e0900b-1444590671.ap-shanghai.app.tcloudbase.com";

if (!URL || !ADMIN_TOKEN || !WX_USER_ID) {
  console.error("Usage: ADMIN_TOKEN=xx WX_USER_ID=xx tsx scripts/crawl-and-ingest.ts <url>");
  process.exit(1);
}

const WX_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49 (0x18003130) NetType/WIFI Language/zh_CN";

async function main() {
  console.log("[1/4] fetching wechat-mp article...");
  const res = await fetch(URL!, { headers: { "user-agent": WX_UA } });
  if (!res.ok) throw new Error(`fetch failed ${res.status}`);
  const html = await res.text();

  const $ = cheerio.load(html);
  const title = $("#activity-name").text().trim() || $("title").text().trim();
  const $content = $("#js_content");
  $content.find("script,style,img,iframe").remove();
  const paragraphs = $content
    .find("p,h1,h2,h3,h4,h5,h6,li,blockquote")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((p) => p.length > 0);
  const content = paragraphs.join("\n\n");

  console.log(`[2/4] parsed: title="${title}" / ${paragraphs.length} paragraphs / ${content.length} chars`);
  console.log(`[3/4] login admin...`);
  const loginRes = await fetch(`${GATEWAY}/api-auth-admin-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ADMIN_TOKEN }),
  });
  const loginData = await loginRes.json();
  if (!loginRes.ok) {
    console.error("admin login failed:", loginData);
    process.exit(1);
  }
  const jwt = (loginData as { jwt: string }).jwt;
  console.log("  ✓ admin jwt obtained");

  console.log(`[4/4] POST /api-ingest with user_id=${WX_USER_ID}...`);
  const ingestRes = await fetch(`${GATEWAY}/api-ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      title,
      url: URL,
      content,
      trust_level: 2,
      user_id: WX_USER_ID,
    }),
  });
  const ingestData = await ingestRes.json();
  console.log("ingest result:", JSON.stringify(ingestData, null, 2));

  if (ingestRes.ok) {
    console.log("\n✅ DONE. Chunks 已绑给 user", WX_USER_ID);
    console.log("现在去小程序问问题，应该能看到 [N] 引用了。");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
