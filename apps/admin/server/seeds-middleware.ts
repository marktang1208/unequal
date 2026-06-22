/**
 * P3-7 种子 URL 库: Vite middleware
 *
 * 路由（Vite dev 5173）：
 *   GET    /api/seeds?source=xhs         → 返 {source, urls: SeedRecord[]}
 *   POST   /api/seeds                    body={source, url, trust_level, batch?: string[]} → 返 {added, skipped, errors}
 *   PATCH  /api/seeds                    body={source, url, active?, trust_level?} → 返 {updated}
 *   DELETE /api/seeds?source=xhs&url=... → 返 {deleted}
 *
 * 设计：Vite Connect.Server；通过 vite.config.ts plugin 注入 server.middlewares
 */

import type { Connect } from "vite";
import { SeedsStore, type SeedSource, type SeedRecord } from "@unequal/local-llm";

export type { SeedSource, SeedRecord } from "./seeds-store.js";

interface AddBody {
  source?: string;
  url?: string;
  trust_level?: number;
  batch?: string[];  // 批量粘贴：每行 1 URL
}

interface PatchBody {
  source?: string;
  url?: string;
  active?: boolean;
  trust_level?: number;
}

const VALID_SOURCES: SeedSource[] = ["xhs", "wechat-mp", "webpage"];

function isSeedSource(s: string): s is SeedSource {
  return (VALID_SOURCES as string[]).includes(s);
}

function getStore(dbPath = ".tmp/unequal.db", seedsDir = "../apps/crawler/seeds"): SeedsStore {
  return new SeedsStore(dbPath, seedsDir);
}

function handleList(req: Connect.IncomingMessage, res: import("node:http").ServerResponse, url: URL): void {
  const source = url.searchParams.get("source");
  if (source && !isSeedSource(source)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "INVALID_REQUEST", message: `source must be xhs|wechat-mp|webpage` }));
    return;
  }
  // Test/dev hook: ?dbPath= + ?seedsDir= 覆盖（生产 dev 默认 .tmp/unequal.db）
  const dbPath = url.searchParams.get("dbPath") ?? undefined;
  const seedsDir = url.searchParams.get("seedsDir") ?? undefined;
  const store = getStore(dbPath, seedsDir);
  try {
    // 启动时同步一次：JSON → SQLite（保证最新）
    if (source) {
      store.syncFromJson(source);
    } else {
      store.syncAllFromJson();
    }
    // 列所有 source 或单 source
    if (source) {
      const records = store.listBySource(source);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ source, urls: records }));
    } else {
      const all = VALID_SOURCES.flatMap((s) => store.listBySource(s));
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ urls: all }));
    }
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) }));
  } finally {
    store.close();
  }
}

async function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function handleAdd(req: Connect.IncomingMessage, res: import("node:http").ServerResponse, url: URL): Promise<void> {
  const dbPath = url.searchParams.get("dbPath") ?? undefined;
  const seedsDir = url.searchParams.get("seedsDir") ?? undefined;
  let body: AddBody = {};
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: "INVALID_JSON", message: "Body must be JSON" });
    return;
  }
  const source = body.source;
  if (!source || !isSeedSource(source)) {
    sendJson(res, 400, { error: "INVALID_REQUEST", message: `source must be xhs|wechat-mp|webpage` });
    return;
  }
  const store = getStore(dbPath, seedsDir);
  try {
    const results: { added: number; skipped: number; errors: Array<{ url: string; error: string }> } = { added: 0, skipped: 0, errors: [] };
    // 批量模式
    if (Array.isArray(body.batch) && body.batch.length > 0) {
      if (body.batch.length > 50) {
        sendJson(res, 400, { error: "INVALID_REQUEST", message: "batch max 50 urls, please split" });
        return;
      }
      for (const url of body.batch) {
        try {
          const trustLevel = (body.trust_level ?? 1) as 0 | 1 | 2 | 3;
          await store.add(source, url, trustLevel);
          results.added++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("already exists")) {
            results.skipped++;
          } else {
            results.errors.push({ url, error: msg });
          }
        }
      }
      sendJson(res, 200, results);
      return;
    }
    // 单条模式
    if (!body.url) {
      sendJson(res, 400, { error: "INVALID_REQUEST", message: "url or batch required" });
      return;
    }
    const trustLevel = (body.trust_level ?? 1) as 0 | 1 | 2 | 3;
    try {
      await store.add(source, body.url, trustLevel);
      sendJson(res, 201, { added: 1, skipped: 0, errors: [] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists")) {
        sendJson(res, 200, { added: 0, skipped: 1, errors: [] });
        return;
      }
      sendJson(res, 400, { error: "ADD_FAILED", message: msg });
    }
  } finally {
    store.close();
  }
}

async function handlePatch(req: Connect.IncomingMessage, res: import("node:http").ServerResponse, url: URL): Promise<void> {
  const dbPath = url.searchParams.get("dbPath") ?? undefined;
  const seedsDir = url.searchParams.get("seedsDir") ?? undefined;
  let body: PatchBody = {};
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: "INVALID_JSON", message: "Body must be JSON" });
    return;
  }
  if (!body.source || !isSeedSource(body.source) || !body.url) {
    sendJson(res, 400, { error: "INVALID_REQUEST", message: "source + url required" });
    return;
  }
  const store = getStore(dbPath, seedsDir);
  try {
    if (typeof body.active === "boolean") {
      await store.toggleActive(body.source, body.url, body.active);
    }
    if (typeof body.trust_level === "number") {
      const tl = body.trust_level as 0 | 1 | 2 | 3;
      await store.updateTrustLevel(body.source, body.url, tl);
    }
    sendJson(res, 200, { updated: 1 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 404, { error: "NOT_FOUND", message: msg });
  } finally {
    store.close();
  }
}

function handleDelete(req: Connect.IncomingMessage, res: import("node:http").ServerResponse, url: URL): void {
  const source = url.searchParams.get("source");
  const targetUrl = url.searchParams.get("url");
  const dbPath = url.searchParams.get("dbPath") ?? undefined;
  const seedsDir = url.searchParams.get("seedsDir") ?? undefined;
  if (!source || !isSeedSource(source) || !targetUrl) {
    sendJson(res, 400, { error: "INVALID_REQUEST", message: "source + url query required" });
    return;
  }
  const store = getStore(dbPath, seedsDir);
  void (async () => {
    try {
      await store.remove(source, targetUrl);
      sendJson(res, 200, { deleted: 1 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 404, { error: "NOT_FOUND", message: msg });
    } finally {
      store.close();
    }
  })();
}

export const seedsMiddleware: Connect.Server = async (req, res, next) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/seeds") {
      handleList(req, res, url);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/seeds") {
      await handleAdd(req, res, url);
      return;
    }
    if (req.method === "PATCH" && url.pathname === "/api/seeds") {
      await handlePatch(req, res, url);
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/api/seeds") {
      handleDelete(req, res, url);
      return;
    }
    next();
  } catch (err) {
    console.error("[seeds-middleware] unhandled error:", err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) });
    }
  }
};