/**
 * CP-6: Bundle src/index.ts → functions/api-router/（esbuild）
 */
import { build } from "esbuild";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FUNC_DIR = join(process.cwd(), "functions/api-router");
mkdirSync(FUNC_DIR, { recursive: true });

console.log("[deploy:build] bundling src/index.ts → functions/api-router/...");

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
