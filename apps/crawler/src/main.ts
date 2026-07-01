#!/usr/bin/env node
/**
 * CLI 入口：node apps/crawler/src/main.ts [options]
 *
 * P3-7 / Phase B：触发参数化（CLI / launchd / UI 三种统一）
 *
 * 模式：
 *   1) 单条直推云（legacy 兼容）：
 *      --url <URL> --source-type <webpage|xiaohongshu|wechat-mp>
 *      [--token <T> | --ingest-proxy-secret <S>] [--user-id <U>] [--trust 0-3]
 *      [--no-sqlite]   # 跳过写 SQLite（直推云路径，仅 legacy 兼容）
 *
 *   2) 单条暂存（默认 P3-7）：
 *      --url <URL> --source-type <webpage|xiaohongshu|wechat-mp> [--trust 0-3]
 *      → 跑 fetch + parse + chunk + embed → 写 .tmp/unequal.db → status=pending
 *
 *   3) 批量触发（launchd / CLI）：
 *      --source <xhs|wechat-mp|webpage|all> [--limit N] [--since TS] [--until TS]
 *      [--full-scan]
 *
 *   4) 触发 + 直推云（legacy）：
 *      同 1) 加 --direct-cloud
 *
 * CP-7-C #2: 优先用 --ingest-proxy-secret / INGEST_PROXY_SECRET env（推荐），
 * 缺省回退到 --token (ADMIN_TOKEN)。proxy secret 路径可指定 user_id；token 路径仅 DEFAULT_USER_ID。
 */
import { fetchUrl } from "./sources/webpage.js";
import { fetchXiaohongshuNote } from "./sources/xiaohongshu.js";
import { fetchWechatMpArticle } from "./sources/wechat-mp.js";
import { fetchPdf } from "./sources/pdf.js";
import { submitToIngest } from "./ingest-sqlite.js";
import { runCrawler } from "./trigger.js";
import type { CrawledDocument } from "./types.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const stripped = arg.slice(2);
      // 支持两种形式：--key value 或 --key=value
      const eqIdx = stripped.indexOf("=");
      let key: string;
      let value: string | undefined;
      if (eqIdx >= 0) {
        key = stripped.slice(0, eqIdx);
        value = stripped.slice(eqIdx + 1);
        out[key] = value;
        continue;
      }
      key = stripped;
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

function printUsage(): void {
  console.error("Usage:");
  console.error("  P3-7 单条暂存：");
  console.error("    --url <URL> --source-type <webpage|xiaohongshu|wechat-mp|pdf> [--trust 0-3]");
  console.error("  P3-7 批量触发：");
  console.error("    --source <webpage|xiaohongshu|wechat-mp|pdf|all> [--limit N] [--since TS] [--until TS] [--full-scan]");
  console.error("  Legacy 直推云：");
  console.error("    --url <URL> --source-type <webpage|xiaohongshu|wechat-mp|pdf> --direct-cloud");
  console.error("    [--token <T> | --ingest-proxy-secret <S>] [--user-id <U>]");
  console.error("    [--ingest-url <URL>]");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url as string | undefined;
  const sourceType = (args["source-type"] as string) ?? (args.source as string) ?? "webpage";
  const ingestUrl = (args["ingest-url"] as string) ?? "http://localhost:8787/ingest";
  const ingestProxySecret = (args["ingest-proxy-secret"] as string) ?? process.env.INGEST_PROXY_SECRET;
  const token = (args.token as string) ?? process.env.ADMIN_TOKEN ?? "";
  const userIdArg = args["user-id"] as string | undefined;
  const trustLevel = parseInt((args.trust as string) ?? "1", 10) as 0 | 1 | 2 | 3;
  const noSqlite = args["no-sqlite"] === true;
  const directCloud = args["direct-cloud"] === true;

  // ─── 模式 2/3：P3-7 暂存路径（默认） ────────────────────────
  //   - 有 url → 模式 2（单条暂存）
  //   - 有 source 且无 url → 模式 3（批量触发）
  //   - directCloud=true → 模式 4（legacy 直推云，跳过暂存）

  if (url && !directCloud) {
    // 模式 2：单条暂存
    if (!["webpage", "xiaohongshu", "wechat-mp", "pdf"].includes(sourceType)) {
      console.error(`[crawler] invalid --source-type: ${sourceType} (must be webpage|xiaohongshu|wechat-mp|pdf)`);
      process.exit(1);
    }
    console.log(`[crawler] P3-7 single-url store: ${url} (source-type: ${sourceType}, trust=${trustLevel})`);
    const r = await runCrawler({
      url,
      source: sourceType as any,
      trustLevel,
    });
    console.log(`[crawler] result: total=${r.total} succeeded=${r.succeeded} failed=${r.failed} file_ids=${JSON.stringify(r.file_ids)}`);
    if (r.failed > 0) process.exit(1);
    return;
  }

  if (args.source && !url && !directCloud) {
    // 模式 3：批量触发
    const limit = args.limit ? parseInt(args.limit as string, 10) : undefined;
    const since = args.since ? parseInt(args.since as string, 10) : undefined;
    const until = args.until ? parseInt(args.until as string, 10) : undefined;
    const fullScan = args["full-scan"] === true;
    console.log(`[crawler] P3-7 batch trigger: source=${args.source} limit=${limit} since=${since} until=${until} fullScan=${fullScan}`);
    const r = await runCrawler({
      source: args.source as any,
      ...(limit ? { limit } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      ...(fullScan ? { fullScan } : {}),
      trustLevel,
    });
    console.log(`[crawler] result: total=${r.total} succeeded=${r.succeeded} failed=${r.failed} file_ids=${JSON.stringify(r.file_ids)}`);
    if (r.failed > 0) process.exit(1);
    return;
  }

  // ─── Legacy 兼容：直推云路径 ────────────────────────────────
  if (!url) {
    printUsage();
    process.exit(1);
  }

  if (!["webpage", "xiaohongshu", "wechat-mp", "pdf"].includes(sourceType)) {
    console.error(`[crawler] invalid --source-type: ${sourceType} (must be webpage|xiaohongshu|wechat-mp|pdf)`);
    process.exit(1);
  }

  let doc: CrawledDocument;
  console.log(`[crawler] legacy direct-cloud: ${url} (source-type: ${sourceType})`);
  if (sourceType === "xiaohongshu") {
    doc = await fetchXiaohongshuNote(url);
  } else if (sourceType === "wechat-mp") {
    doc = await fetchWechatMpArticle(url);
  } else if (sourceType === "pdf") {
    doc = await fetchPdf(url);
  } else {
    doc = await fetchUrl(url);
  }
  console.log(`[crawler] title: ${doc.title}`);
  console.log(`[crawler] paragraphs: ${doc.paragraphs.length}, totalChars: ${doc.totalChars}`);

  if (noSqlite) {
    console.log("[crawler] --no-sqlite set, skipping SQLite ingest");
    console.log(JSON.stringify(doc, null, 2));
    return;
  }

  // fail-fast 三种错误组合（与原 ingest.ts 行为一致）
  if (ingestProxySecret && token) {
    console.error("[crawler] --token and --ingest-proxy-secret are mutually exclusive (pick one auth path)");
    process.exit(1);
  }
  if (!ingestProxySecret && !token) {
    console.error("[crawler] legacy direct-cloud: --token or --ingest-proxy-secret required");
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
