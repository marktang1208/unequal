/**
 * CP-7-C: LocalParser — 5 类文件 → markdown
 *
 * 入口：parseAuto(tmpData, ext, filename) → Promise<markdown>
 *
 * 5 类：
 *   - pdf:  spawn mineru CLI（首选；失败 fallback 到 pdf-parse）
 *   - docx: mammoth.extractRawText（输出文本 + 简单 markdown 包装）
 *   - html: cheerio 提取 main + readability-style 模板
 *   - txt:  utf-8 直接读
 *   - md:   utf-8 原样
 *
 * 错误分类（spec §5.1）：
 *   - ParseFailedError: PDF 损坏 / docx 加密 / mineru + pdf-parse 都失败
 *   - UnsupportedExtError: 未知扩展名
 *
 * mineru 集成策略：spawn 调本地 mineru CLI（hybrid-auto-engine / pipeline backend），
 *   失败时 fallback 到 pdf-parse@1.1.1（v1 老路径；老 pdfjs 解析率低但能跑）。
 *   pdf-parse 也失败才抛 ParseFailedError（retryable=false）。
 */

import mammoth from "mammoth";
import * as cheerio from "cheerio";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error - pdf-parse 无 types
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export type SupportedExt = "pdf" | "docx" | "html" | "txt" | "md";

export class ParseFailedError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ParseFailedError";
  }
}

export class UnsupportedExtError extends Error {
  constructor(public readonly ext: string) {
    super(`Unsupported file extension: ${ext}`);
    this.name = "UnsupportedExtError";
  }
}

/** 检测 ext（大小写不敏感；带点 / 不带点都行） */
export function detectExt(filename: string): SupportedExt | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "md";
  return null;
}

export class LocalParser {
  /** 主入口：tmpData (Buffer) + ext + filename → markdown 文本 */
  async parseAuto(tmpData: Buffer, ext: string, filename: string): Promise<string> {
    const normalizedExt = (ext ?? "").toLowerCase() as SupportedExt;
    if (!isSupportedExt(normalizedExt)) {
      throw new UnsupportedExtError(normalizedExt);
    }
    switch (normalizedExt) {
      case "pdf": return await this.parsePdf(tmpData, filename);
      case "docx": return await this.parseDocx(tmpData);
      case "html": return await this.parseHtml(tmpData);
      case "txt": return this.parseText(tmpData);
      case "md": return this.parseMd(tmpData);
    }
  }

  /** PDF → markdown：try mineru first, fallback pdf-parse on failure
   * mineru 3.2.3 CLI：
   *   mineru -p <input> -o <output_dir> [-m auto] [-b hybrid-auto-engine]
   *   默认输出 markdown（-f 是 --formula boolean）
   * 输出结构：<output_dir>/<input_stem>/auto/<input_stem>.md
   *
   * Fallback：mineru 失败（缺模型 / GFW / spawn fail）→ pdf-parse@1.1.1
   *   pdf-parse 老 pdfjs 解析率低但能跑（牺牲质量换可用性）
   */
  private async parsePdf(buf: Buffer, filename: string): Promise<string> {
    try {
      return await this.parsePdfMineru(buf, filename);
    } catch (mineruErr) {
      console.warn(`[LocalParser] mineru failed for ${filename}, falling back to pdf-parse: ${(mineruErr as Error).message}`);
      try {
        return await this.parsePdfFallback(buf, filename);
      } catch (fallbackErr) {
        // 两个都失败 → 抛 ParseFailedError
        throw new ParseFailedError(
          `Both mineru and pdf-parse failed: mineru=${(mineruErr as Error).message}; pdf-parse=${(fallbackErr as Error).message}`,
          { cause: fallbackErr },
        );
      }
    }
  }

