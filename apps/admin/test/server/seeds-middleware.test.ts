/**
 * P3-7 种子 URL 库: middleware 集成测试
 *
 * 测试用 ?dbPath= + ?seedsDir= query 覆盖默认路径（每个 case 独立 tmpDir 隔离）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { SeedsStore } from "@unequal/local-llm";
import { seedsMiddleware } from "../../server/seeds-middleware.js";

/** 构造 query string（每个 case unique 路径） */
function q(dbPath: string, seedsDir: string): string {
  return `dbPath=${encodeURIComponent(dbPath)}&seedsDir=${encodeURIComponent(seedsDir)}`;
}

describe("SeedsMiddleware (P3-7)", () => {
  let tmpDir: string;
  let dbPath: string;
  let seedsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "seeds-mw-"));
    dbPath = join(tmpDir, "test.db");
    seedsDir = join(tmpDir, "seeds");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/seeds?source=xhs → 返 {source, urls: []} (空)", async () => {
    const res = await request(seedsMiddleware)
      .get(`/api/seeds?source=xhs&${q(dbPath, seedsDir)}`);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("xhs");
    expect(res.body.urls).toEqual([]);
  });

  it("GET /api/seeds?source=invalid → 400", async () => {
    const res = await request(seedsMiddleware).get("/api/seeds?source=invalid");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_REQUEST");
  });

  it("POST /api/seeds (单条) → 201 + JSON 文件同步", async () => {
    const res = await request(seedsMiddleware)
      .post(`/api/seeds?${q(dbPath, seedsDir)}`)
      .send({ source: "xhs", url: "https://www.xiaohongshu.com/explore/post-1", trust_level: 0 });
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(1);

    // 验证 JSON 文件
    const verifyStore = new SeedsStore(dbPath, seedsDir);
    const file = verifyStore.loadFile("xhs");
    expect(file?.urls).toHaveLength(1);
    expect(file?.urls[0]?.url).toBe("https://www.xiaohongshu.com/explore/post-1");
    verifyStore.close();
  });

  it("POST /api/seeds (批量粘贴) → 返 {added, skipped, errors}", async () => {
    const res = await request(seedsMiddleware)
      .post(`/api/seeds?${q(dbPath, seedsDir)}`)
      .send({
        source: "webpage",
        trust_level: 1,
        batch: [
          "https://example.com/batch-1",
          "https://example.com/batch-2",
          "https://example.com/batch-3",
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(3);
    expect(res.body.skipped).toBe(0);
    expect(res.body.errors).toEqual([]);
  });

  it("POST /api/seeds (重复 URL) → skipped=1, added=0", async () => {
    // 先加 1 条
    const s = new SeedsStore(dbPath, seedsDir);
    await s.add("xhs", "https://www.xiaohongshu.com/explore/dup-test", 0);
    s.close();

    // 再加同样
    const res = await request(seedsMiddleware)
      .post(`/api/seeds?${q(dbPath, seedsDir)}`)
      .send({ source: "xhs", url: "https://www.xiaohongshu.com/explore/dup-test", trust_level: 0 });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(0);
    expect(res.body.skipped).toBe(1);
  });

  it("POST /api/seeds (trust_level 非法) → ADD_FAILED", async () => {
    const res = await request(seedsMiddleware)
      .post(`/api/seeds?${q(dbPath, seedsDir)}`)
      .send({ source: "xhs", url: "https://www.xiaohongshu.com/explore/bad-trust", trust_level: 5 });
    expect(res.status).toBe(400);
  });

  it("POST /api/seeds (batch > 50) → 400", async () => {
    const batch = Array.from({ length: 51 }, (_, i) => `https://example.com/${i}`);
    const res = await request(seedsMiddleware)
      .post(`/api/seeds?${q(dbPath, seedsDir)}`)
      .send({ source: "webpage", batch });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_REQUEST");
  });

  it("PATCH /api/seeds (toggle active=false) → updated=1 + JSON sync", async () => {
    const s = new SeedsStore(dbPath, seedsDir);
    await s.add("xhs", "https://www.xiaohongshu.com/explore/toggle-test", 0);
    s.close();

    const res = await request(seedsMiddleware)
      .patch(`/api/seeds?${q(dbPath, seedsDir)}`)
      .send({ source: "xhs", url: "https://www.xiaohongshu.com/explore/toggle-test", active: false });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);

    // 验证 JSON 文件
    const verifyStore = new SeedsStore(dbPath, seedsDir);
    const file = verifyStore.loadFile("xhs");
    expect(file?.urls[0]?.active).toBe(false);
    verifyStore.close();
  });

  it("PATCH /api/seeds (URL 不存在) → 404", async () => {
    const res = await request(seedsMiddleware)
      .patch(`/api/seeds?${q(dbPath, seedsDir)}`)
      .send({ source: "xhs", url: "https://www.xiaohongshu.com/explore/nonexist", active: false });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/seeds?source=xhs&url=... → deleted=1", async () => {
    const s = new SeedsStore(dbPath, seedsDir);
    await s.add("xhs", "https://www.xiaohongshu.com/explore/del-test", 0);
    s.close();

    const res = await request(seedsMiddleware)
      .delete(`/api/seeds?source=xhs&url=${encodeURIComponent("https://www.xiaohongshu.com/explore/del-test")}&${q(dbPath, seedsDir)}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);

    // 验证 JSON 文件
    const verifyStore = new SeedsStore(dbPath, seedsDir);
    const file = verifyStore.loadFile("xhs");
    expect(file?.urls).toHaveLength(0);
    verifyStore.close();
  });
});