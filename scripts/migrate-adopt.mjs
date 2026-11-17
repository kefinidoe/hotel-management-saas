#!/usr/bin/env node
/**
 * Adopt a database that has no Prisma migration ledger.
 *
 * The deployed SaaS database has no `public._prisma_migrations` table (see
 * docs/saas-migration-rehearsal.md), which means `prisma migrate deploy` would
 * replay migration 1 on top of a populated schema. This tool reconciles that in
 * three gated steps:
 *
 *   1. fingerprint the live schema using the approved checkpoints in
 *      scripts/migration-ledger.mjs;
 *   2. refuse to continue unless exactly one checkpoint matches, the ledger is
 *      absent or internally consistent, and every migration file still matches
 *      the reviewed release manifest;
 *   3. record the migrations whose effects are already present in
 *      `_prisma_migrations` (the same row `prisma migrate resolve --applied`
 *      writes), leaving genuinely missing migrations pending.
 *
 * It does NOT mark anything applied that the schema does not already contain,
 * and it never edits migration files, drops objects or rewrites data.
 *
 * Dry run (default) — prints the plan and the exact official commands:
 *
 *   SAAS_ENVIRONMENT=saas SAAS_DATABASE_IDENTIFIER=<id> \
 *     DIRECT_URL=postgresql://... node scripts/migrate-adopt.mjs
 *
 * Execute — writes the baseline rows in one transaction:
 *
 *   ... node scripts/migrate-adopt.mjs --execute \
 *         --approved-by "owner@example" --confirm-database <database-name>
 *
 * On a machine with the pinned Prisma engines, prefer the official path:
 * run this tool without --execute, then execute the printed
 * `prisma migrate resolve --applied <name>` commands and finally
 * `prisma migrate deploy`. `--execute` exists so the same reconciliation can be
 * rehearsed (and recovered) without Prisma's engine binaries, producing
 * byte-compatible ledger rows.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { assertDatabaseTarget, DatabaseTargetSafetyError } from "./database-target-safety.mjs";
import { sanitiseForPgTools } from "./pg-url.mjs";
import { queryJson, queryScalar, resolvePsql, psqlVersion, runPsql, PsqlError } from "./psql.mjs";
import {
  PRISMA_LEDGER_DDL,
  assertLfMigrationFiles,
  buildAdoptionPlan,
  buildFeatureQuery,
  CHECKPOINTS,
  checkpointPredicateSql,
  evaluateCheckpoints,
  readMigrations,
  readReleaseManifest,
  verifyReleaseManifest,
} from "./migration-ledger.mjs";

const USAGE = `Usage: node scripts/migrate-adopt.mjs [options]

  --execute                     write baseline ledger rows (default: dry run)
  --approved-by <name>          required with --execute; recorded in the ledger logs
  --confirm-database <name>     required with --execute; must equal the connected database
  --apply-pending-with-psql     after baselining, apply remaining migrations with psql
                                (rehearsal path only; production uses prisma migrate deploy)
  --url <connection-string>     defaults to DIRECT_URL, then DATABASE_URL
  --psql <path>                 psql binary (default: PSQL_BIN or psql on PATH)
  --json                        machine-readable output
  --help

Safety environment (enforced by the shared guard):
  SAAS_ENVIRONMENT=saas
  SAAS_DATABASE_IDENTIFIER=<approved identifier>
`;

function parseArgs(argv) {
  const options = {
    execute: false,
    applyPending: false,
    approvedBy: null,
    confirmDatabase: null,
    url: null,
    psql: null,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inlineValue] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value.`);
      return argv[index];
    };
    switch (flag) {
      case "--execute":
        options.execute = true;
        break;
      case "--apply-pending-with-psql":
        options.applyPending = true;
        break;
      case "--approved-by":
        options.approvedBy = takeValue();
        break;
      case "--confirm-database":
        options.confirmDatabase = takeValue();
        break;
      case "--url":
        options.url = takeValue();
        break;
      case "--psql":
        options.psql = takeValue();
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

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function fetchTarget(url, psqlBin) {
  const identity = queryJson({
    url,
    psqlBin,
    sql: `SELECT json_build_object(
        'database', current_database(),
        'serverVersion', current_setting('server_version'),
        'ledgerExists', to_regclass('public."_prisma_migrations"') IS NOT NULL
      )::text;`,
  });
  const features = queryJson({ url, psqlBin, sql: buildFeatureQuery() });
  return { ...identity, features };
}

function fetchLedger(url, psqlBin, ledgerExists) {
  if (!ledgerExists) return [];
  const raw = queryScalar({
    url,
    psqlBin,
    sql: `SELECT coalesce(json_agg(row_to_json(rows))::text, '[]')
          FROM (
            SELECT "migration_name", "checksum", "finished_at", "rolled_back_at",
                   "applied_steps_count", "started_at"
            FROM "_prisma_migrations"
            ORDER BY "started_at", "migration_name"
          ) rows;`,
  });
  return JSON.parse(raw || "[]");
}

function buildBaselineScript({ baseline, migrations, checkpoint, approvedBy }) {
  const byName = new Map(migrations.map((migration) => [migration.name, migration]));
  const values = baseline
    .map((name) => {
      const migration = byName.get(name);
      const logs =
        `baselined by scripts/migrate-adopt.mjs: effects verified present by checkpoint '${checkpoint.id}'; ` +
        `approved by ${approvedBy}; source sha256 ${migration.checksum}`;
      return (
        `  (${quoteLiteral(randomUUID())}, ${quoteLiteral(migration.checksum)}, now(), ${quoteLiteral(migration.name)}, ` +
        `${quoteLiteral(logs)}, NULL, now(), 1)`
      );
    })
    .join(",\n");

  const nameChecks = baseline
    .map(
      (name) =>
        `      IF EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" = ${quoteLiteral(name)}) THEN\n` +
        `        RAISE EXCEPTION 'Migration % was already recorded while baselining; aborting.', ${quoteLiteral(name)};\n` +
        "      END IF;"
    )
    .join("\n");

  return `BEGIN;
SELECT pg_advisory_xact_lock(hashtext('hotel_saas_migration_baseline'));

${PRISMA_LEDGER_DDL};

-- Re-verify the schema inside the write transaction: the target must still be
-- exactly the checkpoint that was detected before the connection was made.
DO $baseline_guard$
BEGIN
  IF NOT (
      ${checkpointPredicateSql(checkpoint)}
  ) THEN
    RAISE EXCEPTION 'Checkpoint % no longer matches the live schema; refusing to baseline.', ${quoteLiteral(checkpoint.id)};
  END IF;
END
$baseline_guard$;

DO $baseline_duplicates$
BEGIN
${nameChecks || "      NULL;"}
END
$baseline_duplicates$;

INSERT INTO "_prisma_migrations"
  ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
VALUES
${values};

COMMIT;
`;
}

function applyPendingMigration({ url, psqlBin, migration, approvedBy }) {
  const sql = fs.readFileSync(migration.sqlPath, "utf8");
  const logs =
    `applied by scripts/migrate-adopt.mjs --apply-pending-with-psql (rehearsal runner); ` +
    `approved by ${approvedBy}; source sha256 ${migration.checksum}`;
  const script = `BEGIN;
${sql}
;
INSERT INTO "_prisma_migrations"
  ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
VALUES
  (${quoteLiteral(randomUUID())}, ${quoteLiteral(migration.checksum)}, now(), ${quoteLiteral(migration.name)}, ` +
    `${quoteLiteral(logs)}, NULL, now(), 1);
COMMIT;
`;
  // Notices are expected on a re-run ("already exists, skipping"); Prisma hides
  // them too. Real errors still abort with ON_ERROR_STOP.
  runPsql({ url, psqlBin, input: script, quiet: true });
}

function printHumanReport(report) {
  const lines = [];
  lines.push("Migration adoption report");
  lines.push("-------------------------");
  lines.push(`Target database      : ${report.target.database}`);
  lines.push(`Server version       : ${report.target.serverVersion}`);
  lines.push(`psql client          : ${report.psqlVersion}`);
  lines.push(`Ledger               : ${report.target.ledgerExists ? `present (${report.ledgerRows} row(s))` : "ABSENT"}`);
  lines.push(`Detected checkpoint  : ${report.plan.checkpoint ? `${report.plan.checkpoint.id} — ${report.plan.checkpoint.label}` : "NONE"}`);

  if (report.plan.problems.length > 0) {
    lines.push("");
    lines.push("BLOCKING PROBLEMS");
    for (const problem of report.plan.problems) lines.push(`  - ${problem}`);
  }

  lines.push("");
  lines.push(`Already recorded     : ${report.alreadyRecorded.length} migration(s)`);
  lines.push(`To be baselined      : ${report.plan.baseline.length} migration(s)`);
  for (const name of report.plan.baseline) lines.push(`  + ${name}`);
  lines.push(`Pending deploy       : ${report.plan.pending.length} migration(s)`);
  for (const name of report.plan.pending) lines.push(`  > ${name}`);

  if (report.plan.problems.length === 0 && !report.mode.startsWith("execute")) {
    lines.push("");
    if (report.plan.baseline.length > 0) {
      lines.push("Official equivalent (requires the pinned Prisma engines):");
      for (const name of report.plan.baseline) lines.push(`  npx prisma migrate resolve --applied ${name}`);
    }
    if (report.plan.pending.length > 0) {
      lines.push("Then deploy the remaining migrations:");
      lines.push("  npx prisma migrate deploy");
    }
    if (report.plan.baseline.length === 0 && report.plan.pending.length === 0) {
      lines.push("Nothing to do: the ledger already matches the deployed schema.");
    }
  }
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

  const migrations = readMigrations();
  // Adoption writes each migration's digest into `_prisma_migrations`. Prisma
  // checksums raw file bytes, so a CRLF working copy would record digests that a
  // later deploy from Git's LF content rejects. Refuse instead of recording them.
  try {
    assertLfMigrationFiles(migrations);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const releaseManifest = readReleaseManifest();
  const manifestCheck = verifyReleaseManifest(migrations, releaseManifest);

  let approvedBy = options.approvedBy;
  if (!approvedBy && process.env.MIGRATION_APPROVED_BY) approvedBy = process.env.MIGRATION_APPROVED_BY;

  if (options.execute) {
    if (!approvedBy) {
      process.stderr.write("--execute requires --approved-by (or MIGRATION_APPROVED_BY) so the ledger records who approved adoption.\n");
      return 2;
    }
    if (!options.confirmDatabase) {
      process.stderr.write("--execute requires --confirm-database <name>.\n");
      return 2;
    }
  }

  const rawUrl = options.url || process.env.DIRECT_URL || process.env.DATABASE_URL;
  let target;
  let url;
  try {
    target = assertDatabaseTarget({
      environment: process.env.SAAS_ENVIRONMENT,
      identifier: process.env.SAAS_DATABASE_IDENTIFIER,
      databaseUrl: rawUrl,
      directUrl: process.env.DIRECT_URL,
    });
    url = sanitiseForPgTools(rawUrl);
  } catch (error) {
    if (error instanceof DatabaseTargetSafetyError) {
      process.stderr.write(`${error.message}\nSet SAAS_ENVIRONMENT=saas, SAAS_DATABASE_IDENTIFIER and DIRECT_URL/DATABASE_URL.\n`);
      return 1;
    }
    throw error;
  }

  // Prisma's own guidance (and PostgreSQL's advisory-lock/session semantics) require a
  // session or direct connection. A transaction-mode pooler (Supabase's :6543) can move
  // statements between backends, so refuse rather than produce a half-applied ledger.
  let urlPort = "";
  try {
    urlPort = new URL(rawUrl).port;
  } catch {
    urlPort = "";
  }
  if (urlPort === "6543") {
    process.stderr.write(
      "The connection string uses port 6543 (transaction pooler). Migration and adoption work needs " +
        "the session/direct connection (port 5432) in DIRECT_URL.\n"
    );
    return 1;
  }

  const psqlBin = resolvePsql(options.psql);
  let psqlClientVersion;
  try {
    psqlClientVersion = psqlVersion(psqlBin);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  let state;
  let ledgerRows;
  try {
    state = fetchTarget(url, psqlBin);
    ledgerRows = fetchLedger(url, psqlBin, state.ledgerExists);
  } catch (error) {
    if (error instanceof PsqlError) {
      process.stderr.write(`Could not read the target database: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const plan = buildAdoptionPlan({ migrations, features: state.features, ledgerRows });
  plan.problems.unshift(...manifestCheck.problems);

  const appliedNames = new Set(
    ledgerRows.filter((row) => row.finished_at !== null && row.rolled_back_at === null).map((row) => row.migration_name)
  );

  const report = {
    mode: options.execute ? "execute" : "dry-run",
    target: { database: state.database, serverVersion: state.serverVersion, ledgerExists: state.ledgerExists },
    psqlVersion: psqlClientVersion,
    ledgerRows: ledgerRows.length,
    alreadyRecorded: [...appliedNames],
    plan,
    execute: { performed: false, applied: [], error: null },
  };

  if (plan.problems.length > 0) {
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${printHumanReport(report)}\n`);
    return 1;
  }

  if (options.execute) {
    if (options.confirmDatabase !== state.database) {
      report.plan.problems.push(
        `--confirm-database '${options.confirmDatabase}' does not match the connected database '${state.database}'.`
      );
      if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(`${printHumanReport(report)}\n`);
      return 1;
    }

    try {
      if (plan.baseline.length > 0) {
        const checkpoint = CHECKPOINTS.find((entry) => entry.id === plan.checkpoint.id);
        if (!checkpoint) throw new Error(`Unknown checkpoint '${plan.checkpoint.id}'.`);
        const script = buildBaselineScript({
          baseline: plan.baseline,
          migrations,
          checkpoint: plan.checkpoint,
          approvedBy,
        });
        runPsql({ url, psqlBin, input: script });
        report.execute.performed = true;
      } else if (!state.ledgerExists) {
        // Nothing to baseline, but a pending deploy still needs the ledger.
        // `prisma migrate deploy` creates this table itself; mirror that so an
        // empty database can be brought up entirely through this tool.
        runPsql({ url, psqlBin, sql: PRISMA_LEDGER_DDL });
        report.execute.performed = true;
      }

      if (options.applyPending) {
        for (const name of plan.pending) {
          const migration = migrations.find((entry) => entry.name === name);
          applyPendingMigration({ url, psqlBin, migration, approvedBy });
          report.execute.applied.push(name);
        }
      }
    } catch (error) {
      report.execute.error = error.message;
      report.plan.problems.push(
        `Execution failed: ${error.message} ` +
          "(the failed step was rolled back; with --apply-pending-with-psql no ledger row is written for it, " +
          "whereas `prisma migrate deploy` would record a failed row that must be resolved with " +
          "`prisma migrate resolve --rolled-back`)"
      );
      if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(`${printHumanReport(report)}\n`);
      return 1;
    }

    const after = fetchLedger(url, psqlBin, true);
    report.ledgerRowsAfter = after.length;

    // Re-read the schema so the report states the post-run truth rather than the
    // plan. If pending migrations were applied, the database must now be current.
    const afterFeatures = queryJson({ url, psqlBin, sql: buildFeatureQuery() });
    const afterCheckpoints = evaluateCheckpoints(afterFeatures);
    report.after = { checkpoints: afterCheckpoints };
    if (options.applyPending && JSON.stringify(afterCheckpoints) !== JSON.stringify(["saas_current"])) {
      report.plan.problems.push(
        `Migrations were applied but the database does not match saas_current (detected: ${
          afterCheckpoints.join(", ") || "none"
        }). Investigate before running the application.`
      );
      if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(`${printHumanReport(report)}\n`);
      return 1;
    }
  }

  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`${printHumanReport(report)}\n`);
    if (report.execute.performed) {
      process.stdout.write(
        `\nBaselined ${plan.baseline.length} migration(s) in one transaction. ` +
          `${plan.pending.length} migration(s) remain pending.\n`
      );
    }
    if (report.execute.applied.length > 0) {
      process.stdout.write(`Applied with psql (rehearsal runner): ${report.execute.applied.join(", ")}\n`);
    }
    if (report.after) {
      process.stdout.write(`Checkpoint after this run: ${report.after.checkpoints.join(", ") || "none"}\n`);
    }
  }
  return 0;
}

process.exitCode = main();
