#!/usr/bin/env node
/**
 * The three external prerequisites for the production migration, checked in one
 * place, and reported with a vocabulary that cannot be misread.
 *
 * The remaining work is not "more rehearsal": it is three objects that live
 * outside this repository — the owner's archive, the target credentials, and the
 * pinned 5.17.0 engine — plus one decision that belongs to the owner. Each has a
 * tool that turns it into evidence (`migration:restore-rehearsal`,
 * `migration:target-check`, `migration:verify-pin`), but a reader still has to
 * assemble the picture. This script assembles it.
 *
 * Every line carries exactly one of four states:
 *
 *   PASS              the thing was directly demonstrated, here, with evidence
 *   BLOCKED           an external input is missing (or not yet exercised), so
 *                     nothing can be demonstrated either way
 *   FAIL              a check ran and did not pass — this is a defect to fix
 *   PENDING APPROVAL  the owner's decision; software cannot grant it
 *
 * A passing test suite never produces PASS here. Only an actual digest match, an
 * actual read-only target check, and an actual verified engine pair do.
 *
 * Usage:
 *   node scripts/migration-readiness.mjs [--dump <path>] [--expect-sha256 <hex>]
 *        [--check-target] [--json]
 *
 * Exit codes: 0 all three prerequisites demonstrated (decision = PENDING APPROVAL),
 * 1 anything BLOCKED or FAIL, 2 usage.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PINNED_ARTIFACTS, PINNED_ENGINE_COMMIT, sha256File, verifyPinnedArtifact } from "./prisma-engine-pins.mjs";

const PASS = "PASS";
const BLOCKED = "BLOCKED";
const FAIL = "FAIL";
const PENDING_APPROVAL = "PENDING APPROVAL";

/** The archive the owner recorded on 2026-10-28 (docs/saas-migration-rehearsal.md §2.2). */
const RECORDED_ARCHIVE = {
  name: "hotel-management-saas-20261028-140823.dump",
  size: 384096,
  sha256: "F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7",
};

const USAGE = `Usage: node scripts/migration-readiness.mjs [options]

Reports — in PASS / BLOCKED / FAIL / PENDING APPROVAL terms — whether the three
external prerequisites for the production migration are satisfied. It restores
nothing, writes nothing and connects to nothing unless --check-target is given.

  1. Backup archive      --dump <path> or $BACKUP_ARCHIVE, hashed and compared with
                         the recorded digest (--expect-sha256 to override)
  2. Target credentials  $SAAS_ENVIRONMENT=saas, $SAAS_DATABASE_IDENTIFIER and
                         $DIRECT_URL; with --check-target, runs the read-only
                         target check against them (the only step that connects)
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

Exit codes: 0 all three demonstrated (decision: PENDING APPROVAL), 1 BLOCKED/FAIL, 2 usage.
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
      status: BLOCKED,
      detail: `no archive supplied (--dump or $BACKUP_ARCHIVE); expected ${RECORDED_ARCHIVE.name}, ${RECORDED_ARCHIVE.size} bytes, sha256 ${expected}`,
      next: "Place the archive where this process can read it, then re-run.",
    };
  }
  if (!existsSync(file)) {
    return { id: "archive", status: BLOCKED, detail: `no such file: ${file}`, next: "Check the path." };
  }

  const digest = sha256File(file);
  if (digest === expected) {
    return {
      id: "archive",
      status: PASS,
      detail: `${file} (sha256 matches ${expected})`,
      next: "Run `npm run migration:restore-rehearsal` against this exact file.",
    };
  }
  return {
    id: "archive",
    status: FAIL,
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
      status: BLOCKED,
      detail: `not configured: ${missing.join(", ")}`,
      next: "Provide the read-only direct connection string and project identifier; do not commit them.",
    };
  }

  if (!options.checkTarget) {
    // Configured is not demonstrated. Saying PASS here would let a typo in the
    // identifier masquerade as a verified target.
    return {
      id: "credentials",
      status: BLOCKED,
      detail: "SAAS_ENVIRONMENT, SAAS_DATABASE_IDENTIFIER and DIRECT_URL are set, but the target has not been contacted",
      next: "Re-run with --check-target (or run `npm run migration:target-check`) to demonstrate it.",
    };
  }

  // The one place this script connects. It runs the read-only tool, which has no
  // write path, and reports exactly what that tool said.
  const targetCheck = fileURLToPath(new URL("./target-check.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [targetCheck], { encoding: "utf8", env: process.env });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const checkpoint = output.match(/Detected checkpoint\s*:\s*(\S+)/)?.[1];
  const ledger = output.match(/Ledger\s*:\s*(.+)/)?.[1]?.trim();
  return {
    id: "credentials",
    status: result.status === 0 ? PASS : FAIL,
    detail:
      result.status === 0
        ? `target-check passed read-only${checkpoint ? `; checkpoint ${checkpoint}` : ""}${ledger ? `; ledger ${ledger}` : ""}`
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
      status: BLOCKED,
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
      status: PASS,
      detail: `supplied artifacts match the official 5.17.0 digests (commit ${PINNED_ENGINE_COMMIT.slice(0, 12)}…)`,
      next: "Run `npm run migration:verify-pin` for the commit check, then §4.2–4.6 against a restored copy.",
    };
  }
  return {
    id: "engine",
    status: FAIL,
    detail: failed.map((check) => check.problems.join("; ")).join(" | ").slice(0, 400),
    next: "Do not run these files; obtain the official artifacts.",
  };
}

function printHumanReport(report) {
  const lines = [];
  lines.push("");
  lines.push("Production migration readiness");
  lines.push("------------------------------");
  for (const entry of [...report.prerequisites, report.approval]) {
    lines.push(`${entry.id.padEnd(12)}: ${entry.status} — ${entry.detail}`);
    if (entry.next) lines.push(`  next: ${entry.next}`);
  }
  lines.push("");
  lines.push(`Decision     : ${report.decision.status} — ${report.decision.detail}`);
  lines.push("");
  lines.push("States: PASS = demonstrated here; BLOCKED = missing external input; FAIL = a check ran and failed;");
  lines.push("        PENDING APPROVAL = the owner's decision, which no tool can make.");
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
  const failed = prerequisites.filter((entry) => entry.status === FAIL);
  const blocked = prerequisites.filter((entry) => entry.status === BLOCKED);

  const decision = failed.length
    ? { status: FAIL, detail: `${failed.length} of ${prerequisites.length} prerequisites failed verification: ${failed.map((entry) => entry.id).join(", ")}` }
    : blocked.length
      ? {
          status: BLOCKED,
          detail: `${blocked.length} of ${prerequisites.length} prerequisites are not demonstrated: ${blocked.map((entry) => entry.id).join(", ")}`,
        }
      : {
          status: PENDING_APPROVAL,
          detail:
            "all three prerequisites are demonstrated. Production approval is still the owner's decision: review the " +
            "evidence, take a fresh backup immediately before the window, and record the approval.",
        };

  const report = {
    mode: "readiness",
    prerequisites,
    approval: {
      id: "approval",
      status: PENDING_APPROVAL,
      detail: "owner sign-off for the deployment window; not inferable from any passing check",
      next: "Review docs/saas-migration-rehearsal.md, then record explicit approval and a fresh backup time.",
    },
    decision,
    readyForApproval: decision.status === PENDING_APPROVAL,
  };

  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : printHumanReport(report)}\n`);
  return report.readyForApproval ? 0 : 1;
}

process.exitCode = main();
