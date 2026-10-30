#!/usr/bin/env node
/**
 * The three external prerequisites for the production migration, checked in one
 * place, with no guessing.
 *
 * The remaining work is not "more rehearsal": it is three objects that live
 * outside this repository — the owner's archive, the target credentials, and the
 * pinned 5.17.0 engine. Each has a tool that turns it into evidence
 * (`migration:restore-rehearsal`, `migration:target-check`, `migration:verify-pin`),
 * but a reader still has to assemble the picture. This script assembles it, and
 * says exactly what is missing rather than implying that three green steps exist.
 *
 * It reports; it does not perform. Nothing is restored, connected to, or run:
 *   - the archive is only read to hash it;
 *   - credentials are only inspected for presence (add --check-target to run the
 *     read-only target check against them, which is the point at which a
 *     connection happens, and it says so);
 *   - engine files are only hashed.
 *
 * Usage:
 *   node scripts/migration-readiness.mjs [--dump <path>] [--expect-sha256 <hex>]
 *        [--check-target] [--json]
 *
 * Exit codes: 0 all three satisfied, 1 something is missing or wrong, 2 usage.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PINNED_ARTIFACTS, PINNED_ENGINE_COMMIT, sha256File, verifyPinnedArtifact } from "./prisma-engine-pins.mjs";

/** The archive the owner recorded on 2026-10-28 (docs/saas-migration-rehearsal.md §2.2). */
const RECORDED_ARCHIVE = {
  name: "hotel-management-saas-20261028-140823.dump",
  size: 384096,
  sha256: "F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7",
};

const USAGE = `Usage: node scripts/migration-readiness.mjs [options]

Reports whether the three external prerequisites for the production migration are
satisfied. It restores nothing, writes nothing and connects to nothing.

  1. Backup archive      --dump <path> or $BACKUP_ARCHIVE, hashed and compared with
                         the recorded digest (--expect-sha256 to override)
  2. Target credentials  $SAAS_ENVIRONMENT=saas, $SAAS_DATABASE_IDENTIFIER and
                         $DIRECT_URL; with --check-target, runs the read-only
                         target check against them (this is the only step that
                         makes a connection)
  3. Pinned engine       $PRISMA_SCHEMA_ENGINE_BINARY and $PRISMA_QUERY_ENGINE_LIBRARY,
                         hashed against the official 5.17.0 digests

Options:
  --dump <path>          Archive to check (default: $BACKUP_ARCHIVE)
  --expect-sha256 <hex>  Expected digest (default: the recorded
                         F81566E9…24A7 for hotel-management-saas-20261028-140823.dump)
  --check-target         Also run \`migration:target-check\` against the configured
                         target, read-only, when credentials are present
  --json                 Print the report as JSON
  --help, -h             Show this text

Exit codes: 0 all three satisfied, 1 missing or wrong, 2 usage.
`;

