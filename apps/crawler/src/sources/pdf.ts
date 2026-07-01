/**
 * PDF → CrawledDocument (Track B)
 *
 * 双模式：
 *   1) URL 模式：fetch 拉 binary → Buffer
 *   2) localPath 模式：fs.readFile 读本地文件 → Buffer
 *   3) file:// URL 自动识别走 localPath
 *
 * 解析策略（与 apps/admin/server/local-parser.ts:85-176 同模式）：
 *   - 首选 mineru 3.2.3 CLI（spawn 子进程，模型走 modelscope 国内可达）
 *   - 失败 fallback pdf-parse@1.1.1（老 pdfjs，扫描版/复杂版质量低但能跑）
 *   - 两个都失败抛 Error
 *
 * 输出 markdown（mineru）或 plain text（pdf-parse）→ 按 \n\n split paragraph 数组
 * - title：URL 末段 / 本地文件名 / fallback URL
 * - platformSpecific 不写（与 webpage 一致）
 *
 * Mock-first：fetchImpl 注入 fake fetch；测试 PDF Buffer 直接传入（绕过 fetch）。
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { CrawledDocument } from "../types.js";

// @ts-expect-error - pdf-parse 无 types
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export interface FetchPdfOptions {
  /** 测试用：注入 fake fetch */
  fetchImpl?: typeof fetch;
  /** User-Agent，默认 "unequal-crawler/0.1 (+https://unequal.xxx.workers.dev)" */
  userAgent?: string;
  /** 本地 PDF 文件绝对路径；如设了则不 fetch 直接 fs.readFile。 */
  localPath?: string;
  /** 是否走 mineru 优先（默认 true，失败 fallback pdf-parse）。 */
  preferMineru?: boolean;
  /** mineru timeout ms（默认 30 分钟，测试环境可设小值） */
  mineruTimeoutMs?: number;
  /** 测试用：注入 fake spawn（默认用 child_process.spawn） */
  spawnImpl?: typeof spawn;
}

const DEFAULT_UA = "unequal-crawler/0.1 (+https://unequal.xxx.workers.dev)";

/**
 * 主入口：URL / 本地路径 / file:// URL → 解析 → CrawledDocument。
 *
 * @throws fetch 404 / 文件不存在 / mineru 全失败 + pdf-parse 也失败
 */
export async function fetchPdf(url: string, opts: FetchPdfOptions = {}): Promise<CrawledDocument> {
  const localPath = resolveLocalPath(url, opts.localPath);
  let buf: Buffer;
  if (localPath) {
    // 模式 1: 本地路径
    try {
      buf = readFileSync(localPath);
    } catch (err) {
      throw new Error(`fetchPdf: failed to read local file ${localPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    // 模式 2: URL fetch
    const f = opts.fetchImpl ?? fetch;
    const userAgent = opts.userAgent ?? DEFAULT_UA;
    const res = await f(url, { headers: { "user-agent": userAgent } });
    if (!res.ok) {
      throw new Error(`fetchPdf: fetch ${url} failed: HTTP ${res.status}`);
    }
    const ab = await res.arrayBuffer();
    buf = Buffer.from(ab);
  }

  // 解析：mineru 优先 + pdf-parse fallback
  const preferMineru = opts.preferMineru !== false;
  const filename = localPath ? basename(localPath) : basenameFromUrl(url);
  const markdown = preferMineru
    ? await parsePdf(buf, filename, opts.spawnImpl ?? spawn, opts.mineruTimeoutMs)
    : await parsePdfFallback(buf, filename);

  // markdown → paragraphs（双换行 split，filter 太短）
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20);

  const totalChars = paragraphs.reduce((sum, p) => sum + p.length, 0);

  return {
    url,
    title: filename.replace(/\.pdf$/i, "") || url,
    paragraphs,
    totalChars,
    fetchedAt: Date.now(),
  };
}

/** 解析本地路径优先级：opts.localPath > file:// URL prefix > undefined（走 fetch） */
function resolveLocalPath(url: string, optLocalPath?: string): string | undefined {
  if (optLocalPath) return optLocalPath;
  if (url.startsWith("file://")) {
    // file:///Users/Mark/foo.pdf → /Users/Mark/foo.pdf
    // 中文/特殊字符 URL encode（如 `file:///Users/Mark/Downloads/pdf/2%E3%80%81...pdf`）→ fs.readFile 需要原始字节
    try {
      return decodeURIComponent(url.slice("file://".length));
    } catch {
      // URL decode fail，fallback 直接 slice
      return url.slice("file://".length);
    }
  }
  return undefined;
}

/** 从 URL 末段拿 filename fallback */
function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const pathname = u.pathname.replace(/\/$/, "");
    if (pathname && pathname !== "/") {
      const last = pathname.split("/").pop() ?? "";
      if (last) return last;
    }
  } catch {
    // URL parse fail；用 url hash
  }
  return "document.pdf";
}

