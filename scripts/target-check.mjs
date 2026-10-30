#!/usr/bin/env node
/**
 * Read-only verification of a migration target: which checkpoint the live schema
 * corresponds to, whether the ledger agrees with the release manifest, and a
 * deterministic fingerprint of the application schema.
 *
 * Why this is a separate tool from scripts/migrate-adopt.mjs
 * ---------------------------------------------------------
 * `migrate-adopt` can write (it baselines the ledger). Producing evidence about
 * a production database must not require a tool that is *able* to write to it.
 * This script has no write path at all: there is no --execute here, and every
 * statement is a SELECT issued on a connection whose session default is
 * `default_transaction_read_only = on`, enforced by the server rather than by
 * this script's good intentions. That setting is verified before any report is
 * trusted, so a server or pooler that silently ignores it fails the check
 * instead of quietly accepting writes later.
 *
 * What it reports
 * ---------------
 * - checkpoint: the highest known schema state whose predicate holds on the live
 *   database, using the exact predicates `migrate-adopt --execute` re-verifies
 *   inside its write transaction (scripts/migration-ledger.mjs).
 * - ledger: presence, row count, failed/rolled-back rows, and every applied
 *   checksum compared against prisma/migration-release-manifest.json.
 * - fingerprint: an md5 digest over the public schema's tables, columns,
 *   indexes, constraints and functions. `_prisma_migrations` is excluded, so the
 *   digest describes the application schema only and stays comparable between a
 *   target and a restored copy of it.
 *
 * Safety, in the same spirit as the other maintenance scripts
 * ----------------------------------------------------------
 * The connection string must be bound to an explicitly approved target
 * (SAAS_ENVIRONMENT=saas + SAAS_DATABASE_IDENTIFIER, see
 * scripts/database-target-safety.mjs). `SAAS_ENVIRONMENT=rehearsal` is accepted
 * only for a loopback host, which is how the check itself is rehearsed against a
 * disposable local database. Port 6543 (Supabase transaction pooler) is refused:
 * a pooler can hand consecutive statements to different backends, so session
 * state -- including this script's read-only default -- is not reliable there.
 *
 * Usage: node scripts/target-check.mjs [--url <url>] [--psql <path>]
 *          [--expect-checkpoint <id[,id...]>] [--expect-ledger present|absent]
 *          [--expect-schema-digest <md5>] [--json]
 *
 * Exit codes: 0 checks passed, 1 checks failed or the target could not be read,
 * 2 usage error.
 */
import {
  buildAdoptionPlan,
  buildFeatureQuery,
  evaluateCheckpoints,
  readMigrations,
  readReleaseManifest,
  verifyReleaseManifest,
} from "./migration-ledger.mjs";
import { assertDatabaseTarget, DatabaseTargetSafetyError } from "./database-target-safety.mjs";
import { psqlVersion, queryJson, queryScalar, PsqlError, resolvePsql } from "./psql.mjs";
import { sanitiseForPgTools } from "./pg-url.mjs";

const USAGE = `Usage: node scripts/target-check.mjs [options]

Reports the configured migration target without writing anything: the detected
schema checkpoint, the ledger state against the release manifest, and a
deterministic fingerprint of the application schema.

Options:
  --url <connection-string>      Defaults to DIRECT_URL, then DATABASE_URL.
  --psql <path>                  psql binary (default PSQL_BIN, then psql on PATH).
  --expect-checkpoint <ids>      Comma-separated acceptable checkpoint ids; the
                                 check fails unless the detected one is listed.
  --expect-ledger <state>        'present' or 'absent'.
  --expect-schema-digest <md5>   Fail unless the schema fingerprint matches.
  --json                         Print the report as JSON.
  --help, -h                     Show this text.

Required environment:
  SAAS_ENVIRONMENT=saas          (or 'rehearsal' for a loopback database)
  SAAS_DATABASE_IDENTIFIER=<id>  The approved project/database identifier.

Every statement runs with default_transaction_read_only=on. This tool has no
--execute, no --apply and no DDL/DML path.
`;

// Session-level read-only default. Set through PGOPTIONS so it is part of the
// connection, not something a later statement in this script could undo: the
// server rejects writes with "cannot execute ... in a read-only transaction".
const READ_ONLY_PGOPTIONS = "-c default_transaction_read_only=on";

