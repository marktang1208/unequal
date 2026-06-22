/**
 * P3-7 / Phase C: StatusStore 新增字段 + helpers 单元测试
 *
 * 覆盖：
 * 1. source 列默认 'upload'
 * 2. create with source='crawler' 正确写
 * 3. metadata 列透传
 * 4. listBySource('crawler', 'pending') 只返 crawler pending
 * 5. listBySource('upload') 只返 upload
 * 6. listPending() 跨 source 返所有 pending
 * 7. countByBatchId 正确
 * 8. ALTER 迁移幂等（多次 applyMigrations 不抛错）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StatusStore } from "../src/index.js";

describe("StatusStore P3-7 (source 列 + helpers)", () => {
  let tmpDir: string;
  let store: StatusStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "statusstore-p37-"));
    store = new StatusStore(join(tmpDir, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("create 默认 source='upload'", () => {
    const r = store.create({
      file_id: "f1",
      batch_id: "b1",
      filename: "a.pdf",
      ext: "pdf",
    });
    expect(r.source).toBe("upload");
  });

  it("create with source='crawler' 正确写", () => {
    const r = store.create({
      file_id: "f2",
      batch_id: "b1",
      filename: "weaning-guide",
      ext: "md",
      source: "crawler",
      markdown: "# baby",
      metadata: JSON.stringify({ crawl_depth: 1, source_domain: "xhs.com" }),
    });
    expect(r.source).toBe("crawler");
    expect(r.markdown).toBe("# baby");
    expect(r.metadata).toContain("crawl_depth");
  });

  it("listBySource('crawler') 只返 crawler 记录", () => {
    store.create({ file_id: "f1", batch_id: "b1", filename: "x.pdf", ext: "pdf" });
    store.create({ file_id: "f2", batch_id: "b1", filename: "y.pdf", ext: "pdf" });
    store.create({ file_id: "f3", batch_id: "b2", filename: "weaning.md", ext: "md", source: "crawler" });
    const crawler = store.listBySource("crawler");
    expect(crawler).toHaveLength(1);
    expect(crawler[0]?.source).toBe("crawler");
    const upload = store.listBySource("upload");
    expect(upload).toHaveLength(2);
  });

  it("listBySource('crawler', 'pending') 只返 crawler pending", () => {
    store.create({ file_id: "f1", batch_id: "b1", filename: "x.pdf", ext: "pdf" });
    store.create({ file_id: "f2", batch_id: "b2", filename: "y.md", ext: "md", source: "crawler", status: "pending" });
    store.create({ file_id: "f3", batch_id: "b2", filename: "z.md", ext: "md", source: "crawler", status: "done" });
    const pending = store.listBySource("crawler", "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.file_id).toBe("f2");
  });

  it("listPending() 跨 source 返所有 pending", () => {
    store.create({ file_id: "f1", batch_id: "b1", filename: "x.pdf", ext: "pdf", status: "pending" });
    store.create({ file_id: "f2", batch_id: "b2", filename: "y.md", ext: "md", source: "crawler", status: "pending" });
    store.create({ file_id: "f3", batch_id: "b2", filename: "z.md", ext: "md", source: "crawler", status: "done" });
    const pending = store.listPending();
    expect(pending).toHaveLength(2);
  });

  it("countByBatchId 正确", () => {
    store.create({ file_id: "f1", batch_id: "b1", filename: "x", ext: "md" });
    store.create({ file_id: "f2", batch_id: "b1", filename: "y", ext: "md" });
    store.create({ file_id: "f3", batch_id: "b2", filename: "z", ext: "md" });
    expect(store.countByBatchId("b1")).toBe(2);
    expect(store.countByBatchId("b2")).toBe(1);
    expect(store.countByBatchId("none")).toBe(0);
  });

  it("metadata 字段：未填 → null", () => {
    const r = store.create({
      file_id: "f1",
      batch_id: "b1",
      filename: "x",
      ext: "md",
      source: "crawler",
    });
    expect(r.metadata).toBeNull();
  });

  it("ALTER 迁移幂等（多次 open 同一个 db 不抛错）", () => {
    store.close();
    // 第二次 open 应自动 apply migrations 但不重复 ALTER
    const store2 = new StatusStore(join(tmpDir, "test.db"));
    expect(store2.listBySource("upload")).toEqual([]);
    store2.close();
  });
});