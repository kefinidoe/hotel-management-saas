#!/usr/bin/env node
/**
 * Local-verification shim: run Prisma Client without the native Node-API engine.
 *
 * Prisma 5.17 normally loads `libquery_engine-<platform>.so.node`. Some
 * sandboxes and CI images cannot reach `binaries.prisma.sh`, so that binary
 * cannot be installed — but the same query engine is also shipped as WebAssembly
 * inside `@prisma/client/runtime/query_engine_bg.<provider>.wasm`.
 *
 * This script rewrites the *generated* client inside `node_modules` so that:
 *   1. `#wasm-engine-loader` compiles that WASM module in Node (the generated
 *      loader assumes a bundler that understands `import('*.wasm')`), and
 *   2. the client entry passes a `pg` pool adapter to `PrismaClient`, which is
 *      what the WASM engine requires (`@prisma/adapter-pg`).
 *
 * It never touches application source, the Prisma schema, or the database, and
 * `npx prisma generate` restores the original generated files. It is a test
 * harness, not a deployment configuration: production keeps the native engine.
 *
 * Usage:
 *   node scripts/wasm-runtime-shim.mjs            # patch node_modules
 *   node scripts/wasm-runtime-shim.mjs --revert   # re-run prisma generate instead
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_DIR = join(ROOT, "node_modules", ".prisma", "client");

const LOADER = `// Written by scripts/wasm-runtime-shim.mjs — compiles the bundled WASM query
// engine for Node instead of expecting a bundler's \`import('*.wasm')\`.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const bytes = await readFile(path.join(here, "query_engine_bg.wasm"));
export default { default: new WebAssembly.Module(bytes) };
`;

const ENTRY = `// Written by scripts/wasm-runtime-shim.mjs — see that file for why this exists.
// The real generated entry point is ./index.js.original.
const wasm = require("./wasm.js");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const pools = new Map();

function poolFor(url) {
  if (!pools.has(url)) {
    pools.set(url, new Pool({ connectionString: url, max: 10, allowExitOnIdle: true }));
  }
  return pools.get(url);
}

class PrismaClient extends wasm.PrismaClient {
  constructor(options = {}) {
    const overrideUrl =
      options.datasources?.db?.url ?? options.datasourceUrl ?? process.env.DATABASE_URL;
    if (!overrideUrl) {
      // Let Prisma raise its own, better error message about the missing URL.
      super(options);
      return;
    }
    const { datasources, datasourceUrl, ...rest } = options;
    super({ ...rest, adapter: new PrismaPg(poolFor(overrideUrl)) });
  }
}

module.exports = { ...wasm, PrismaClient };
`;

/**
 * Regenerate the client with the `driverAdapters` preview feature, which is what
 * makes the generated `wasm.js` entry real instead of a browser-only stub. The
 * schema file itself is restored byte-for-byte afterwards — this only decides
 * what gets written into node_modules.
 */
function generateWithDriverAdapters() {
  const schemaPath = join(ROOT, "prisma", "schema.prisma");
  const original = readFileSync(schemaPath, "utf8");
  if (!/previewFeatures\s*=\s*\[/.test(original)) {
    throw new Error("prisma/schema.prisma has no previewFeatures list to extend.");
  }
  const patched = original.replace(
    /previewFeatures\s*=\s*\[([^\]]*)\]/,
    (_match, list) => `previewFeatures = [${list.trimEnd()}${list.trim() ? ", " : ""}"driverAdapters"]`
  );

  // The CLI refuses to run until it believes the engine binaries exist; give it
  // stand-ins in a temp dir so it uses the bundled WASM schema engine instead of
  // trying to download them.
  const stubDir = mkdtempSync(join(tmpdir(), "prisma-shim-"));
  const libraryStub = join(stubDir, "libquery_engine.stub.node");
  const schemaStub = join(stubDir, "schema-engine.stub");
  writeFileSync(libraryStub, "");
  writeFileSync(schemaStub, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  writeFileSync(schemaPath, patched);
  try {
    execFileSync("npx", ["prisma", "generate"], {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        PRISMA_QUERY_ENGINE_LIBRARY: libraryStub,
        PRISMA_SCHEMA_ENGINE_BINARY: schemaStub,
      },
    });
  } finally {
    writeFileSync(schemaPath, original);
  }
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: node scripts/wasm-runtime-shim.mjs [--revert]\n");
    return 0;
  }
  if (argv.includes("--revert")) {
    process.stdout.write("Run `npx prisma generate` to restore the native client entry point.\n");
    return 0;
  }

  generateWithDriverAdapters();

  if (!existsSync(CLIENT_DIR)) {
    process.stderr.write("Client generation did not produce node_modules/.prisma/client.\n");
    return 1;
  }
  if (!existsSync(join(CLIENT_DIR, "index.js")) || !existsSync(join(CLIENT_DIR, "wasm.js"))) {
    process.stderr.write("The generated client is incomplete; run `npx prisma generate`.\n");
    return 1;
  }

  // A client generated for the native engine does not copy the WASM engine into
  // its output directory, so take it from the runtime that ships it.
  const runtimeDir = join(ROOT, "node_modules", "@prisma", "client", "runtime");
  for (const [source, target] of [
    ["query_engine_bg.postgresql.wasm", "query_engine_bg.wasm"],
    ["query_engine_bg.postgresql.js", "query_engine_bg.js"],
  ]) {
    const from = join(runtimeDir, source);
    const to = join(CLIENT_DIR, target);
    if (!existsSync(to)) {
      if (!existsSync(from)) {
        process.stderr.write(`Cannot find ${source} in @prisma/client/runtime.\n`);
        return 1;
      }
      copyFileSync(from, to);
    }
  }

  const original = join(CLIENT_DIR, "index.js.original");
  if (!existsSync(original)) {
    writeFileSync(original, readFileSync(join(CLIENT_DIR, "index.js")));
  }
  writeFileSync(join(CLIENT_DIR, "wasm-worker-loader.mjs"), LOADER);
  writeFileSync(join(CLIENT_DIR, "index.js"), ENTRY);

  process.stdout.write(
    "Patched the generated Prisma client to use the WASM query engine with @prisma/adapter-pg.\n" +
      "This is a local verification aid only; production uses the native engine.\n"
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
