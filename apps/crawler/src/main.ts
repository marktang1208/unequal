#!/usr/bin/env node
/**
 * CLI 入口：node apps/crawler/src/main.ts --url <URL> [--ingest-url <URL>] [--token <T>] [--ingest-proxy-secret <S>] [--user-id <U>] [--trust 0-3] [--no-ingest]
 *
 * 默认：抓取 + 调 /ingest。
 * --no-ingest: 只抓取不调 ingest（调试用）。
 *
 * CP-7-C #2: 优先用 --ingest-proxy-secret / INGEST_PROXY_SECRET env（推荐），
 * 缺省回退到 --token (ADMIN_TOKEN)。proxy secret 路径可指定 user_id；token 路径仅 DEFAULT_USER_ID。
 */
import { fetchUrl } from "./sources/webpage.js";
import { fetchXiaohongshuNote } from "./sources/xiaohongshu.js";
import { fetchWechatMpArticle } from "./sources/wechat-mp.js";
import { submitToIngest } from "./ingest.js";
import type { CrawledDocument } from "./types.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url as string;
  const sourceType = (args["source-type"] as string) ?? "webpage";
  if (!["webpage", "xiaohongshu", "wechat-mp"].includes(sourceType)) {
    console.error(`[crawler] invalid --source-type: ${sourceType} (must be webpage|xiaohongshu|wechat-mp)`);
    process.exit(1);
  }
  if (!url) {
    console.error("Usage: --url <URL> [--source-type webpage|xiaohongshu|wechat-mp] [--ingest-url <URL>] [--token <T> | --ingest-proxy-secret <S>] [--user-id <U>] [--trust 0-3] [--no-ingest]");
    process.exit(1);
  }

  const ingestUrl = (args["ingest-url"] as string) ?? "http://localhost:8787/ingest";
  // CP-7-C #3: proxy secret 与 token 互斥；CLI 层 fail-fast 拦截双传/都缺
  const ingestProxySecret = (args["ingest-proxy-secret"] as string) ?? process.env.INGEST_PROXY_SECRET;
  const token = (args.token as string) ?? process.env.ADMIN_TOKEN ?? "";
  const userIdArg = args["user-id"] as string | undefined;
  const trustLevel = parseInt((args.trust as string) ?? "2", 10) as 0 | 1 | 2 | 3;
  const noIngest = args["no-ingest"] === true;

  let doc: CrawledDocument;
  console.log(`[crawler] fetch ${url} (source-type: ${sourceType})`);
  if (sourceType === "xiaohongshu") {
    doc = await fetchXiaohongshuNote(url);
  } else if (sourceType === "wechat-mp") {
    doc = await fetchWechatMpArticle(url);
  } else {
    doc = await fetchUrl(url);
  }
  console.log(`[crawler] title: ${doc.title}`);
  console.log(`[crawler] paragraphs: ${doc.paragraphs.length}, totalChars: ${doc.totalChars}`);

  if (noIngest) {
    console.log("[crawler] --no-ingest set, skipping ingest");
    console.log(JSON.stringify(doc, null, 2));
    return;
  }

  // ─── CP-7-C #3: fail-fast 三种错误组合 ────────────────────
  if (ingestProxySecret && token) {
    console.error("[crawler] --token and --ingest-proxy-secret are mutually exclusive (pick one auth path)");
    process.exit(1);
  }
  if (!ingestProxySecret && !token) {
    console.error("[crawler] --token (ADMIN_TOKEN) or --ingest-proxy-secret / INGEST_PROXY_SECRET required for ingest (or pass --no-ingest)");
    process.exit(1);
  }
  if (userIdArg && !ingestProxySecret) {
    console.error("[crawler] --user-id requires --ingest-proxy-secret (admin path can only ingest to DEFAULT_USER_ID)");
    process.exit(1);
  }

  console.log(
    `[crawler] submit to ${ingestUrl} (auth: ${ingestProxySecret ? "ingest_proxy" : "admin_token"}${userIdArg ? `, target userId=${userIdArg}` : ""})`,
  );
  const result = await submitToIngest(doc, {
    ingestUrl,
    ...(ingestProxySecret ? { ingestProxySecret } : { token }),
    userId: userIdArg,
    trustLevel,
  });
  if (result.ok) {
    console.log(`[crawler] ingest ok: sourceId=${result.sourceId ?? "?"} documentId=${result.documentId ?? "?"}`);
  } else {
    console.error(`[crawler] ingest failed: ${result.status} ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[crawler] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
