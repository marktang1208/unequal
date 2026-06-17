/**
 * CP-6: Bundle src/index.ts → functions/api-router/（esbuild）
 *
 * tcb CLI 期望结构：functionRoot/{funcName}/{entry.js, package.json}
 * 我们用 functions/api-router/ 作为单入口函数部署目录。
 *
 * 用法：pnpm -F api deploy:build
 * 输出：apps/api/functions/api-router/index.js + package.json
 */
import { build } from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const FUNC_DIR = join(process.cwd(), "functions/api-router");
mkdirSync(FUNC_DIR, { recursive: true });

console.log("[deploy:build] bundling src/index.ts → functions/api-router/...");

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: join(FUNC_DIR, "index.js"),
  external: ["node:*"],
  conditions: ["worker", "node"],
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

const pkgJson = {
  name: "unequal-api-router",
  version: "0.0.1",
  type: "module",
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