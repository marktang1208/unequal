#!/usr/bin/env tsx
/**
 * scripts/download-nli-model.ts — 一次性下载 NLI 模型到 apps/api/functions/assets/nli/
 *
 * 用法：
 *   pnpm -F api download-nli-model
 *
 * 行为：
 *   - 幂等：文件已存在且 SHA-256 匹配 → 跳过
 *   - 不匹配 → 报错退出（不覆盖，避免破坏部署）
 *   - 不存在 → 下载到目标路径
 *
 * 来源：Hugging Face Xenova/nli-MiniLM-L6-v2
 *  - quantized.onnx: ~90MB
 *  - tokenizer.json: ~3MB
 *
 * spec §9.1 + plan commit 3
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HF_BASE = "https://huggingface.co/Xenova/nli-MiniLM-L6-v2/resolve/main";

// 期望的 SHA-256（首次下载后填充此 hash，下次启动校验完整性）
// 注：实际下载后用 `shasum -a 256` 算填回这里
const EXPECTED_HASHES: Record<string, string | null> = {
  "onnx/model_quantized.onnx": null, // 待首次下载后填入
  "tokenizer.json": null,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TARGET_DIR = join(__dirname, "..", "functions", "assets", "nli");

interface DownloadEntry {
  remotePath: string;
  localName: string;
  expectedHash: string | null;
}

const ENTRIES: DownloadEntry[] = [
  { remotePath: "onnx/model_quantized.onnx", localName: "nli-MiniLM-L6-v2-quantized.onnx", expectedHash: EXPECTED_HASHES["onnx/model_quantized.onnx"] },
  { remotePath: "tokenizer.json", localName: "tokenizer.json", expectedHash: EXPECTED_HASHES["tokenizer.json"] },
];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256OfFile(p: string): Promise<string> {
  const buf = await readFile(p);
  return createHash("sha256").update(buf).digest("hex");
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
}

async function processEntry(entry: DownloadEntry): Promise<void> {
  const dest = join(TARGET_DIR, entry.localName);

  if (await exists(dest)) {
    const actual = await sha256OfFile(dest);
    if (entry.expectedHash && actual !== entry.expectedHash) {
      throw new Error(
        `SHA-256 mismatch for ${entry.localName}:\n` +
        `  expected: ${entry.expectedHash}\n` +
        `  actual:   ${actual}\n` +
        `Refusing to overwrite. Please delete the file manually and re-run.`,
      );
    }
    console.log(`✓ ${entry.localName} (${(await readFile(dest)).length} bytes) — verified`);
    return;
  }

  console.log(`↓ Downloading ${entry.localName}...`);
  const url = `${HF_BASE}/${entry.remotePath}`;
  await downloadFile(url, dest);
  const size = (await readFile(dest)).length;
  console.log(`✓ ${entry.localName} (${(size / 1024 / 1024).toFixed(1)}MB) — downloaded`);

  if (!entry.expectedHash) {
    const actual = await sha256OfFile(dest);
    console.log(`  SHA-256: ${actual}`);
    console.log(`  ↑ Add this to EXPECTED_HASHES in download-nli-model.ts to enable integrity check on next run`);
  }
}

async function main() {
  console.log(`NLI model downloader — target: ${TARGET_DIR}`);
  await mkdir(TARGET_DIR, { recursive: true });

  for (const entry of ENTRIES) {
    await processEntry(entry);
  }

  // 写 README
  const readmePath = join(TARGET_DIR, "README.md");
  if (!(await exists(readmePath))) {
    await writeFile(
      readmePath,
      `# NLI Model Assets\n\n` +
        `Downloaded from Hugging Face: ${HF_BASE}\n\n` +
        `## Files\n\n` +
        `- \`nli-MiniLM-L6-v2-quantized.onnx\` (~90MB) — quantized ONNX model\n` +
        `- \`tokenizer.json\` (~3MB) — WordPiece tokenizer\n\n` +
        `## License\n\n` +
        `Apache 2.0 (inherited from nli-MiniLM-L6-v2 source)\n\n` +
        `## How to download\n\n` +
        `\`\`\`bash\npnpm -F api download-nli-model\n\`\`\`\n\n` +
        `## How to update\n\n` +
        `Delete the existing files and re-run the download script.\n`,
    );
    console.log("✓ README.md");
  }

  console.log("\n✅ Done");
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
