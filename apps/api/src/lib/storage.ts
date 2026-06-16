/**
 * CP-6: CloudBase 云存储 helpers
 *
 * 封装 uploadFile / getTempFileURL / deleteFile
 * 上传原文件（PDF / docx）+ parsed_text 存到云存储
 */

import { getCloudBaseApp } from "./cloudbase.js";

const app = () => getCloudBaseApp();

/** 上传文件（Buffer）到云存储 */
export async function uploadFile(
  cloudPath: string,
  content: Buffer,
): Promise<void> {
  await app().uploadFile({ cloudPath, fileContent: content });
}

/** 上传 string 内容到云存储 */
export async function uploadText(
  cloudPath: string,
  content: string,
  encoding: BufferEncoding = "utf-8",
): Promise<void> {
  await app().uploadFile({ cloudPath, fileContent: Buffer.from(content, encoding) });
}

/** 取临时访问 URL（默认 1 小时） */
export async function getTempFileURL(
  cloudPaths: string[],
  maxAge = 3600,
): Promise<Map<string, string>> {
  const res = await app().getTempFileURL({
    fileList: cloudPaths.map((c) => ({ fileID: c, maxAge })),
  });
  const map = new Map<string, string>();
  for (const f of (res as { fileList?: Array<{ fileID: string; tempFileURL?: string }> }).fileList ?? []) {
    if (f.tempFileURL) map.set(f.fileID, f.tempFileURL);
  }
  return map;
}

/** 删文件 */
export async function deleteFile(cloudPaths: string[]): Promise<void> {
  await app().deleteFile({ fileList: cloudPaths });
}

/** 路径 helper：原文件路径 */
export function rawFilePath(userId: string, docId: string, ext: string): string {
  return `raw/${userId}/${docId}/source.${ext}`;
}

/** 路径 helper：parsed text 路径 */
export function parsedTextPath(userId: string, docId: string): string {
  return `parsed/${userId}/${docId}.md`;
}