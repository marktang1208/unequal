/**
 * lib/logger.ts — NDJSON stdout + stderr 协议
 *
 * stdout: 可解析 JSON（供其他工具 pipe / 集成）
 * stderr: 人读（含颜色 ANSI 码 — terminal 显示）
 *
 * 所有 deploy 子命令统一用 logger.info/warn/error；顶层 catch 调 logger.fatal(err)
 */

type Level = "info" | "warn" | "error";

const COLORS = {
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
} as const;

function emit(level: Level, msg: string, meta?: object): void {
  const jsonLine = JSON.stringify({ level, msg, ts: Date.now(), ...(meta ?? {}) });

  if (level === "info") {
    process.stdout.write(jsonLine + "\n");
  } else {
    // stderr: 人读格式 + 颜色
    const icon = level === "warn" ? "⚠️ " : "❌";
    const color = level === "warn" ? COLORS.yellow : COLORS.red;
    const humanLine = `${color}${icon} ${msg}${COLORS.reset}\n`;
    process.stderr.write(humanLine);
    // 同时输出可解析 JSON 到 stderr（structured 模式）
    if (process.env.DEPLOY_LOG_JSON === "1") {
      process.stderr.write(jsonLine + "\n");
    }
  }
}

export const logger = {
  info: (msg: string, meta?: object) => emit("info", msg, meta),
  warn: (msg: string, meta?: object) => emit("warn", msg, meta),
  error: (msg: string, meta?: object) => emit("error", msg, meta),
  fatal: (err: unknown): never => {
    if (err instanceof Error) {
      emit("error", err.message, { stack: err.stack, name: err.name });
    } else {
      emit("error", String(err));
    }
    process.exit(1);
  },
};