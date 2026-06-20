/**
 * CP-6: CloudBase DB 通用 helpers
 *
 * 封装 SDK 细节：
 * - add / getById / whereQuery / update / remove / count
 * - 统一 ULID ID 生成（v0 沿用）
 * - 错误统一 throw（handler 层 catch → 错误响应）
 */

import { ulid } from "ulid";
import { getDB } from "./cloudbase.js";
import { COLLECTIONS, type CollectionName } from "./collections.js";

const DB = () => getDB();

/** 生成新 doc ID（ULID 格式，沿用 v0） */
export function newId(): string {
  return ulid();
}

/** add：插入新 doc，返回 _id；CP-7-C #4: caller 没提供有效 id 时自动填 = _id（避免 id: "" 污染） */
export async function add<T>(
  collection: CollectionName,
  data: T,
): Promise<string> {
  const _id = newId();
  const dataRecord = data as Record<string, unknown>;
  const providedId = typeof dataRecord.id === "string" ? dataRecord.id : "";
  const finalId = providedId.trim() !== "" ? providedId : _id;
  await DB().collection(collection).add({ ...dataRecord, _id, id: finalId });
  return _id;
}

/** getById：按 _id 取单 doc；不存在返 null */
export async function getById<T = Record<string, unknown>>(
  collection: CollectionName,
  id: string,
): Promise<(T & { _id: string }) | null> {
  const res = await DB().collection(collection).doc(id).get();
  const data = (res.data as Array<T & { _id: string }> | undefined)?.[0];
  return data ?? null;
}

/** whereQuery：按 filter 查；自动分页支持大结果集 */
export interface WhereQueryOptions {
  limit?: number;
  skip?: number;
  orderBy?: { field: string; direction: "asc" | "desc" };
}

export async function whereQuery<T = Record<string, unknown>>(
  collection: CollectionName,
  filter: Record<string, unknown>,
  opts: WhereQueryOptions = {},
): Promise<Array<T & { _id: string }>> {
  let q = DB().collection(collection).where(filter);

  if (opts.orderBy) {
    q = q.orderBy(opts.orderBy.field, opts.orderBy.direction);
  }
  if (opts.skip) {
    q = q.skip(opts.skip);
  }
  if (opts.limit) {
    q = q.limit(opts.limit);
  }

  const res = await q.get();
  return (res.data as Array<T & { _id: string }>) ?? [];
}

/** update：按 _id 部分字段更新 */
export async function update(
  collection: CollectionName,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await DB().collection(collection).doc(id).update(patch);
}

/** remove：按 _id 删 */
export async function remove(collection: CollectionName, id: string): Promise<void> {
  await DB().collection(collection).doc(id).remove();
}

/** count：按 filter 计数 */
export async function count(
  collection: CollectionName,
  filter: Record<string, unknown>,
): Promise<number> {
  const res = await DB().collection(collection).where(filter).count();
  return (res as { total?: number }).total ?? 0;
}

/** 分页拉所有 doc（spec §4.3 用于 vector search 拉所有 user chunks） */
export async function getAllByFilter<T = Record<string, unknown>>(
  collection: CollectionName,
  filter: Record<string, unknown>,
  pageSize = 1000,
): Promise<Array<T & { _id: string }>> {
  const all: Array<T & { _id: string }> = [];
  let offset = 0;
  while (true) {
    const page = await whereQuery<T>(collection, filter, { limit: pageSize, skip: offset });
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

// 重新导出 COLLECTIONS 方便用 `import { COLLECTIONS } from "./db.js"`
export { COLLECTIONS };