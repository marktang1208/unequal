/**
 * StatusStore 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StatusStore } from "@unequal/local-llm";

describe("StatusStore (CP-7-C T3)", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: StatusStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "status-store-"));
    dbPath = join(tmpDir, "test.db");
    store = new StatusStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("create + getByFileId: 存进去能取出来", () => {
    const r = store.create({
      file_id: "f-1",
      batch_id: "b-1",
      filename: "weaning.pdf",
      ext: "pdf",
    });
    expect(r.status).toBe("pending");
    expect(r.progress).toBe(0);
    expect(r.tmp_data).toBeNull();
    const got = store.getByFileId("f-1");
    expect(got?.filename).toBe("weaning.pdf");
  });

  it("update: status + progress 转换正确", () => {
    store.create({ file_id: "f-2", batch_id: "b-2", filename: "a.md", ext: "md" });
    store.setStatus("f-2", "parsing", 20);
    expect(store.getByFileId("f-2")?.status).toBe("parsing");
    expect(store.getByFileId("f-2")?.progress).toBe(20);
    store.setStatus("f-2", "done", 100);
    expect(store.getByFileId("f-2")?.status).toBe("done");
  });

  it("listByBatch: 按 batch_id 排序返回", () => {
    const t0 = Date.now();
    store.create({ file_id: "f-3", batch_id: "b-3", filename: "a", ext: "md", created_at: t0 + 10 });
    store.create({ file_id: "f-4", batch_id: "b-3", filename: "b", ext: "md", created_at: t0 + 20 });
    store.create({ file_id: "f-5", batch_id: "b-3", filename: "c", ext: "md", created_at: t0 + 30 });
    const list = store.listByBatch("b-3");
    expect(list).toHaveLength(3);
    expect(list.map((r) => r.file_id)).toEqual(["f-3", "f-4", "f-5"]);  // ASC
  });

  it("markFailed: status=failed + retryable + retry_count+1", () => {
    store.create({ file_id: "f-6", batch_id: "b-6", filename: "x", ext: "pdf" });
    store.markFailed("f-6", "ParseFailed", "PDF 损坏", false);
    const r = store.getByFileId("f-6");
    expect(r?.status).toBe("failed");
    expect(r?.error_code).toBe("ParseFailed");
    expect(r?.error_message).toBe("PDF 损坏");
    expect(r?.retryable).toBe(0);
    expect(r?.retry_count).toBe(1);
  });

  it("markDone: status=done + cloud_ids", () => {
    store.create({ file_id: "f-7", batch_id: "b-7", filename: "x", ext: "pdf" });
    store.markDone("f-7", "01KSRC", "01KDOC");
    const r = store.getByFileId("f-7");
    expect(r?.status).toBe("done");
    expect(r?.cloud_source_id).toBe("01KSRC");
    expect(r?.cloud_document_id).toBe("01KDOC");
  });

  it("resetForRetry: failed → pending + error 清空", () => {
    store.create({ file_id: "f-8", batch_id: "b-8", filename: "x", ext: "pdf" });
    store.markFailed("f-8", "ServerError", "500", true);
    store.resetForRetry("f-8");
    const r = store.getByFileId("f-8");
    expect(r?.status).toBe("pending");
    expect(r?.error_code).toBeNull();
    expect(r?.error_message).toBeNull();
  });

  it("listRetryable: 只返 status=failed + retryable=1", () => {
    store.create({ file_id: "f-9a", batch_id: "b-9", filename: "x", ext: "pdf" });
    store.markFailed("f-9a", "ServerError", "500", true);
    store.create({ file_id: "f-9b", batch_id: "b-9", filename: "y", ext: "pdf" });
    store.markFailed("f-9b", "ParseFailed", "bad", false);
    store.create({ file_id: "f-9c", batch_id: "b-9", filename: "z", ext: "md" });
    const list = store.listRetryable();
    expect(list).toHaveLength(1);
    expect(list[0]?.file_id).toBe("f-9a");
  });

  it("WAL mode: 并发 update 不冲突", async () => {
    store.create({ file_id: "f-10", batch_id: "b-10", filename: "x", ext: "md" });
    // 50 个并发 setStatus（不同 progress）
    const promises = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => store.setStatus("f-10", "pushing", i)),
    );
    await Promise.all(promises);
    const r = store.getByFileId("f-10");
    // 最后写入的可能是任意 i，但 status 一定是 pushing
    expect(r?.status).toBe("pushing");
    expect(r?.progress).toBeGreaterThanOrEqual(0);
  });

  it("getByFileId 返 null 当不存在", () => {
    expect(store.getByFileId("nope")).toBeNull();
  });
});