  /** mineru 路径（首选） */
  private async parsePdfMineru(buf: Buffer, filename: string): Promise<string> {
    const tmpDir = mkdtempSync(join(tmpdir(), "local-parser-pdf-"));
    const inputPath = join(tmpDir, filename);
    writeFileSync(inputPath, buf);

    // 默认 30 分钟；测试环境用 LOCAL_PARSER_MINERU_TIMEOUT_MS=10000 快速 fail 让 fallback 跑
    const timeoutMs = Number(process.env.LOCAL_PARSER_MINERU_TIMEOUT_MS) || 30 * 60 * 1000;
    // 模型源：默认 huggingface（中国网络 GFW）；国内用 modelscope 走魔搭镜像
    //   MINERU_MODEL_SOURCE=modelscope 已在 mineru CLI 3.2.3 支持
    const mineruEnv: NodeJS.ProcessEnv = { ...process.env };
    if (process.env.MINERU_MODEL_SOURCE) {
      mineruEnv.MINERU_MODEL_SOURCE = process.env.MINERU_MODEL_SOURCE;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("mineru", [
          "-p", inputPath,
          "-o", tmpDir,
          "-m", "auto",
          "-b", "hybrid-auto-engine",
          "-l", "ch",
          "-f", "true",
          "-t", "true",
        ], { stdio: ["ignore", "pipe", "pipe"], env: mineruEnv });

        let stderr = "";
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        const timeout = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new ParseFailedError(`mineru parse timeout (>${timeoutMs}ms)`, { stderr }));
        }, timeoutMs);

        child.on("close", (code) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(new ParseFailedError(`mineru exit code ${code}`, { stderr, code }));
        });
        child.on("error", (err) => {
          clearTimeout(timeout);
          reject(new ParseFailedError(`mineru spawn failed: ${err.message}`, { cause: err }));
        });
      });

      const stem = filename.replace(/\.pdf$/i, "");
      const outputPath = join(tmpDir, stem, "auto", `${stem}.md`);
      let md: string;
      try {
        md = readFileSync(outputPath, "utf-8");
      } catch (err) {
        throw new ParseFailedError(`mineru output not found at ${outputPath}`, { cause: err });
      }
      if (!md.trim()) {
        throw new ParseFailedError("mineru returned empty markdown (PDF 可能是扫描版或损坏)");
      }
      return md;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** pdf-parse fallback（v1 老路径；老 pdfjs 解析） */
  private async parsePdfFallback(buf: Buffer, filename: string): Promise<string> {
    const result = await pdfParse(buf);
    const text = result.text ?? "";
    if (!text.trim()) {
      throw new ParseFailedError(`pdf-parse returned empty text for ${filename}`);
    }
    return text;
  }

  /** docx → markdown：mammoth 提取文本 + 简单标题包装 */
  private async parseDocx(buf: Buffer): Promise<string> {
    try {
      const result = await mammoth.extractRawText({ buffer: buf });
      const text = result.value ?? "";
      if (!text.trim()) {
        throw new ParseFailedError("docx is empty or unreadable");
      }
      // mammoth extractRawText 输出纯文本，包装成 markdown
      return text;
    } catch (err) {
      if (err instanceof ParseFailedError) throw err;
      throw new ParseFailedError(`docx parse failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  /** html → markdown：cheerio 提取正文 + 简单 md 转换
   * v1 简单策略：<h1>→# <h2>→## ... <p>→段落 <li>→- 列表
   * 不依赖 readability 算法（避免重量级）
   */
  private async parseHtml(buf: Buffer): Promise<string> {
    try {
      const html = buf.toString("utf-8");
      const $ = cheerio.load(html);

      // 移除 script/style/nav/footer
      $("script, style, nav, footer, header nav").remove();

      // 提取正文（main > article > body fallback）
      const root = $("main").first().length ? $("main").first() :
                   $("article").first().length ? $("article").first() :
                   $("body").length ? $("body") : $("html");
      const lines: string[] = [];
      root.find("h1, h2, h3, h4, h5, h6, p, ul, ol, blockquote, pre").each((_, el) => {
        const tag = el.tagName.toLowerCase();
        const text = $(el).text().trim();
        if (!text) return;
        if (tag === "h1") lines.push(`# ${text}`);
        else if (tag === "h2") lines.push(`## ${text}`);
        else if (tag === "h3") lines.push(`### ${text}`);
        else if (tag === "h4") lines.push(`#### ${text}`);
        else if (tag === "h5") lines.push(`##### ${text}`);
        else if (tag === "h6") lines.push(`###### ${text}`);
        else if (tag === "p") lines.push(text);
        else if (tag === "ul" || tag === "ol") {
          $(el).find("li").each((__, li) => {
            const liText = $(li).text().trim();
            if (liText) lines.push(`- ${liText}`);
          });
        } else if (tag === "blockquote") lines.push(`> ${text}`);
        else if (tag === "pre") lines.push("```\n" + text + "\n```");
      });
      return lines.join("\n\n");
    } catch (err) {
      throw new ParseFailedError(`html parse failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  /** txt: utf-8 直接读 */
  private parseText(buf: Buffer): string {
    const text = buf.toString("utf-8");
    if (!text.trim()) throw new ParseFailedError("txt file is empty");
    return text;
  }

  /** md: 原样 */
  private parseMd(buf: Buffer): string {
    const text = buf.toString("utf-8");
    if (!text.trim()) throw new ParseFailedError("md file is empty");
    return text;
  }
}

function isSupportedExt(ext: string): ext is SupportedExt {
  return ["pdf", "docx", "html", "txt", "md"].includes(ext);
}
