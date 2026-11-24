#!/usr/bin/env node
/**
 * Native Prisma engine verification — the production client path.
 *
 * The application normally loads `libquery_engine-<platform>.so.node`, a native
 * Node-API library that Prisma downloads from `binaries.prisma.sh` at install
 * time. Environments that cannot reach that host (this sandbox, some CI images)
 * fall back to a WASM build of the same engine, which is fine for testing the
 * application but is **not** evidence that the production engine works.
 *
 * This script answers one question: *is the native engine present, correct, and
 * able to run real queries against the configured database?* It performs four
 * checks and prints a JSON verdict:
 *
 *   1. artifact   the pinned `libquery_engine.so.node` exists, is non-empty and
 *                 matches the SHA-256 pinned in scripts/prisma-engine-pins.mjs;
 *   2. loadable   the shared object can be dlopen'd by this Node build;
 *   3. client     the generated Prisma client actually runs on the native
 *                 engine (not the WASM one) — detected from the client's
 *                 `engineType`/`getConfig` and a live query;
 *   4. queries    connectivity plus a transactional write/read/rollback against
 *                 the configured database.
 *
 * Usage (on the production-like host, with the real engine installed):
 *
 *   PRISMA_QUERY_ENGINE_LIBRARY=/path/to/libquery_engine-debian-openssl-3.0.x.so.node \
 *   DATABASE_URL=... SAAS_ENVIRONMENT=saas SAAS_DATABASE_IDENTIFIER=... \
 *   node scripts/native-engine-verify.mjs --expect-sha256 <digest> --json
 *
 * Exit 0 = PASS. Exit 1 = FAIL. Exit 2 = BLOCKED (a prerequisite is missing,
 * e.g. the engine artifact was never downloaded) — the distinction matters:
 * BLOCKED is not evidence of success.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeAuditRollback } from "./native-engine-audit-probe.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "package.json"));

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const has = (name) => argv.includes(`--${name}`);

const {
  PINNED_ENGINE_COMMIT,
  PINNED_PLATFORM,
  PINNED_PRISMA_VERSION,
  PINNED_ARTIFACTS,
  verifyPinnedArtifact,
} = await import("./prisma-engine-pins.mjs");

const pinned = PINNED_ARTIFACTS.queryEngineLibrary;
const expectSha256 = arg("expect-sha256", pinned.sha256);

function candidatePaths() {
  const paths = [];
  if (process.env.PRISMA_QUERY_ENGINE_LIBRARY) paths.push(process.env.PRISMA_QUERY_ENGINE_LIBRARY);
  paths.push(
    join(ROOT, "node_modules", "@prisma", "engines", `libquery_engine-${PINNED_PLATFORM}.so.node`),
    join(ROOT, "node_modules", ".prisma", "client", `libquery_engine-${PINNED_PLATFORM}.so.node`),
    join(ROOT, "node_modules", ".prisma", "client", "libquery.so.node")
  );
  return [...new Set(paths)];
}

const checks = [];
function record(id, description, status, detail) {
  checks.push({ id, description, status, detail });
}

// ---------------------------------------------------------------------------
// 1. Artifact: exists, non-empty, pinned digest
// ---------------------------------------------------------------------------
let enginePath = null;
const inspected = [];
for (const candidate of candidatePaths()) {
  if (!existsSync(candidate)) {
    inspected.push({ path: candidate, state: "missing" });
    continue;
  }
  const bytes = statSync(candidate).size;
  const result = verifyPinnedArtifact({ path: candidate, artifact: { ...pinned, sha256: expectSha256 } });
  if (result.ok) {
    enginePath = candidate;
    record("artifact", "native query engine present with the pinned digest", "PASS", {
      path: candidate,
      sha256: result.digest,
      bytes: result.size,
    });
    break;
  }
  // A few bytes where a ~15-45 MB library belongs is a placeholder written when
  // the download was skipped or failed — that is "never installed" (BLOCKED), not
  // "installed something wrong" (FAIL). Only a real-sized file with the wrong
  // digest is a FAIL, because that one could actually be loaded by mistake.
  const placeholder = bytes < 1024;
  inspected.push({ path: candidate, state: placeholder ? "placeholder" : "wrong-digest", bytes, digest: result.digest });
  if (!placeholder) record("artifact", "native query engine present with the pinned digest", "FAIL", result);
}

if (!enginePath) {
  const blocking = inspected.filter((entry) => entry.state !== "wrong-digest");
  record("artifact", "native query engine present with the pinned digest", blocking.length ? "BLOCKED" : "FAIL", {
    searched: inspected,
    expected: {
      platform: PINNED_PLATFORM,
      prismaVersion: PINNED_PRISMA_VERSION,
      engineCommit: PINNED_ENGINE_COMMIT,
      sha256: expectSha256,
    },
    hint:
      "The engine is downloaded by `prisma generate`/`npm ci` from binaries.prisma.sh and is required for the production client. " +
      "Run this script on a host that can reach that host, or set PRISMA_QUERY_ENGINE_LIBRARY to the pinned binary. " +
      "A placeholder file at this path means the download never happened; it must not be used to run the application.",
  });
}

// ---------------------------------------------------------------------------
// 2. Loadable by this Node build
// ---------------------------------------------------------------------------
let queryEngine = null;
if (enginePath) {
  try {
    // The generated client loads the library through Node-API; doing it directly
    // proves the ABI matches this Node major without involving Prisma at all.
    queryEngine = require(enginePath);
    const symbols = Object.keys(queryEngine ?? {});
    record("loadable", "engine shared object loads into this Node runtime", symbols.length ? "PASS" : "FAIL", {
      node: process.version,
      exports: symbols.slice(0, 10),
    });
  } catch (error) {
    record("loadable", "engine shared object loads into this Node runtime", "FAIL", {
      node: process.version,
      error: String(error.message).slice(0, 400),
    });
  }
}

// ---------------------------------------------------------------------------
// 3. The generated client uses the native engine
// ---------------------------------------------------------------------------
let prisma = null;
if (enginePath) {
  try {
    if (process.env.PRISMA_QUERY_ENGINE_LIBRARY === undefined) {
      process.env.PRISMA_QUERY_ENGINE_LIBRARY = enginePath;
    }
    ({ prisma } = await import("../lib/prisma.ts"));
    const config = prisma?._engineConfig ?? {};
    const clientEngineType = config.engineType ?? config.activeProvider;
    const usesLibrary = config.engineType === "library" || String(config.engineType ?? "").includes("library");
    record("client", "the application's Prisma client is bound to the native library engine", usesLibrary ? "PASS" : "FAIL", {
      engineType: clientEngineType ?? "(unknown)",
      note: usesLibrary ? undefined : "A WASM/adapter client cannot be evidence for the native production path.",
    });
  } catch (error) {
    record("client", "the application's Prisma client is bound to the native library engine", "FAIL", {
      error: String(error.message).slice(0, 400),
    });
  }
}

// ---------------------------------------------------------------------------
// 4. Connectivity and real queries
// ---------------------------------------------------------------------------
if (prisma) {
  try {
    const started = Date.now();
    const [{ version }] = await prisma.$queryRaw`SELECT version() AS version`;
    record("connectivity", "connect to PostgreSQL through the native engine", "PASS", {
      server: String(version).split(" ").slice(0, 2).join(" "),
      ms: Date.now() - started,
    });

    const hotels = await prisma.hotel.count();
    record("read", "read application data through the native engine", "PASS", { hotels });

    // Write and roll back: proves the engine can execute a transaction without
    // leaving a row behind in whatever database this points at.
    const probe = `native-engine-probe-${Date.now()}`;
    const rolledBack = await probeAuditRollback(prisma, probe);
    record("write", "execute a write inside a transaction through the native engine", rolledBack ? "PASS" : "FAIL", {
      rolledBack,
    });
  } catch (error) {
    record("queries", "connectivity and queries through the native engine", "FAIL", {
      error: String(error.message).slice(0, 400),
    });
  } finally {
    await prisma?.$disconnect?.().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
const statuses = checks.map((check) => check.status);
const verdict = statuses.includes("FAIL") ? "FAIL" : statuses.includes("BLOCKED") ? "BLOCKED" : "PASS";
const document = {
  mode: "native-engine-verify",
  evaluatedAt: new Date().toISOString(),
  node: process.version,
  platform: PINNED_PLATFORM,
  prismaVersion: PINNED_PRISMA_VERSION,
  engineCommit: PINNED_ENGINE_COMMIT,
  verdict,
  checks,
};

if (has("json")) {
  process.stdout.write(JSON.stringify(document, null, 2) + "\n");
} else {
  console.log(`Native Prisma engine verification (${PINNED_PLATFORM}, Prisma ${PINNED_PRISMA_VERSION})`);
  console.log(`Node ${process.version}`);
  for (const check of checks) {
    console.log(`  ${check.status.padEnd(8)} ${check.id} — ${check.description}`);
    if (check.status !== "PASS") console.log(`           ${JSON.stringify(check.detail)}`);
  }
  console.log(`\nResult: ${verdict}`);
}

process.exitCode = verdict === "PASS" ? 0 : verdict === "BLOCKED" ? 2 : 1;
