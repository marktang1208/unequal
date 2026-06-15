import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFile, mkdir, rm } from "fs/promises";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");
const SRC_ENTRY = resolve(__dirname, "../src/index.ts");

// We build the bundle inside apps/api (a sibling of node_modules) so that
// Miniflare's module loader can resolve externalised bare specifiers like
// "pdf-parse/lib/pdf-parse.js" and "node:buffer" via normal Node module
// resolution. A temp file in /tmp would not have node_modules nearby.
//
// .gitignore'd in the repo; cleaned up in afterAll.
const BUNDLE_DIR = resolve(__dirname, "../.test-bundle");
const BUNDLE_PATH = join(BUNDLE_DIR, "worker.mjs");

/**
 * Split a SQL file into individual statements, respecting single-line
 * (`-- …`) and block (`/* … *\/`) comments plus single/double/backtick
 * quoted strings. Returns non-empty, trimmed, whitespace-flattened
 * statements.
 *
 * This is a small subset of wrangler's `splitSqlIntoStatements` (we don't
 * handle compound `BEGIN…END` statements because none of our migrations use
 * them). The motivation: D1's `exec()` in Miniflare 3.20250718 rejects
 * multi-line statements with "incomplete input: SQLITE_ERROR" — even though
 * the same D1 happily runs the same SQL on Cloudflare. We work around the
 * Miniflare bug by flattening internal whitespace. (No migration string
 * literal in this repo spans newlines, so flattening is safe.)
 */
function splitSqlIntoStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const ch = sql[i];
    // Single-line comment: skip to end of line.
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < len && sql[i] !== "\n") i++;
      buf += " ";
      continue;
    }
    // Block comment: skip to closing */.
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < len && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      buf += " ";
      continue;
    }
    // Quoted string: copy through to matching quote, honoring '' escape.
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      buf += ch;
      i++;
      while (i < len) {
        const c = sql[i];
        buf += c;
        if (c === quote) {
          // SQL doubled-quote escape ('' inside a string literal).
          if (sql[i + 1] === quote) {
            buf += quote;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Statement terminator.
    if (ch === ";") {
      // Collapse runs of whitespace (including newlines) into a single
      // space — D1's exec() in Miniflare refuses multi-line input.
      const flat = buf.replace(/\s+/g, " ").trim();
      if (flat.length > 0) out.push(flat);
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.replace(/\s+/g, " ").trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

// M0+M1 cleanup task: prove the Miniflare-based test infra works end-to-end
// so M2 can build real D1/Vectorize/R2 tests on top.
//
// Scope is intentionally tiny: 3 happy-path tests
//   1. GET /health            — no D1/Vectorize/R2 needed
//   2. POST /seed-user        — D1 roundtrip (default user already inserted by 0002)
//   3. CORS preflight OPTIONS — middleware sanity
//
// Routes that hit the MiniMax embedding API (/upload, /ingest, /search) are
// deliberately NOT exercised here — there is no real API key in tests, and
// mocking the global fetch is M2's job. See feedback_unequal_no_hallucination:
// the embedder is an LLM-coupled boundary that needs its own dedicated
// testing strategy.
//
// Implementation note: Miniflare v3's workerd runtime parses the entrypoint as
// vanilla JavaScript and does not understand TypeScript syntax like
// `import type`. We therefore bundle `src/index.ts` to a single ESM file with
// esbuild at suite-setup time and point Miniflare at the bundle. The build
// uses the platform = "browser" + format = "esm" profile that wrangler
// itself uses for Workers deploys, so behavior matches production.

describe("Worker integration (Miniflare)", () => {
  let mf: Miniflare;

  beforeAll(async () => {
    // Clean any stale bundle from a previous failed run, then ensure the
    // output directory exists.
    await rm(BUNDLE_DIR, { recursive: true, force: true });
    await mkdir(BUNDLE_DIR, { recursive: true });

    // Bundle TS → ESM in one shot. Mark Node built-ins as external so
    // esbuild doesn't try to inline them — the `nodejs_compat` flag below
    // makes workerd resolve `node:*` imports at runtime, matching wrangler's
    // production build behaviour.
    //
    // Routes that hit the Node-only parsers (e.g. /upload → pdf-parse,
    // mammoth) are NOT exercised in this skeleton (see top-of-file note);
    // we only need the bundle to *load*, not to successfully serve /upload.
    // The parser packages are bundled normally; if anything in them fails
    // at module-init time we will see it in the workerd log.
    //
    // esbuild 0.21's `external` is `string[]` only (no regex/function
    // matchers), so we use an `onResolve` plugin. We need to externalise
    // both `node:foo` and the bare-name `foo` aliases (pdf-parse uses the
    // bare names).
    const NODE_BUILTINS = new Set([
      "fs",
      "http",
      "https",
      "url",
      "path",
      "stream",
      "buffer",
      "crypto",
      "zlib",
      "os",
      "util",
      "events",
    ]);
    const externalNodePlugin = {
      name: "external-node-builtins",
      setup(b: import("esbuild").PluginBuild) {
        // We register a single onResolve for the "node:" prefix and a
        // second one for the bare-name builtins (pdf-parse uses these).
        b.onResolve({ filter: /^node:/ }, (args) => ({
          path: args.path,
          external: true,
        }));
        b.onResolve({ filter: /^[a-z]+$/ }, (args) => {
          if (NODE_BUILTINS.has(args.path)) {
            return { path: args.path, external: true };
          }
          return null;
        });
      },
    };

    await build({
      entryPoints: [SRC_ENTRY],
      outfile: BUNDLE_PATH,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      resolveExtensions: [".ts", ".js", ".mjs"],
      plugins: [externalNodePlugin],
      sourcemap: "inline",
      logLevel: "warning",
    });

    // MiniflareOptions typing in v3.20250718 does not expose `vectorize`
    // (the Vectorize plugin is internal/experimental) — the field is
    // accepted at runtime and forwarded as a binding. Cast through `any`
    // so typecheck passes without losing type-safety on the other keys.
    mf = new Miniflare({
      scriptPath: BUNDLE_PATH,
      modules: true,
      compatibilityFlags: ["nodejs_compat"],
      compatibilityDate: "2025-01-01",
      d1Databases: ["DB"],
      d1Persist: false, // in-memory, no disk writes
      vectorize: { VECTORIZE: { dimensions: 1024 } },
      r2Buckets: ["R2"],
      bindings: {
        ADMIN_TOKEN: "test-token",
        MINIMAX_API_KEY: "test-key",
        MINIMAX_BASE_URL: "http://test.invalid",
        ENVIRONMENT: "test",
        ALLOWED_ORIGIN: "*",
      },
    } as unknown as ConstructorParameters<typeof Miniflare>[0]);

    // Apply both migrations so D1 has the schema + dev fixtures.
    // D1's `exec()` chokes on comment-prefixed files (and on multi-statement
    // input in some Miniflare versions), so we split into individual
    // statements ourselves using a SQL-aware splitter that respects
    // single-line (`--`) and block (`/* */`) comments and quoted strings.
    const d1 = await mf.getD1Database("DB");
    const sql1 = await readFile(
      resolve(MIGRATIONS_DIR, "0001_init.sql"),
      "utf-8",
    );
    const sql2 = await readFile(
      resolve(MIGRATIONS_DIR, "0002_dev_seed.sql"),
      "utf-8",
    );
    for (const stmt of [...splitSqlIntoStatements(sql1), ...splitSqlIntoStatements(sql2)]) {
      await d1.exec(stmt);
    }
  });

  afterAll(async () => {
    await mf.dispose();
    await rm(BUNDLE_DIR, { recursive: true, force: true });
  });

  it("GET /health returns ok with environment=test", async () => {
    const res = await mf.dispatchFetch("http://localhost/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; environment: string };
    expect(body.status).toBe("ok");
    expect(body.environment).toBe("test");
  });

  it("POST /seed-user is idempotent when default user already exists", async () => {
    // The 0002_dev_seed migration pre-inserts the default user with id
    // 01H0000000000000000000000, so re-seeding must return created=false.
    const res = await mf.dispatchFetch("http://localhost/seed-user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "01H0000000000000000000000",
        nickname: "default",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; created: boolean };
    expect(body.created).toBe(false);
    expect(body.id).toBe("01H0000000000000000000000");
  });

  it("CORS preflight OPTIONS returns 204 with allow-origin header", async () => {
    const res = await mf.dispatchFetch("http://localhost/upload", {
      method: "OPTIONS",
      headers: {
        Origin: "https://test.example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
    expect(res.headers.get("Access-Control-Allow-Methods") ?? "").toContain(
      "POST",
    );
  });
});
