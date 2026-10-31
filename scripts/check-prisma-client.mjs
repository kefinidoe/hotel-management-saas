#!/usr/bin/env node
/**
 * Fail a build (or a dev start) when the generated Prisma Client does not match
 * prisma/schema.prisma.
 *
 * Why this exists: `@prisma/client` is a thin wrapper around whatever
 * `prisma generate` last wrote into `node_modules/.prisma/client`. If that step
 * is skipped — `npm ci --ignore-scripts`, a Docker build without the postinstall
 * hook, a checkout whose dependencies were installed before a migration added a
 * model, or a long-running dev server holding the previous client in memory —
 * the application still starts and every *old* query keeps working. Only the new
 * models are missing, and they fail at request time with
 * `TypeError: Cannot read properties of undefined (reading 'findUnique')`.
 *
 * That is exactly how the Pricing & Rates page crashed: `prisma.hotel` existed,
 * `prisma.hotelPricingSettings` did not. This script turns that class of silent
 * drift into a build failure with the one sentence that fixes it.
 *
 * Checks (all read-only):
 *   1. the generated client exists and is importable;
 *   2. every model in prisma/schema.prisma has a delegate on a freshly
 *      constructed PrismaClient (no database connection is opened);
 *   3. the schema copy embedded in the generated client matches the repository's
 *      schema (whitespace/comments normalised) — i.e. the client is not stale;
 *   4. `prisma` and `@prisma/client` are the same version.
 *
 * Usage:  node scripts/check-prisma-client.mjs [--quiet]
 * Exit:   0 = client matches the schema, 1 = it does not (message says what to do)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUIET = process.argv.includes("--quiet");
// `next start` images often ship the generated client but not the .prisma source
// directory; there the comparison is impossible and the delegate check below is
// all that can be verified.
const ALLOW_MISSING_SCHEMA = process.argv.includes("--allow-missing-schema");

// The two paths are overridable only so the check itself can be tested against
// fixtures (__tests__/schema/prisma-client-check.test.ts). Normal use reads the
// real schema and the real generated client.
const SCHEMA_PATH = process.env.PRISMA_CLIENT_CHECK_SCHEMA
  ? resolve(process.env.PRISMA_CLIENT_CHECK_SCHEMA)
  : join(ROOT, "prisma", "schema.prisma");
const GENERATED_DIR = process.env.PRISMA_CLIENT_CHECK_GENERATED_DIR
  ? resolve(process.env.PRISMA_CLIENT_CHECK_GENERATED_DIR)
  : join(ROOT, "node_modules", ".prisma", "client");
const GENERATED_SCHEMA = join(GENERATED_DIR, "schema.prisma");

function fail(title, details) {
  process.stderr.write(`\n✖ ${title}\n`);
  for (const line of details) process.stderr.write(`  ${line}\n`);
  process.stderr.write("\n");
  process.exit(1);
}

function ok(message) {
  if (!QUIET) process.stdout.write(`✔ ${message}\n`);
}

/** Prisma model names, in declaration order. */
function schemaModels(schema) {
  return [...schema.matchAll(/^\s*model\s+(\w+)\s*\{/gm)].map((match) => match[1]);
}

/** The delegate Prisma derives from a model name: camelCase, keeps the final "s". */
function delegateName(model) {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/**
 * Canonical form of a schema for comparison.
 *
 * `prisma generate` writes a *formatted* copy of the schema next to the client,
 * and `prisma format` reorders field attributes (`@db.Decimal(5,2) @default(0)`
 * becomes `@default(0) @db.Decimal(5,2)`) and realigns columns. None of that is a
 * schema change, so each line is reduced to its sorted tokens and compared as a
 * multiset: a stale client — one generated before a model or field existed —
 * still differs, while formatting does not.
 *
 * The generator block is excluded: verification harnesses regenerate the client
 * with extra preview features (e.g. `driverAdapters` for the WASM engine), which
 * changes nothing about the models the client can serve.
 */
function normalise(schema) {
  const withoutGeneratorBlocks = schema.replace(/generator\s+\w+\s*\{[^}]*\}/g, "");
  const withoutComments = withoutGeneratorBlocks
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const lines = withoutComments
    .split("\n")
    .map((line) => line.split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0)
    .map((tokens) => [...tokens].sort().join(" "))
    .sort();
  return lines.join("\n");
}

if (!existsSync(SCHEMA_PATH)) {
  if (ALLOW_MISSING_SCHEMA) {
    process.stderr.write(`! prisma/schema.prisma not found at ${SCHEMA_PATH}; skipping the schema comparison\n`);
  } else {
    fail("prisma/schema.prisma not found", [`Looked in ${SCHEMA_PATH}`]);
  }
}

const schema = existsSync(SCHEMA_PATH) ? readFileSync(SCHEMA_PATH, "utf8") : null;
const models = schema ? schemaModels(schema) : [];
if (schema && models.length === 0) fail("prisma/schema.prisma declares no models", [`Parsed ${SCHEMA_PATH}`]);

if (!existsSync(GENERATED_DIR)) {
  fail("The generated Prisma Client is missing", [
    `Looked for ${GENERATED_DIR}`,
    "Run:  npx prisma generate",
    "A clean install runs this automatically via the \"postinstall\" script; it is skipped by",
    "`npm ci --ignore-scripts`, some Docker builds and CI caches.",
  ]);
}

// --- 3. is the client stale relative to the repository schema? ---------------
if (schema && existsSync(GENERATED_SCHEMA)) {
  const embedded = readFileSync(GENERATED_SCHEMA, "utf8");
  if (normalise(embedded) !== normalise(schema)) {
    const embeddedModels = new Set(schemaModels(embedded));
    const missing = models.filter((model) => !embeddedModels.has(model));
    fail("The generated Prisma Client was built from a different schema", [
      missing.length > 0
        ? `Models missing from the generated client: ${missing.join(", ")}`
        : "The generated client's schema copy differs from prisma/schema.prisma.",
      "Run:  npx prisma generate",
      "Then restart the application — a running server keeps the previous client in memory.",
    ]);
  }
  ok(`generated client schema matches prisma/schema.prisma (${models.length} models)`);
}

// --- 2. does the client expose every delegate? -------------------------------
let Prisma;
try {
  ({ Prisma } = await import("@prisma/client"));
} catch (error) {
  fail("@prisma/client could not be imported", [String(error && error.message ? error.message : error)]);
}

// Preferred check: the runtime data model the client builds its delegates from.
// It is read from the generated files, so it needs neither a database nor a query
// engine. Constructing a client would load the engine, which a build machine may
// not have.
let clientModels = Prisma?.dmmf?.datamodel?.models?.map((model) => model.name) ?? [];
let checkedVia = "runtime data model";

if (clientModels.length === 0) {
  // Some local verification harnesses replace the client entry point (e.g. to run
  // the WASM engine), which hides Prisma.dmmf. The generated type declarations
  // still list every delegate, so fall back to them instead of a false alarm.
  const declarations = join(GENERATED_DIR, "index.d.ts");
  if (!existsSync(declarations)) {
    fail("@prisma/client exposes no runtime data model and no type declarations", [
      "The generated client is incomplete. Run:  npx prisma generate",
    ]);
  }
  const dts = readFileSync(declarations, "utf8");
  // `get hotelPricingSettings(): Prisma.HotelPricingSettingsDelegate<...>`
  clientModels = [...dts.matchAll(/get \w+\(\): Prisma\.(\w+)Delegate/g)].map((match) => match[1]);
  checkedVia = "generated type declarations";
}

if (clientModels.length === 0) {
  fail("The generated Prisma Client cannot serve the models in prisma/schema.prisma", [
    "No model delegates were found in the generated client.",
    "Run:  npx prisma generate",
  ]);
}

const missingDelegates = models.filter((model) => !clientModels.includes(model));
if (missingDelegates.length > 0) {
  fail("The generated Prisma Client cannot serve every model in the schema", [
    `Missing delegates: ${missingDelegates.map(delegateName).join(", ")}`,
    "Run:  npx prisma generate",
    "This is the failure mode behind \"Cannot read properties of undefined (reading 'findUnique')\".",
  ]);
}
ok(schema ? `client exposes all ${models.length} model delegates (${checkedVia})` : `client exposes ${clientModels.length} model delegates (${checkedVia})`);

// --- 4. are the CLI and the runtime the same version? ------------------------
const readVersion = (name) => {
  try {
    return JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
};
const clientVersion = readVersion("@prisma/client");
const cliVersion = readVersion("prisma");
if (!clientVersion || !cliVersion) {
  fail("Prisma packages are not installed", [
    `@prisma/client: ${clientVersion ?? "missing"}, prisma: ${cliVersion ?? "missing"}`,
    "Run:  npm ci",
  ]);
}
if (clientVersion !== cliVersion) {
  fail("prisma and @prisma/client versions differ", [
    `prisma ${cliVersion} vs @prisma/client ${clientVersion}`,
    "A client generated by a different CLI than the one in use is unsupported. Align them in package.json.",
  ]);
}
ok(`prisma ${cliVersion} and @prisma/client ${clientVersion} match`);

ok("Prisma Client matches prisma/schema.prisma");
