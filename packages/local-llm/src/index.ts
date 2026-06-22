/**
 * P3-7 / Phase A: @unequal/local-llm barrel export
 *
 * 注意：内部 import 用无后缀（兼容 Vite/esbuild ESM 解析；TS Bundler 模式也可 resolve）。
 */

export * from "./types.js";
export * from "./config.js";
export * from "./provider.js";
export * from "./json-io.js";
export { LocalEmbedder, OMLX_BASE_URL as DEFAULT_LOCAL_EMBED_BASE_URL, DEFAULT_LOCAL_EMBED_MODEL } from "./local-embedder.js";
export { CloudEmbedder } from "./cloud-embedder.js";
export { LocalChat, DEFAULT_LOCAL_CHAT_MODEL } from "./local-chat.js";
export { CloudChat, DEFAULT_CLOUD_CHAT_MODEL } from "./cloud-chat.js";
export { StatusStore, type IngestRecord, type FileStatus, type IngestSource } from "./status-store.js";
export { SeedsStore, type SeedUrl, type SeedFile, type SeedRecord, type SeedSource, type SeedLastStatus } from "./seeds-store.js";
