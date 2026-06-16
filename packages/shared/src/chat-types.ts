/**
 * M6.1 多轮会话 API 类型定义（spec §3）。
 *
 * - D1 表 chat_session 行结构：ChatSessionRow
 * - DTO（前端不直接看 D1 列）：ChatSessionDTO
 * - /chat 请求 / 响应：ChatRequest / ChatResponse
 * - Durable Object 内部消息：ChatMessage（与 MultiturnMessage 字段一致，独立定义便于 API 解耦）
 */

import { z } from "zod";

/** DO state.storage 内的 message（spec §2.2） */
export const ChatMessageSchema = z.object({
  role: z.union([z.literal("user"), z.literal("assistant")]),
  content: z.string().min(1),
  summary: z.string().optional(),
  created_at: z.number().int().positive(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** D1 chat_session 表行（spec §2.1） */
export const ChatSessionRowSchema = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  title: z.string().nullable(),
  created_at: z.number().int().positive(),
  last_active_at: z.number().int().positive(),
  degraded_at: z.number().int().positive().nullable(),
});
export type ChatSessionRow = z.infer<typeof ChatSessionRowSchema>;

/** /sessions GET 响应里的 session 卡片（spec §3.3） */
export const ChatSessionDTOSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  created_at: z.number().int().positive(),
  last_active_at: z.number().int().positive(),
});
export type ChatSessionDTO = z.infer<typeof ChatSessionDTOSchema>;

/** /chat 请求（spec §3.2） */
export const ChatRequestSchema = z.object({
  q: z.string().min(1).max(500),
  session_id: z.string().min(1).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** /chat 响应（spec §3.2） */
export const ChatCitationSchema = z.object({
  n: z.number().int().positive(),
  title: z.string(),
  trust_level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  chunk_id: z.string().min(1),
});
export type ChatCitation = z.infer<typeof ChatCitationSchema>;

export const ChatResponseSchema = z.object({
  answer: z.string(),
  disclaimer: z.string(),
  citations: z.array(ChatCitationSchema),
  session_id: z.string().min(1),
  session_title: z.string().nullable(),
  is_new_session: z.boolean(),
  cached: z.boolean(),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