function parseArgs(argv) {
  const options = { dump: undefined, expectSha256: undefined, checkTarget: false, json: false, help: false };
  const takeValue = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dump":
        options.dump = takeValue(arg, i++);
        break;
      case "--expect-sha256": {
        const value = takeValue(arg, i++);
        if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("--expect-sha256 must be a 64-character hex digest.");
        options.expectSha256 = value.toLowerCase();
        break;
      }
      case "--check-target":
        options.checkTarget = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option '${arg}'.`);
    }
  }
  return options;
}

function checkArchive(options) {
  const file = options.dump || process.env.BACKUP_ARCHIVE || null;
  const expected = options.expectSha256 || RECORDED_ARCHIVE.sha256.toLowerCase();

  if (!file) {
    return {
      id: "archive",
      status: "MISSING",
      detail: `no archive supplied (--dump or $BACKUP_ARCHIVE); expected ${RECORDED_ARCHIVE.name}, ${RECORDED_ARCHIVE.size} bytes, sha256 ${expected}`,
      next: "Place the archive where this process can read it, then re-run.",
    };
  }
  if (!existsSync(file)) {
    return { id: "archive", status: "MISSING", detail: `no such file: ${file}`, next: "Check the path." };
  }

  const digest = sha256File(file);
  if (digest === expected) {
    return {
      id: "archive",
      status: "PRESENT",
      detail: `${file} (sha256 matches ${expected})`,
      next: "Run `npm run migration:restore-rehearsal` against this exact file.",
    };
  }
  return {
    id: "archive",
    status: "MISMATCH",
    detail: `${file} has sha256 ${digest}, expected ${expected}`,
    next: "Do not restore it: it is not the recorded backup.",
  };
}

function checkCredentials(options) {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  const identifier = process.env.SAAS_DATABASE_IDENTIFIER;
  const environment = process.env.SAAS_ENVIRONMENT;
  const missing = [];
  if (environment !== "saas") missing.push("SAAS_ENVIRONMENT=saas");
  if (!identifier) missing.push("SAAS_DATABASE_IDENTIFIER");
  if (!url) missing.push("DIRECT_URL");

  if (missing.length > 0) {
    return {
      id: "credentials",
      status: "MISSING",
      detail: `not configured: ${missing.join(", ")}`,
      next: "Provide the read-only direct connection string and project identifier; do not commit them.",
    };
  }

  if (!options.checkTarget) {
    return {
      id: "credentials",
      status: "CONFIGURED",
      detail: "SAAS_ENVIRONMENT, SAAS_DATABASE_IDENTIFIER and DIRECT_URL are set (not contacted)",
      next: "Run `npm run migration:target-check`, or re-run this with --check-target.",
    };
  }

  // The one place this script connects. It runs the read-only tool, which has no
  // write path, and reports exactly what that tool said.
  const targetCheck = fileURLToPath(new URL("./target-check.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [targetCheck], { encoding: "utf8", env: process.env });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const checkpoint = output.match(/Detected checkpoint\s*:\s*(\S+)/)?.[1];
  return {
    id: "credentials",
    status: result.status === 0 ? "VERIFIED" : "FAILED",
    detail:
      result.status === 0
        ? `target-check passed${checkpoint ? `; detected checkpoint ${checkpoint}` : ""}`
        : `target-check exited with status ${result.status}: ${output.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`,
    next: result.status === 0 ? "Record the checkpoint and fingerprint from the report." : "Resolve the failure, then re-run.",
  };
}

function checkEngine() {
  const supplied = {
    schemaEngine: process.env.PRISMA_SCHEMA_ENGINE_BINARY || null,
    queryEngineLibrary: process.env.PRISMA_QUERY_ENGINE_LIBRARY || null,
  };
  if (!supplied.schemaEngine && !supplied.queryEngineLibrary) {
    return {
      id: "engine",
      status: "MISSING",
      detail: `no artifacts supplied (PRISMA_SCHEMA_ENGINE_BINARY / PRISMA_QUERY_ENGINE_LIBRARY); pinned commit ${PINNED_ENGINE_COMMIT.slice(0, 12)}…`,
      next: "See docs/migration-strategy.md §7.1.2, then run `npm run migration:verify-pin`.",
    };
  }

  const checks = Object.entries(PINNED_ARTIFACTS)
    .filter(([key]) => supplied[key])
    .map(([key, artifact]) => verifyPinnedArtifact({ path: supplied[key], artifact }));

  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) {
    return {
      id: "engine",
      status: "VERIFIED",
      detail: `both artifacts match the official 5.17.0 digests (commit ${PINNED_ENGINE_COMMIT.slice(0, 12)}…)`,
      next: "Run `npm run migration:verify-pin` for the commit check, then §4.2–4.6 against a restored copy.",
    };
  }
  return {
    id: "engine",
    status: "FAILED",
    detail: failed.map((check) => check.problems.join("; ")).join(" | ").slice(0, 400),
    next: "Do not run these files; obtain the official artifacts.",
  };
}

function printHumanReport(report) {
  const lines = [];
  lines.push("");
  lines.push("Production migration readiness");
  lines.push("------------------------------");
  for (const check of report.prerequisites) {
    lines.push(`${check.id.padEnd(12)}: ${check.status}`);
    lines.push(`  ${check.detail}`);
    lines.push(`  next: ${check.next}`);
  }
  lines.push("");
  lines.push(
    report.ready
      ? "All three prerequisites are satisfied. Task 4 (production approval) is still an owner decision: " +
          "review the evidence, take a fresh backup, and record the approval."
      : "Not ready: at least one prerequisite is missing or wrong. Nothing here substitutes for it."
  );
  return lines.join("\n");
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const prerequisites = [checkArchive(options), checkCredentials(options), checkEngine()];
  const ready = prerequisites.every((check) => ["PRESENT", "VERIFIED"].includes(check.status));

  const report = {
    mode: "readiness",
    prerequisites,
    ready,
    approval: {
      granted: false,
      detail:
        "Production approval is not something this tool can grant or infer. It requires the owner's explicit " +
        "sign-off plus a fresh backup taken immediately before the window.",
    },
  };

  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : printHumanReport(report)}\n`);
  return ready ? 0 : 1;
}

process.exitCode = main();
