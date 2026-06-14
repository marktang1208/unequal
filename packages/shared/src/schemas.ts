import { z } from "zod";

export const TrustLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const SourceTypeSchema = z.enum(["file", "webpage", "xiaohongshu", "wechat-mp"]);

export const UserSchema = z.object({
  id: z.string().min(1),
  wxOpenid: z.string().optional(),
  nickname: z.string().optional(),
  createdAt: z.number().int().positive(),
});

export const SourceSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  type: SourceTypeSchema,
  title: z.string().optional(),
  url: z.string().url().optional(),
  account: z.string().optional(),
  trustLevel: TrustLevelSchema,
  createdAt: z.number().int().positive(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const DocumentSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  userId: z.string().min(1),
  title: z.string().optional(),
  rawPath: z.string().min(1),
  parsedTextPath: z.string().optional(),
  createdAt: z.number().int().positive(),
});

export const ChunkSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  sourceId: z.string().min(1),
  userId: z.string().min(1),
  idx: z.number().int().nonnegative(),
  content: z.string().min(1),
  tokenCount: z.number().int().nonnegative(),
  trustLevel: TrustLevelSchema,
  createdAt: z.number().int().positive(),
});

export const CitationSchema = z.object({
  n: z.number().int().positive(),
  title: z.string().optional(),
  snippet: z.string().min(1),
  url: z.string().min(1),
  trustLevel: TrustLevelSchema,
  sourceId: z.string().min(1),
  chunkId: z.string().min(1),
});