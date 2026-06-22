/**
 * P3-7 / Phase A: LLM Provider 桥 — admin 端薄 re-export 自 @unequal/local-llm
 *
 * 历史：admin 端原本有自己的 `embedder-factory.ts` + `local-embedder.ts` + `cloud-embedder.ts`（CP-7-D 引入），
 * P3-7 抽到 `packages/local-llm/` 共享包（admin + crawler 同源）。
 *
 * 桥保留理由：
 * - admin 端 `local-ingest.ts` 已经 import 自 `./embedder-factory.js`，改 import 路径会扩散
 * - admin 单测已用 `LocalEmbedder` / `CloudEmbedder` 类身份断言（`instanceof`），通过 re-export
 *   路径切换保持身份一致
 *
 * 命名兼容：
 * - `createEmbedder(cfg)` 接受 admin 现有 `EmbedderConfig`（从 config.ts），与 packages 同接口
 * - `createChat(cfg)` 同
 * - `loadLocalLLMConfig()` 包装了 packages 的同名函数，admin 端 init 路径仍走 `initConfig`
 *   （admin 本地 `loadConfig` 含 PdfConfig / AppConfig，比 packages 详细）
 */

import { createEmbedder as _createEmbedder, createChat as _createChat, loadLocalLLMConfig, LocalEmbedder, CloudEmbedder, LocalChat, CloudChat, EmbedError, EXPECTED_EMBED_DIM, StatusStore, type FileStatus, type IngestRecord } from "@unequal/local-llm";
import type { EmbedderConfig, ChatConfig } from "@unequal/local-llm";
import type { Embedder, Chat } from "@unequal/local-llm";

export function createEmbedder(cfg: EmbedderConfig): Embedder {
  return _createEmbedder(cfg);
}

export function createChat(cfg: ChatConfig): Chat {
  return _createChat(cfg);
}

// 兼容旧名字：admin 端 init path 已用 `initConfig`（admin/server/config.ts 内实现，
// 含 PdfConfig / AppConfig 完整版），不需要 `loadLocalLLMConfig` 替代。
// 这里 re-export 让 crawler 端 / 未来 admin 端直调也能用。
export { loadLocalLLMConfig, LocalEmbedder, CloudEmbedder, LocalChat, CloudChat, EmbedError, EXPECTED_EMBED_DIM, StatusStore, type FileStatus, type IngestRecord };
export type { EmbedderConfig, ChatConfig, Embedder, Chat };