function parseArgs(argv) {
  const options = {
    url: undefined,
    psql: undefined,
    expectCheckpoint: undefined,
    expectLedger: undefined,
    expectSchemaDigest: undefined,
    json: false,
    help: false,
  };

  const takeValue = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--url":
        options.url = takeValue(arg, i++);
        break;
      case "--psql":
        options.psql = takeValue(arg, i++);
        break;
      case "--expect-checkpoint":
        options.expectCheckpoint = takeValue(arg, i++)
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        break;
      case "--expect-ledger": {
        const value = takeValue(arg, i++);
        if (value !== "present" && value !== "absent") {
          throw new Error("--expect-ledger accepts 'present' or 'absent'.");
        }
        options.expectLedger = value;
        break;
      }
      case "--expect-schema-digest": {
        const value = takeValue(arg, i++);
        if (!/^[0-9a-f]{32}$/i.test(value)) throw new Error("--expect-schema-digest must be an md5 hex digest.");
        options.expectSchemaDigest = value.toLowerCase();
        break;
      }
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

function isLoopback(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * Bind the connection string to an approved target. Production use goes through
 * the shared guard (identical rules to `migrate-adopt`). `rehearsal` exists only
 * so this check can be rehearsed against a disposable local database, and it is
 * limited to loopback hosts so it can never point at a shared server.
 */
function bindTarget(url, environment, identifier) {
  const parsed = new URL(url);
  const host = parsed.hostname;

  if (environment === "rehearsal") {
    if (!isLoopback(host)) {
      throw new DatabaseTargetSafetyError(
        `SAAS_ENVIRONMENT=rehearsal is only accepted for a loopback database; '${host}' is not loopback.`
      );
    }
    return { host, database: parsed.pathname.replace(/^\//, ""), identifierMatched: "rehearsal (loopback)" };
  }

  return assertDatabaseTarget({ environment, identifier, databaseUrl: url });
}

/**
 * Digest over the public schema. `_prisma_migrations` is intentionally excluded:
 * its rows are reported separately, and leaving it out means a target's digest
 * can be compared with a restored copy whose ledger has not been replayed.
 */
function buildFingerprintQuery() {
  return `WITH objs AS (
    SELECT 'table' AS kind, c.relname AS name,
           coalesce((
             SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) ||
                               ':' || a.attnotnull::text, ',' ORDER BY a.attnum)
             FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           ), '') AS detail
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND c.relname !~ '^_prisma'
    UNION ALL
    SELECT 'index', ci.relname, pg_get_indexdef(ci.oid)
      FROM pg_index i
      JOIN pg_class ci ON ci.oid = i.indexrelid
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname !~ '^_prisma'
    UNION ALL
    SELECT 'constraint', co.conname, pg_get_constraintdef(co.oid)
      FROM pg_constraint co
      JOIN pg_class c ON c.oid = co.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname !~ '^_prisma'
    UNION ALL
    SELECT 'function', p.proname, md5(pg_get_functiondef(p.oid))
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
  )
  SELECT json_build_object(
    'digest', md5(coalesce(string_agg(kind || ':' || name || ':' || detail, chr(10) ORDER BY kind, name, detail), '')),
    'tables', count(*) FILTER (WHERE kind = 'table'),
    'indexes', count(*) FILTER (WHERE kind = 'index'),
    'constraints', count(*) FILTER (WHERE kind = 'constraint'),
    'functions', count(*) FILTER (WHERE kind = 'function'),
    'objects', count(*)
  )::text
  FROM objs;`;
}

function fetchIdentity(url, psqlBin) {
  return queryJson({
    url,
    psqlBin,
    sql: `SELECT json_build_object(
        'database', current_database(),
        'serverVersion', current_setting('server_version'),
        'readOnly', current_setting('transaction_read_only'),
        'defaultReadOnly', current_setting('default_transaction_read_only'),
        'ledgerExists', to_regclass('public."_prisma_migrations"') IS NOT NULL,
        'publicTables', (
          SELECT count(*) FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name !~ '^_prisma'
        )
      )::text;`,
  });
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

function compareChecksums(ledgerRows, migrations, manifest) {
  const byName = new Map(migrations.map((migration) => [migration.name, migration]));
  const expected = new Map((manifest?.migrations ?? []).map((entry) => [entry.name, entry.sha256]));
  const mismatched = [];
  const unknown = [];
  for (const row of ledgerRows) {
    if (row.rolled_back_at !== null || row.finished_at === null) continue;
    const migration = byName.get(row.migration_name);
    if (!migration) {
      unknown.push(row.migration_name);
      continue;
    }
    const want = expected.get(row.migration_name) ?? migration.checksum;
    if (want && want !== row.checksum) {
      mismatched.push({ name: row.migration_name, ledger: row.checksum, expected: want });
    }
  }
  return { mismatched, unknown };
}

function printHumanReport(report) {
  const lines = [];
  lines.push("Migration target check (read-only)");
  lines.push("---------------------------------");
  lines.push(`Target database      : ${report.target.database} (host: ${report.target.host})`);
  lines.push(`Server version       : ${report.target.serverVersion}`);
  lines.push(`psql client          : ${report.psqlVersion}`);
  lines.push(`Target binding       : ${report.target.identifierMatched}`);
  lines.push(`Session read-only    : ${report.target.defaultReadOnly} (in transaction: ${report.target.readOnly})`);

  const ledger = report.ledger;
  lines.push(
    `Ledger               : ${
      ledger.exists
        ? `present, ${ledger.rows} row(s), ${ledger.applied} applied, ${ledger.failed} unfinished, ${ledger.rolledBack} rolled back`
        : "ABSENT"
    }`
  );
  lines.push(`Release manifest     : ${report.manifest.ok ? `matches ${report.manifest.files} migration file(s)` : "DOES NOT MATCH"}`);
  for (const problem of report.manifest.problems) lines.push(`  ! ${problem}`);
  if (ledger.exists) {
    lines.push(
      `Applied checksums    : ${ledger.checksumMismatches.length} mismatch(es), ${ledger.unknownMigrations.length} unknown migration(s)`
    );
    for (const entry of ledger.checksumMismatches) lines.push(`  ! ${entry.name} ledger ${entry.ledger} != expected ${entry.expected}`);
    for (const name of ledger.unknownMigrations) lines.push(`  ! ${name} is not in this repository`);
  }

  lines.push(`Schema fingerprint   : ${report.fingerprint.digest}`);
  lines.push(
    `                       ${report.fingerprint.tables} table(s), ${report.fingerprint.indexes} index(es), ` +
      `${report.fingerprint.constraints} constraint(s), ${report.fingerprint.functions} function(s), ` +
      `${report.fingerprint.objects} object(s)`
  );

  const checkpoint = report.checkpoint.detected;
  lines.push(`Detected checkpoint  : ${checkpoint ? `${checkpoint.id} -- ${checkpoint.label}` : "none (schema matches no known checkpoint)"}`);
  lines.push(`Adoption path        : ${report.plan.baseline.length} to baseline, ${report.plan.pending.length} to deploy`);
  for (const problem of report.plan.problems) lines.push(`  ! ${problem}`);

  lines.push("");
  lines.push("Checks");
  for (const check of report.checks) lines.push(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? `: ${check.detail}` : ""}`);

  lines.push("");
  lines.push(
    report.ok
      ? "Result: PASS. No statements were written (every statement was a SELECT on a read-only session)."
      : "Result: FAIL. See the failed checks above."
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

  const rawUrl = options.url || process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!rawUrl) {
    process.stderr.write(
      "No target database configured. Pass --url, or set DIRECT_URL (preferred) or DATABASE_URL.\n" +
        "This tool never guesses a target.\n"
    );
    return 1;
  }

  let target;
  let url;
  try {
    target = bindTarget(rawUrl, process.env.SAAS_ENVIRONMENT, process.env.SAAS_DATABASE_IDENTIFIER);
    url = sanitiseForPgTools(rawUrl);
  } catch (error) {
    if (error instanceof DatabaseTargetSafetyError) {
      process.stderr.write(`${error.message}\nSet SAAS_ENVIRONMENT=saas, SAAS_DATABASE_IDENTIFIER and DIRECT_URL/DATABASE_URL.\n`);
      return 1;
    }
    throw error;
  }

  let urlPort = "";
  try {
    urlPort = new URL(rawUrl).port;
  } catch {
    urlPort = "";
  }
  if (urlPort === "6543") {
    process.stderr.write(
      "The connection string uses port 6543 (transaction pooler). Read it through the session/direct " +
        "connection (port 5432) in DIRECT_URL: a pooler can move statements between backends, so the " +
        "read-only session default is not guaranteed.\n"
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

  // Attach the read-only default before the first connection. Every helper in
  // scripts/psql.mjs inherits process.env, so this applies to all statements.
  process.env.PGOPTIONS = `${process.env.PGOPTIONS ?? ""} ${READ_ONLY_PGOPTIONS}`.trim();

  let identity;
  let ledgerRows;
  let features;
  let fingerprint;
  try {
    identity = fetchIdentity(url, psqlBin);
    ledgerRows = fetchLedger(url, psqlBin, identity.ledgerExists);
    features = queryJson({ url, psqlBin, sql: buildFeatureQuery() });
    fingerprint = queryJson({ url, psqlBin, sql: buildFingerprintQuery() });
  } catch (error) {
    if (error instanceof PsqlError) {
      process.stderr.write(`Could not read the target database (read-only): ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const migrations = readMigrations();
  const manifest = readReleaseManifest();
  const manifestCheck = verifyReleaseManifest(migrations, manifest);
  const matching = evaluateCheckpoints(features);
  const plan = buildAdoptionPlan({ migrations, features, ledgerRows });
  const appliedNames = new Set(
    ledgerRows.filter((row) => row.finished_at !== null && row.rolled_back_at === null).map((row) => row.migration_name)
  );
  const checksums = compareChecksums(ledgerRows, migrations, manifest);

  const checkpoint = plan.checkpoint;
  const checks = [];

  checks.push({
    name: "read-only session enforced by the server",
    ok: identity.defaultReadOnly === "on" && identity.readOnly === "on",
    detail: `default_transaction_read_only=${identity.defaultReadOnly}, transaction_read_only=${identity.readOnly}`,
  });
  checks.push({
    name: "release manifest matches the repository",
    ok: manifestCheck.problems.length === 0,
    detail: `${migrations.length} file(s)`,
  });
  checks.push({
    name: "ledger checksums match the release manifest",
    ok: checksums.mismatched.length === 0 && checksums.unknown.length === 0,
    detail: `${checksums.mismatched.length} mismatch(es), ${checksums.unknown.length} unknown`,
  });
  checks.push({
    name: "ledger has no unfinished migrations",
    ok: ledgerRows.every((row) => row.finished_at !== null || row.rolled_back_at !== null),
    detail: `${ledgerRows.filter((row) => row.finished_at === null).length} unfinished`,
  });
  checks.push({
    name: "schema matches a known checkpoint",
    ok: Boolean(checkpoint),
    detail: checkpoint ? checkpoint.id : "no match",
  });
  if (options.expectCheckpoint) {
    checks.push({
      name: "checkpoint is one of the expected ids",
      ok: Boolean(checkpoint) && options.expectCheckpoint.includes(checkpoint.id),
      detail: `expected ${options.expectCheckpoint.join("|")}, detected ${checkpoint ? checkpoint.id : "none"}`,
    });
  }
  if (options.expectLedger) {
    checks.push({
      name: `ledger is ${options.expectLedger}`,
      ok: identity.ledgerExists === (options.expectLedger === "present"),
      detail: identity.ledgerExists ? "present" : "absent",
    });
  }
  if (options.expectSchemaDigest) {
    checks.push({
      name: "schema fingerprint matches the expected digest",
      ok: fingerprint.digest === options.expectSchemaDigest,
      detail: `${fingerprint.digest} vs ${options.expectSchemaDigest}`,
    });
  }

  const report = {
    mode: "read-only",
    target: {
      host: target.host,
      database: identity.database,
      identifierMatched: target.identifierMatched,
      serverVersion: identity.serverVersion,
      defaultReadOnly: identity.defaultReadOnly,
      readOnly: identity.readOnly,
      publicTables: identity.publicTables,
    },
    psqlVersion: psqlClientVersion,
    ledger: {
      exists: identity.ledgerExists,
      rows: ledgerRows.length,
      applied: appliedNames.size,
      failed: ledgerRows.filter((row) => row.finished_at === null && row.rolled_back_at === null).length,
      rolledBack: ledgerRows.filter((row) => row.rolled_back_at !== null).length,
      checksumMismatches: checksums.mismatched,
      unknownMigrations: checksums.unknown,
    },
    manifest: { ok: manifestCheck.problems.length === 0, files: migrations.length, problems: manifestCheck.problems },
    fingerprint,
    checkpoint: { detected: checkpoint, considered: matching },
    plan: { checkpoint: plan.checkpoint, baseline: plan.baseline, pending: plan.pending, problems: plan.problems },
    checks,
    ok: checks.every((check) => check.ok),
  };

  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : printHumanReport(report)}\n`);
  return report.ok ? 0 : 1;
}

process.exitCode = main();
