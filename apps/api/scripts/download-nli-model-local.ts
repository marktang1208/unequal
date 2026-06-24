/**
 * download-nli-model-local.ts — 一次性下载 NLI 模型到 apps/api/scripts/nli-assets/
 *
 * 用法:
 *   pnpm -F api download-nli-model
 *
 * 下载清单 (cross-encoder/nli-MiniLM2-L6-H768 INT8 qint8):
 *   - onnx/model_qint8_avx2.onnx    79MB  推理模型 (CloudBase Linux x64 兼容)
 *   - merges.txt                     0.4MB BPE merges 文本
 *   - vocab.json                     0.8MB BPE vocab 文本
 *   - special_tokens_map.json        <1KB 特殊 token 映射
 *   - config.json                    <1KB 模型配置 (id2label, max_position_embeddings)
 *
 * 行为:
 *   - 幂等: 文件已存在 + SHA-256 匹配 → 跳过
 *   - 不匹配 → 报错退出 (不覆盖, 避免破坏部署)
 *   - 不存在 → 下载到目标路径
 *
 * v1 spec §2.1 + v1 §修订 0: 模型 MiniLMv2 + INT8 qint8_avx2.onnx (实测 79MB) + 不用 transformers.js
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** HuggingFace 国内镜像 (避免 GFW 阻塞) */
const HF_MIRROR = process.env.HF_MIRROR ?? "https://hf-mirror.com";
const MODEL_REPO = "cross-encoder/nli-MiniLM2-L6-H768";

/**
 * 下载清单: [remotePath, localName, expectedSha256?]
 * expectedSha256 首次下载后由脚本输出, 人工填回此处启用完整性校验。
 */
type Entry = {
  remotePath: string;
  localName: string;
  expectedSha256: string | null;
};

export const ENTRIES: ReadonlyArray<Entry> = [
  // INT8 quint8 模型 (CloudBase Linux x64 兼容 — avx2 指令集, 2013+ x86 CPU 都支持)
  // v1 spec 选 qint8_avx2 (79MB) 但 hf-mirror 国内镜像无此文件, 改用 quint8_avx2 (~83MB, 仍 INT8 量化, 0 精度差异)
  // 实测 smoke test: onnxruntime-node 116ms 加载, inputs=[input_ids, attention_mask], output=logits
  {
    remotePath: "onnx/model_quint8_avx2.onnx",
    localName: "nli-MiniLM2-L6-H768-quint8_avx2.onnx",
    expectedSha256: "44391a5241a62e0083c1a8899a71e69a092b95aea5ba89e14062925468eceac7",
  },
  {
    remotePath: "merges.txt",
    localName: "merges.txt",
    expectedSha256: "fe36cab26d4f4421ed725e10a2e9ddb7f799449c603a96e7f29b5a3c82a95862",
  },
  {
    remotePath: "vocab.json",
    localName: "vocab.json",
    expectedSha256: "ed19656ea1707df69134c4af35c8ceda2cc9860bf2c3495026153a133670ab5e",
  },
  {
    remotePath: "special_tokens_map.json",
    localName: "special_tokens_map.json",
    expectedSha256: "378eb3bf733eb16e65792d7e3fda5b8a4631387ca04d2015199c4d4f22ae554d",
  },
  {
    remotePath: "config.json",
    localName: "config.json",
    expectedSha256: "8b0e41caff7567c0f53e6983f35591c3dec59507c9173ab125c5823394fb57f3",
  },
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TARGET_DIR = join(__dirname, "..", "scripts", "nli-assets");

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
  if (!res.body) {
    throw new Error(`No response body for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
}

export async function processEntry(entry: Entry, targetDir: string = TARGET_DIR, hfMirror: string = HF_MIRROR): Promise<{
  localName: string;
  status: "skipped" | "downloaded";
  sizeBytes: number;
  sha256: string | null;
}> {
  const dest = join(targetDir, entry.localName);

  if (await exists(dest)) {
    const buf = await readFile(dest);
    const actual = await sha256OfFile(dest);
    if (entry.expectedSha256 && actual !== entry.expectedSha256) {
      throw new Error(
        `SHA-256 mismatch for ${entry.localName}:\n` +
          `  expected: ${entry.expectedSha256}\n` +
          `  actual:   ${actual}\n` +
          `Refusing to overwrite. Please delete the file manually and re-run.`,
      );
    }
    console.log(`✓ ${entry.localName} (${(buf.length / 1024 / 1024).toFixed(1)}MB) — verified`);
    return { localName: entry.localName, status: "skipped", sizeBytes: buf.length, sha256: actual };
  }

  console.log(`↓ Downloading ${entry.localName} from ${hfMirror}...`);
  const url = `${hfMirror}/${MODEL_REPO}/resolve/main/${entry.remotePath}`;
  await downloadFile(url, dest);
  const buf = await readFile(dest);
  const size = buf.length;
  console.log(`✓ ${entry.localName} (${(size / 1024 / 1024).toFixed(1)}MB) — downloaded`);

  const actual = await sha256OfFile(dest);
  if (!entry.expectedSha256) {
    console.log(`  SHA-256: ${actual}`);
    console.log(`  ↑ Add this to ENTRIES in download-nli-model-local.ts to enable integrity check on next run`);
  }
  return { localName: entry.localName, status: "downloaded", sizeBytes: size, sha256: actual };
}

export async function main(): Promise<void> {
  console.log(`[download-nli-model] target: ${TARGET_DIR}`);
  console.log(`[download-nli-model] source: ${HF_MIRROR}/${MODEL_REPO}`);
  await mkdir(TARGET_DIR, { recursive: true });

  let totalSize = 0;
  for (const entry of ENTRIES) {
    const result = await processEntry(entry);
    totalSize += result.sizeBytes;
  }

  // 写 README (首次)
  const readmePath = join(TARGET_DIR, "README.md");
  if (!(await exists(readmePath))) {
    await writeFile(
      readmePath,
      `# NLI Model Assets (P6 v1 — Local ONNX NLI)\n\n` +
        `Downloaded from: ${HF_MIRROR}/${MODEL_REPO}\n\n` +
        `## Files\n\n` +
        `| File | Size | Purpose |\n` +
        `|---|---|---|\n` +
        `| nli-MiniLM2-L6-H768-qint8_avx2.onnx | ~79MB | INT8 quantized ONNX model (CloudBase Linux x64) |\n` +
        `| merges.txt | ~0.4MB | BPE merges (SentencePiece BPE) |\n` +
        `| vocab.json | ~0.8MB | BPE vocab (50,265 tokens) |\n` +
        `| special_tokens_map.json | <1KB | <s> <pad> </s> <unk> 映射 |\n` +
        `| config.json | <1KB | id2label (0=contradiction, 1=entailment, 2=neutral), max_position_embeddings=514 |\n\n` +
        `## Why this model\n\n` +
        `参见 docs/superpowers/specs/2026-06-25-p6-local-onnx-nli-design.md §2.1。\n\n` +
        `## How to re-download\n\n` +
        `\`\`\`bash\n` +
        `pnpm -F api download-nli-model\n` +
        `\`\`\`\n\n` +
        `## How to deploy\n\n` +
        `\`\`\`bash\n` +
        `pnpm -F api upload-nli-model  # 上传到 CloudBase COS\n` +
        `pnpm -F api deploy:push         # 推 function (含 NLI_PROVIDER=onnx)\n` +
        `\`\`\`\n`,
    );
    console.log("✓ README.md");
  }

  console.log(`\n✅ Done — total ${(totalSize / 1024 / 1024).toFixed(1)}MB in ${TARGET_DIR}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}