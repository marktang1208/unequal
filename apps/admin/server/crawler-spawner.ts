/**
 * P3-7 / Phase C: crawler-spawner — 启动 crawler 子进程 + PID 文件管理
 *
 * UI 启动爬虫：admin-upload 页点 "启动爬虫" → POST /api/crawler/start
 * → 本模块 spawn `pnpm -F crawler start --source=X --limit=N` 子进程
 * → 写 PID 文件 .tmp/crawler-{process_id}.pid (detach)
 *
 * 进程查询：GET /api/crawler/status?process_id=X → 查 PID 文件 + 看 alive + 查 SQLite 该 batch_id 的 pending 数
 *
 * 设计：
 * - 用 child_process.spawn + detached: true 实现后台 detach（不阻塞 admin dev server）
 * - 子进程 stdio 写到 .tmp/crawler-{pid}.log（admin UI 可看进度）
 * - 进程退出时 spawner 不主动清理 PID 文件；admin 主动 stop 或重启时清理
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

const PID_DIR = ".tmp";

export interface SpawnOptions {
  source: "xhs" | "wechat-mp" | "webpage" | "all";
  limit?: number;
  since?: number;
  until?: number;
  fullScan?: boolean;
  trustLevel?: 0 | 1 | 2 | 3;
}

export interface SpawnResult {
  process_id: string;
  pid: number | undefined;
  log_path: string;
  started_at: number;
}

export interface CrawlerStatus {
  process_id: string;
  alive: boolean;
  pid?: number;
  pending_count: number;
  started_at: number;
  log_tail?: string;
}

function ensurePidDir(): void {
  mkdirSync(PID_DIR, { recursive: true });
}

function pidFilePath(processId: string): string {
  return join(PID_DIR, `crawler-${processId}.pid`);
}

function logFilePath(processId: string): string {
  return join(PID_DIR, `crawler-${processId}.log`);
}

function batchFilePath(processId: string): string {
  return join(PID_DIR, `crawler-${processId}.batch`);
}

/**
 * 启动 crawler 子进程（detach）。
 *
 * 关键：用 detached: true 让子进程独立于 admin dev server；admin dev server 重启后
 * 子进程继续跑（但 admin 看不到 old process）。
 */
export function startCrawler(opts: SpawnOptions): SpawnResult {
  ensurePidDir();

  const processId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logPath = logFilePath(processId);
  const batchIdPlaceholder = `crawler-batch-${processId}`;

  const args = [
    "-F",
    "crawler",
    "start",
    "--source",
    opts.source,
    ...(opts.limit ? ["--limit", String(opts.limit)] : []),
    ...(opts.since ? ["--since", String(opts.since)] : []),
    ...(opts.until ? ["--until", String(opts.until)] : []),
    ...(opts.fullScan ? ["--full-scan"] : []),
    ...(opts.trustLevel !== undefined ? ["--trust", String(opts.trustLevel)] : []),
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // 让 crawler 把 batch_id 写到固定文件供 spawner 读取
    CRAWLER_BATCH_FILE: batchFilePath(processId),
  };

  const child: ChildProcess = spawn("pnpm", args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
    cwd: process.cwd(),
  });

  // 写 stdio 到 log 文件
  const fs = require("node:fs") as typeof import("node:fs");
  const logFd = fs.openSync(logPath, "w");
  if (child.stdout) child.stdout.pipe(fs.createWriteStream(logPath, { flags: "a" }));
  if (child.stderr) child.stderr.pipe(fs.createWriteStream(logPath, { flags: "a" }));

  // 写 PID 文件
  if (child.pid) {
    writeFileSync(pidFilePath(processId), String(child.pid));
  }

  return {
    process_id: processId,
    pid: child.pid,
    log_path: logPath,
    started_at: Date.now(),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 查询 crawler 子进程状态。
 *
 * @param processId startCrawler 返回的 process_id
 * @param countPending 函数：admin 端调 store.countByBatchId
 */
export function getCrawlerStatus(
  processId: string,
  countPending: (batchId: string) => number,
): CrawlerStatus {
  const pidPath = pidFilePath(processId);
  const logPath = logFilePath(processId);
  const batchPath = batchFilePath(processId);

  let pid: number | undefined;
  let alive = false;
  if (existsSync(pidPath)) {
    pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (!isNaN(pid) && pid > 0) {
      alive = isAlive(pid);
    }
  }

  let pendingCount = 0;
  let batchId: string | undefined;
  if (existsSync(batchPath)) {
    batchId = readFileSync(batchPath, "utf-8").trim();
    pendingCount = countPending(batchId);
  }

  let logTail: string | undefined;
  if (existsSync(logPath)) {
    const content = readFileSync(logPath, "utf-8");
    // 最后 4KB
    logTail = content.slice(-4096);
  }

  return {
    process_id: processId,
    alive,
    ...(pid ? { pid } : {}),
    pending_count: pendingCount,
    started_at: 0,
    ...(logTail ? { log_tail: logTail } : {}),
  };
}

/** Stop crawler 子进程（kill PID）。返回是否成功。 */
export function stopCrawler(processId: string): boolean {
  const pidPath = pidFilePath(processId);
  if (!existsSync(pidPath)) return false;
  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
  if (isNaN(pid) || pid <= 0) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** 清理 PID 文件（admin dev server 重启时可选调用） */
export function cleanupProcess(processId: string): void {
  for (const p of [pidFilePath(processId), logFilePath(processId), batchFilePath(processId)]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // ignore
    }
  }
}