/**
 * mineru 优先 + pdf-parse fallback 解析 Buffer → markdown 文本
 * 与 admin `local-parser.ts:85-176` 同模式
 */
async function parsePdf(
  buf: Buffer,
  filename: string,
  spawnImpl: typeof spawn,
  mineruTimeoutMs: number | undefined,
): Promise<string> {
  try {
    return await parsePdfMineru(buf, filename, spawnImpl, mineruTimeoutMs);
  } catch (mineruErr) {
    const mineruStderr = (mineruErr as Error & { stderr?: string }).stderr;
    console.warn(
      `[pdf-source] mineru failed for ${filename}, falling back to pdf-parse: ${mineruErr instanceof Error ? mineruErr.message : String(mineruErr)}${mineruStderr ? `\nmineru stderr (last 500): ${mineruStderr.slice(-500)}` : ""}`,
    );
    try {
      return await parsePdfFallback(buf, filename);
    } catch (fallbackErr) {
      throw new Error(
        `parsePdf: both mineru and pdf-parse failed: mineru=${mineruErr instanceof Error ? mineruErr.message : String(mineruErr)}; pdf-parse=${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
      );
    }
  }
}

/** mineru 路径（首选）：spawn 子进程解析 PDF → markdown */
async function parsePdfMineru(
  buf: Buffer,
  filename: string,
  spawnImpl: typeof spawn,
  timeoutMsOverride: number | undefined,
): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), "crawler-pdf-"));
  const inputPath = join(tmpDir, filename);
  writeFileSync(inputPath, buf);

  // 默认 30 分钟；测试用 LOCAL_CRAWLER_PDF_TIMEOUT_MS 或 opts.mineruTimeoutMs
  const envTimeout = process.env.LOCAL_CRAWLER_PDF_TIMEOUT_MS;
  const timeoutMs =
    timeoutMsOverride ??
    (envTimeout && !isNaN(Number(envTimeout)) ? Number(envTimeout) : undefined) ??
    30 * 60 * 1000;

  // 模型源：默认 modelscope（国内 GFW 友好）；可由 MINERU_MODEL_SOURCE 覆盖
  const mineruEnv = { ...process.env } as NodeJS.ProcessEnv;
  if (!process.env.MINERU_MODEL_SOURCE) {
    mineruEnv.MINERU_MODEL_SOURCE = "modelscope";
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawnImpl(
        "mineru",
        [
          "-p", inputPath,
          "-o", tmpDir,
          "-m", "auto",
          "-b", "pipeline",       // pipeline backend（不需要 VLM）；hybrid-auto-engine 缺 VLM 模型
          "-l", "ch",
          "-f", "true",
          "-t", "true",
        ],
        { stdio: ["ignore", "pipe", "pipe"], env: mineruEnv },
      );

      let stderr = "";
      child.stderr?.on("data", (d: Buffer | string) => {
        stderr += typeof d === "string" ? d : d.toString();
      });
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        const err = new Error(`mineru parse timeout (>${timeoutMs}ms)`);
        (err as Error & { stderr?: string }).stderr = stderr;
        reject(err);
      }, timeoutMs);

      child.on("close", (code: number | null) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else {
          const err = new Error(`mineru exit code ${code}`);
          (err as Error & { stderr?: string; code?: number | null }).stderr = stderr;
          (err as Error & { stderr?: string; code?: number | null }).code = code;
          reject(err);
        }
      });
      child.on("error", (err: Error) => {
        clearTimeout(timeout);
        reject(new Error(`mineru spawn failed: ${err.message}`, { cause: err }));
      });
    });

    const stem = filename.replace(/\.pdf$/i, "");
    const outputPath = join(tmpDir, stem, "auto", `${stem}.md`);
    let md: string;
    try {
      md = readFileSync(outputPath, "utf-8");
    } catch (err) {
      throw new Error(`mineru output not found at ${outputPath}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!md.trim()) {
      throw new Error("mineru returned empty markdown (PDF 可能是扫描版或损坏)");
    }
    return md;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** pdf-parse fallback（v1 老路径；老 pdfjs 解析） */
async function parsePdfFallback(buf: Buffer, filename: string): Promise<string> {
  const result = await pdfParse(buf);
  const text = result.text ?? "";
  // 防御性 trim 后非空校验（避免扫描版 PDF 仅含换行符假阳性）
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(
      `pdf-parse returned empty text for ${filename} (PDF 可能是扫描版/图片，老 pdfjs 无法 OCR；mineru 可解析但需启动 modelscope 模型下载)`,
    );
  }
  return text;
}