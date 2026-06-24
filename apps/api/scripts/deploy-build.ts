/**
 * CP-7-C #5: Bundle src/index.ts → miniprogram cloudfunctions (esbuild)
 *
 * 单一路径：bundle 直接写到 apps/miniprogram/cloudfunctions/api-router/
 * 这样 `tcb fn deploy api-router`（从 PWD 推断）能直接读到最新 bundle，
 * 不需要 `cp` 同步。
 *
 * 前置：appRoot 有 apps/miniprogram/cloudfunctions/（monorepo 布局固定）
 *
 * P6 Phase 4: 同步拷贝 nli-assets/ 到 FUNC_DIR/nli-assets/
 *   - 模型文件 (nli-MiniLM2-L6-H768-quint8_avx2.onnx) 79MB → CloudBase 50MB 上传限制 → 走 COS
 *   - 但本地 fallback (dev/CI) 也支持 → bundle 里也带一份
 *   - onnx-provider.ts 在 dirname(localModelPath) 找 vocab.json / merges.txt / special_tokens_map.json
 *
 * P7 follow-up: 同步 cloudbaserc.json (template + 9 Keychain secrets → minipgm path)
 *   - 改 apps/api/cloudbaserc.json 一处生效, 不再 manual sync
 *   - Keychain secrets 永远最新 (部署时读 Keychain)
 *   - minipgm path cloudbaserc.json 已在 .gitignore (含明文 secrets, 不入库)
 */
import { build } from "esbuild";
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { syncCloudbasrcFromTemplate } from "./deploy/lib/sync-cloudbasrc.js";

const APP_ROOT = join(process.cwd(), "../..");
const FUNC_DIR = join(APP_ROOT, "apps/miniprogram/cloudfunctions/api-router");
mkdirSync(FUNC_DIR, { recursive: true });

// 兼容老路径：apps/api/functions/api-router/ — 删掉避免误用
const OLD_FUNC_DIR = join(process.cwd(), "functions/api-router");
if (existsSync(OLD_FUNC_DIR)) {
  rmSync(OLD_FUNC_DIR, { recursive: true, force: true });
  console.log(`[deploy:build] 🧹 清理老 bundle 路径 ${OLD_FUNC_DIR}`);
}

console.log(`[deploy:build] bundling src/index.ts → ${FUNC_DIR}/index.js`);

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: join(FUNC_DIR, "index.js"),
  external: [
    "node:*",
    // P6 Phase 4.1: onnxruntime-node 含 native .node binary, esbuild 不能 bundle
    // 走 CloudBase installDependency=true 自动 npm install
    "onnxruntime-node",
    // sharp 同理 (CloudBase 安装时再装 platform-specific binary)
    "sharp",
    // pdf-parse / mammoth 内部也 require native 资源
    "pdf-parse",
    "mammoth",
  ],
  conditions: ["worker", "node"],
  minify: false,
  sourcemap: false,
  logLevel: "info",
  plugins: [
    {
      name: "patch-pdf-parse",
      setup(build) {
        build.onLoad({ filter: /pdf-parse[\\/]index\.js$/ }, async (args) => {
          let src = readFileSync(args.path, "utf-8");
          src = src.replace(
            /var isDebugMode = !module2?\.parent\s*;/,
            "var isDebugMode = false; // patched by deploy-build.ts (was: !module2.parent)",
          );
          src = src.replace(
            /let isDebugMode = !module\.parent\s*;/,
            "let isDebugMode = false; // patched by deploy-build.ts (was: !module.parent)",
          );
          return { contents: src, loader: "js" };
        });
      },
    },
  ],
});

const pkgJson = {
  name: "unequal-api-router",
  version: "0.0.1",
  main: "index.js",
  dependencies: {
    "@cloudbase/node-sdk": "^3.18.1",
    "jose": "^4.15.9",
    "mammoth": "^1.12.0",
    "pdf-parse": "1.1.1",
    "ulid": "^3.0.2",
    "zod": "^3.23.0",
    // P6: onnxruntime-node 是 native module, 走 platform-specific binary
    // CloudBase Node 20 runtime 已经是 Linux x64, 由 onnxruntime-node@1.27.0 自动选 binary
    "onnxruntime-node": "^1.27.0",
  },
};
writeFileSync(join(FUNC_DIR, "package.json"), JSON.stringify(pkgJson, null, 2));

console.log(`✅ Bundle built → ${FUNC_DIR}/index.js`);
console.log(`✅ package.json written → ${FUNC_DIR}/package.json`);

// ── P6 Phase 4.1: 同步 nli-assets/ 到 bundle 目录 ───────────────────────
// 模型文件 + tokenizer + config，5 文件 ~80MB
// 注意：CloudBase 50MB 单文件上传限制，所以 prod 走 COS（push.ts 上传）
// 但 dev/CI 走 bundle 路径，OnnxNliProvider 在 dirname(localModelPath) 找 vocab.json
const NLI_ASSETS_SRC = join(process.cwd(), "scripts", "nli-assets");
const NLI_ASSETS_DST = join(FUNC_DIR, "nli-assets");
if (existsSync(NLI_ASSETS_SRC)) {
  rmSync(NLI_ASSETS_DST, { recursive: true, force: true });
  cpSync(NLI_ASSETS_SRC, NLI_ASSETS_DST, { recursive: true });
  console.log(`✅ nli-assets copied → ${NLI_ASSETS_DST}/`);
} else {
  console.warn(`⚠️  scripts/nli-assets/ 不存在,跳过 (跑 pnpm -F api download-nli-model 下载)`);
}

// ── P7 follow-up: 同步 cloudbaserc.json (template + 9 Keychain secrets → minipgm path) ───
// 解决 P6 真接时的 manual sync 问题: 改 apps/api/cloudbaserc.json 一处生效
//   - template: apps/api/cloudbaserc.json (含 14 vars, source of truth)
//   - secrets: 9 Keychain secrets (跟 push.ts SECRETS 一致, 见 lib/sync-cloudbasrc.ts)
//   - target: apps/miniprogram/cloudfunctions/api-router/cloudbaserc.json (已 .gitignore)
const CLOUDBASERC_TEMPLATE = join(process.cwd(), "cloudbaserc.json");
const CLOUDBASERC_TARGET = join(FUNC_DIR, "cloudbaserc.json");
await syncCloudbasrcFromTemplate({
  templatePath: CLOUDBASERC_TEMPLATE,
  targetPath: CLOUDBASERC_TARGET,
});
console.log(`✅ cloudbaserc.json synced → ${CLOUDBASERC_TARGET}`);
