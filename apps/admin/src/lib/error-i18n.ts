/**
 * 错误码 → 中文用户消息映射（T13）
 *
 * 来源：
 * - IngestOrchestrator.classifyError: ParseFailed / EmbedFailed / PushFailed / PushAuthError / InternalError / UnknownError
 * - CloudPusher.PushError.code: AuthError / RateLimit / ServerError / NetworkError
 * - LocalEmbedder.EmbedError.code: OMLX_Unavailable / OOM / DimensionMismatch / Unknown
 *
 * 设计原则：
 * - 用户只看得到 message，不直接看英文 error.stack
 * - 同一原始错误可能对应多个 i18n key（用 error_code 精确匹配）
 * - 未知 error_code → 返回 fallback 消息 + 包含原始 message（便于诊断）
 */

export interface ErrorMessage {
  /** 中文用户消息 */
  message: string;
  /** 用户可执行的下一步（按钮 / 操作） */
  action?: string;
  /** 是否建议重试 */
  retryable: boolean;
}

const TABLE: Record<string, ErrorMessage> = {
  // orchestrator 分类
  ParseFailed: {
    message: "文件解析失败，请检查文件格式是否正确或是否损坏",
    action: "请尝试重新上传文件，或转换为 PDF/MD/TXT 格式",
    retryable: false,
  },
  EncryptedFile: {
    message: "PDF 已加密，请先解密后重新上传",
    action: "在 PDF 阅读器中移除密码后保存",
    retryable: false,
  },
  EmbedFailed: {
    message: "本地 embedding 服务暂时不可用，已切换至云端",
    action: "等待几秒后重试，或检查 OMLX 是否在运行",
    retryable: true,
  },
  PushFailed: {
    message: "推送到云端失败（服务端错误）",
    action: "稍后点击「重推」按钮",
    retryable: true,
  },
  PushAuthError: {
    message: "云端鉴权失败，请检查 INGEST_PROXY_SECRET 配置",
    action: "联系管理员确认密钥",
    retryable: false,
  },
  InternalError: {
    message: "内部错误，组件未正确初始化",
    action: "重启 admin dev server",
    retryable: false,
  },
  UnknownError: {
    message: "未知错误",
    action: "查看下方详细信息，或重推",
    retryable: true,
  },
  Unknown: {
    message: "未知错误",
    action: "查看下方详细信息，或重推",
    retryable: true,
  },

  // CloudPusher 直接抛出
  AuthError: {
    message: "云端鉴权失败，请检查 INGEST_PROXY_SECRET 配置",
    action: "联系管理员确认密钥",
    retryable: false,
  },
  RateLimit: {
    message: "云端服务繁忙，已自动退避重试",
    action: "如持续失败请稍后再试",
    retryable: true,
  },
  ServerError: {
    message: "云端服务端错误",
    action: "点击「重推」按钮重试",
    retryable: true,
  },
  NetworkError: {
    message: "网络错误，无法连接到云端",
    action: "检查网络后点击「重推」",
    retryable: true,
  },

  // LocalEmbedder 直接抛出
  OMLX_Unavailable: {
    message: "本地 LLM 服务（OMLX）不可用",
    action: "运行 `omlx serve` 启动本地服务，或等待自动切换云端",
    retryable: true,
  },
  OOM: {
    message: "本地 LLM 内存不足（OOM）",
    action: "关闭其他大内存程序，或等待自动切换云端",
    retryable: true,
  },
  DimensionMismatch: {
    message: "embedding 维度不匹配（期望 1536 维）",
    action: "检查 bge-m3 模型配置",
    retryable: false,
  },
};

/**
 * 把 error_code 翻译为用户可读的中文消息。
 *
 * @param code 后端返回的 error_code（如 "ParseFailed"），可为 null
 * @param rawMessage 后端返回的原始 error_message（用于 fallback 显示详情）
 */
export function translateError(code: string | null | undefined, rawMessage?: string | null): ErrorMessage {
  if (code && TABLE[code]) {
    return TABLE[code]!;
  }
  // 未知 code → fallback 显示原始 message
  return {
    message: rawMessage ? `错误：${rawMessage}` : "未知错误",
    retryable: true,
  };
}

/**
 * 给 UI 显示用的纯字符串（不带 action / retryable 字段）。
 */
export function translateErrorMessage(code: string | null | undefined, rawMessage?: string | null): string {
  return translateError(code, rawMessage).message;
}