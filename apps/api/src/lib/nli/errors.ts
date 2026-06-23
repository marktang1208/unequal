/**
 * lib/nli/errors.ts — NliError + 3 子类
 *
 * 错误分类对应 spec §7 错误处理：
 *   - NliRuntimeError: 类别 A（transformers.js init 失败 / 推理抛错）
 *   - NliTimeoutError: 类别 B（推理 > 3s）
 *   - NliConfigError:  类别 D（模型文件缺失，启动期 fail fast）
 */

export abstract class NliError extends Error {
  abstract readonly code: string;
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NliRuntimeError extends NliError {
  readonly code = "NLI_RUNTIME";
}

export class NliTimeoutError extends NliError {
  readonly code = "NLI_TIMEOUT";
}

export class NliConfigError extends NliError {
  readonly code = "NLI_CONFIG";
}
