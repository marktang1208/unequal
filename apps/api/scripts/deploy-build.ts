/**
 * CP-7-C #5: Bundle src/index.ts → miniprogram cloudfunctions (esbuild)
 *
 * 单一路径：bundle 直接写到 apps/miniprogram/cloudfunctions/api-router/
 * 这样 `tcb fn deploy api-router`（从 PWD 推断）能直接读到最新 bundle，
 * 不需要 `cp` 同步。
 *
 * 前置：appRoot 有 apps/miniprogram/cloudfunctions/（monorepo 布局固定）
 */
import { build } from "esbuild";
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

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
  external: ["node:*"],
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
  },
};
writeFileSync(join(FUNC_DIR, "package.json"), JSON.stringify(pkgJson, null, 2));

console.log(`✅ Bundle built → ${FUNC_DIR}/index.js`);
console.log(`✅ package.json written → ${FUNC_DIR}/package.json`);
